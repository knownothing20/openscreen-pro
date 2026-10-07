// CTC acoustic model (wav2vec2 fine-tuned for CTC) run on ggml, for the word
// aligner's second pass. The helper only computes the per-frame log-probs; the
// forced alignment of whisper's words over them lives on the Node side
// (electron/stt/ctcAlign.ts). See transcription-and-captions.md § Word-level alignment.
#pragma once

#include <memory>
#include <string>
#include <vector>

struct CtcModel;

struct CtcModelInfo {
	std::vector<std::string> vocab;      // token id -> text; "|" is the word delimiter
	std::vector<std::string> languages;  // what the model was fine-tuned on
	int blank = 0;
	int stride = 320;                    // samples per output frame (20 ms at 16 kHz)
	int receptive_field = 400;           // samples the first frame sees
};

struct CtcModelDeleter { void operator()(CtcModel* m) const; };
using CtcModelPtr = std::unique_ptr<CtcModel, CtcModelDeleter>;

// Loads a GGUF written by scripts/convert-wav2vec2-gguf.mjs. On the GPU when
// `use_gpu` and a GPU device is registered, else on the CPU. Null + `err` on failure.
CtcModelPtr ctc_load(const std::string& path, bool use_gpu, int threads, std::string& err);

const CtcModelInfo& ctc_info(const CtcModel& model);

// Name of the device the weights live on ("Vulkan0", "MTL0", "CPU").
std::string ctc_device(const CtcModel& model);

// Log-softmax emissions for 16 kHz mono `pcm`: `frames` rows of vocab-size
// floats. Frame i sees samples [i * stride, i * stride + receptive_field).
// Long inputs run in overlapping windows, so memory stays bounded.
bool ctc_emissions(CtcModel& model, const float* pcm, size_t n, std::vector<float>& out,
                   int& frames, std::string& err);
