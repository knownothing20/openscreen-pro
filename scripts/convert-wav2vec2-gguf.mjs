// Converts a HuggingFace Wav2Vec2ForCTC checkpoint (model.safetensors +
// config.json + vocab.json) into the GGUF file whisper-stt-server's CTC aligner
// loads (electron/native/whisper-stt/src/ctc_aligner.cpp).
//
// Usage:
//   node scripts/convert-wav2vec2-gguf.mjs <model.safetensors> <config.json> <vocab.json> \
//        <out.gguf> --languages en[,xx] [--type q8_0|f16]
//
// Node stdlib only. What it writes, and why:
//   - Linear weights (attention, feed-forward, projection, lm_head) as Q8_0, the
//     rest of the matrices as F16, norms and biases as F32. Q8_0 is what keeps the
//     French large model under the 350 MB download budget (issue #948). The
//     convolutions must stay F16: the helper multiplies them with F16 columns.
//   - Sources, as pinned in electron/stt/modelManager.ts (CTC_ALIGNERS[].source):
//       en: https://huggingface.co/facebook/wav2vec2-base-960h (model.safetensors)
//       fr: https://huggingface.co/jonatasgrosman/wav2vec2-large-xlsr-53-french,
//           model.safetensors from its refs/pr/2 (main only has pytorch_model.bin)
//     with the config.json and vocab.json of the same revision.
//   - The positional convolution's weight norm is folded (weight = g * v / |v|),
//     so the helper never sees `weight_g` / `weight_v`.
//   - Tensor names lose the `wav2vec2.` prefix; `masked_spec_embed` is dropped.
//   - The config and the vocabulary go in as `w2v.*` metadata.
// The output is byte-for-byte deterministic for a given input, so its SHA-256 can
// be pinned in electron/stt/modelManager.ts.
import fs from "node:fs";

const [stPath, configPath, vocabPath, outPath, ...rest] = process.argv.slice(2);
if (!outPath) {
	console.error(
		"usage: node convert-wav2vec2-gguf.mjs <model.safetensors> <config.json> <vocab.json> <out.gguf> --languages en [--type q8_0|f16]",
	);
	process.exit(2);
}
const flag = (name, dflt) => {
	const i = rest.indexOf(name);
	return i >= 0 ? rest[i + 1] : dflt;
};
const linearType = flag("--type", "q8_0");
const languages = flag("--languages", "").split(",").filter(Boolean);
if (!languages.length) throw new Error("--languages is required (e.g. --languages en)");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const vocabMap = JSON.parse(fs.readFileSync(vocabPath, "utf8"));
const vocab = [];
for (const [tok, id] of Object.entries(vocabMap)) vocab[id] = tok;
if (vocab.length !== config.vocab_size || vocab.includes(undefined))
	throw new Error(`vocab.json has ${vocab.length} ids, config says ${config.vocab_size}`);

// ---- safetensors ----
const fd = fs.openSync(stPath);
const lenBuf = Buffer.alloc(8);
fs.readSync(fd, lenBuf, 0, 8, 0);
const headerLen = Number(lenBuf.readBigUInt64LE());
const headerBuf = Buffer.alloc(headerLen);
fs.readSync(fd, headerBuf, 0, headerLen, 8);
const header = JSON.parse(headerBuf.toString("utf8"));
delete header.__metadata__;
const readF32 = (name) => {
	const t = header[name];
	if (!t) throw new Error(`missing tensor ${name}`);
	if (t.dtype !== "F32") throw new Error(`${name}: expected F32, got ${t.dtype}`);
	const [b, e] = t.data_offsets;
	const buf = Buffer.alloc(e - b);
	fs.readSync(fd, buf, 0, e - b, 8 + headerLen + b);
	return { shape: t.shape, data: new Float32Array(buf.buffer, buf.byteOffset, (e - b) / 4) };
};

// ---- f16 / q8_0 ----
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(v) {
	f32[0] = v;
	const x = u32[0];
	const sign = (x >>> 16) & 0x8000;
	let exp = ((x >>> 23) & 0xff) - 127 + 15;
	let mant = x & 0x7fffff;
	if (exp >= 31) return sign | 0x7c00; // overflow -> inf (never for these weights)
	if (exp <= 0) {
		if (exp < -10) return sign;
		mant |= 0x800000;
		const shift = 14 - exp;
		let h = mant >> shift;
		if ((mant >> (shift - 1)) & 1 && (mant & ((1 << (shift - 1)) - 1) || h & 1)) h++;
		return sign | h;
	}
	let h = sign | (exp << 10) | (mant >> 13);
	// round to nearest even
	if (mant & 0x1000 && (mant & 0xfff || h & 1)) h++;
	return h;
}
function encodeF16(data) {
	const out = Buffer.alloc(data.length * 2);
	for (let i = 0; i < data.length; i++) out.writeUInt16LE(toHalf(data[i]), i * 2);
	return out;
}
// ggml block_q8_0: f16 scale + 32 int8, scale = amax / 127 (ggml's quantize_row_q8_0_ref).
function encodeQ8_0(data) {
	if (data.length % 32) throw new Error("q8_0 needs a multiple of 32 elements");
	const nb = data.length / 32;
	const out = Buffer.alloc(nb * 34);
	for (let b = 0; b < nb; b++) {
		let amax = 0;
		for (let i = 0; i < 32; i++) amax = Math.max(amax, Math.abs(data[b * 32 + i]));
		const d = amax / 127;
		const id = d ? 1 / d : 0;
		out.writeUInt16LE(toHalf(d), b * 34);
		for (let i = 0; i < 32; i++) out.writeInt8(Math.round(data[b * 32 + i] * id), b * 34 + 2 + i);
	}
	return out;
}

const GGML = { f32: 0, f16: 1, q8_0: 8 };
const tensors = []; // { name, ne (ggml order), type, bytes }
function add(name, shape, data, type) {
	const ne = [...shape].reverse();
	if (type === "q8_0" && ne[0] % 32) type = "f16";
	const bytes =
		type === "f32"
			? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
			: type === "f16"
				? encodeF16(data)
				: encodeQ8_0(data);
	tensors.push({ name, ne, type: GGML[type], bytes });
}

const isLinear = (n) =>
	/(attention\.(q|k|v|out)_proj|feed_forward\.(intermediate|output)_dense|feature_projection\.projection|lm_head)\.weight$/.test(
		n,
	);
for (const name of Object.keys(header).sort()) {
	if (name.endsWith("masked_spec_embed") || name.includes("pos_conv_embed.conv.weight_")) continue;
	const { shape, data } = readF32(name);
	const short = name.replace(/^wav2vec2\./, "");
	if (shape.length === 1) add(short, shape, data, "f32");
	else add(short, shape, data, isLinear(name) ? linearType : "f16");
}

// Weight norm with dim=2: one norm per kernel tap k, over (out, in/groups).
{
	const g = readF32("wav2vec2.encoder.pos_conv_embed.conv.weight_g").data;
	const v = readF32("wav2vec2.encoder.pos_conv_embed.conv.weight_v");
	const [O, I, K] = v.shape;
	const w = new Float32Array(v.data.length);
	for (let k = 0; k < K; k++) {
		let s = 0;
		for (let o = 0; o < O; o++) for (let i = 0; i < I; i++) s += v.data[(o * I + i) * K + k] ** 2;
		const scale = g[k] / Math.sqrt(s);
		for (let o = 0; o < O; o++)
			for (let i = 0; i < I; i++) w[(o * I + i) * K + k] = v.data[(o * I + i) * K + k] * scale;
	}
	add("encoder.pos_conv_embed.conv.weight", v.shape, w, "f16");
}

// ---- GGUF v3 ----
const chunks = [];
const u32b = (v) => {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(v);
	return b;
};
const u64b = (v) => {
	const b = Buffer.alloc(8);
	b.writeBigUInt64LE(BigInt(v));
	return b;
};
const strb = (s) => {
	const b = Buffer.from(s, "utf8");
	return Buffer.concat([u64b(b.length), b]);
};
const T = { u32: 4, i32: 5, f32: 6, bool: 7, string: 8, array: 9 };
const kvs = [];
const kv = (key, type, value) => kvs.push({ key, type, value });
kv("general.architecture", "string", "wav2vec2");
kv("general.alignment", "u32", 32);
kv("w2v.languages", "array:string", languages);
kv("w2v.vocab", "array:string", vocab);
kv("w2v.blank_id", "u32", config.pad_token_id ?? 0);
kv("w2v.word_delimiter", "string", "|");
kv("w2v.hidden_size", "u32", config.hidden_size);
kv("w2v.intermediate_size", "u32", config.intermediate_size);
kv("w2v.num_hidden_layers", "u32", config.num_hidden_layers);
kv("w2v.num_attention_heads", "u32", config.num_attention_heads);
kv("w2v.layer_norm_eps", "f32", config.layer_norm_eps);
kv("w2v.conv_kernel", "array:u32", config.conv_kernel);
kv("w2v.conv_stride", "array:u32", config.conv_stride);
kv("w2v.conv_bias", "bool", !!config.conv_bias);
kv("w2v.feat_extract_norm", "string", config.feat_extract_norm);
kv("w2v.stable_layer_norm", "bool", !!config.do_stable_layer_norm);
kv("w2v.num_conv_pos_embeddings", "u32", config.num_conv_pos_embeddings);
kv("w2v.num_conv_pos_embedding_groups", "u32", config.num_conv_pos_embedding_groups);

chunks.push(Buffer.from("GGUF"), u32b(3), u64b(tensors.length), u64b(kvs.length));
for (const { key, type, value } of kvs) {
	chunks.push(strb(key));
	if (type.startsWith("array:")) {
		const et = type.slice(6);
		chunks.push(u32b(T.array), u32b(T[et]), u64b(value.length));
		for (const v of value) chunks.push(et === "string" ? strb(v) : u32b(v));
		continue;
	}
	chunks.push(u32b(T[type]));
	if (type === "string") chunks.push(strb(value));
	else if (type === "u32") chunks.push(u32b(value));
	else if (type === "bool") chunks.push(Buffer.from([value ? 1 : 0]));
	else if (type === "f32") {
		const b = Buffer.alloc(4);
		b.writeFloatLE(value);
		chunks.push(b);
	}
}
const ALIGN = 32;
const pad = (n) => (ALIGN - (n % ALIGN)) % ALIGN;
let offset = 0;
for (const t of tensors) {
	chunks.push(strb(t.name), u32b(t.ne.length));
	for (const d of t.ne) chunks.push(u64b(d));
	chunks.push(u32b(t.type), u64b(offset));
	offset += t.bytes.length + pad(t.bytes.length);
}
let headLen = chunks.reduce((s, c) => s + c.length, 0);
chunks.push(Buffer.alloc(pad(headLen)));
for (const t of tensors) chunks.push(t.bytes, Buffer.alloc(pad(t.bytes.length)));
fs.writeFileSync(outPath, Buffer.concat(chunks));
headLen = fs.statSync(outPath).size;
console.log(`${outPath}: ${tensors.length} tensors, ${(headLen / 1e6).toFixed(1)} MB`);
