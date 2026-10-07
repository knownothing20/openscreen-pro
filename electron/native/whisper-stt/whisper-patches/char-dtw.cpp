// OpenScreen (issue #948): character-level teacher-forced DTW.
//
// Spliced into whisper.cpp v1.9.1 by ../CMakeLists.txt in place of everything
// from `struct median_filter_user_data` to the end of
// whisper_exp_compute_token_level_timestamps_dtw. Same signature, same output:
// a `t_dtw` on every text token of the window, in centiseconds.
//
// Upstream teacher-forces the decoded BPE tokens once more and runs DTW on the
// cross-attention of the alignment heads. This does the same with the text cut
// into single characters ("Whisper Has an Internal Word Aligner",
// arXiv 2509.09987): one decoder row per character, so a word boundary is
// where the path reaches the row that predicts the space or the letter after
// it, not wherever a multi-letter token happens to start. On the word-timing
// harness (tools/stt-eval/word-timing) it takes the inner-boundary median from
// 31 to 16 ms.
//
// t_dtw keeps its upstream meaning: the time the path enters the row that
// predicts whatever follows the token, i.e. the END of the token.
//
// Departures from upstream, all measured on the harness:
// - the attention of the heads is averaged and each audio frame's column is
//   scaled to unit L2 norm, as in the paper. Upstream's z-score + median filter
//   does worse on characters (+7 ms median);
// - French drops one silent final consonant per word before aligning (vais,
//   vous, plaît): its row otherwise eats the start of the next word, +60 to
//   +140 ms on the words after it;
// - the decoder has n_text_ctx positions. A window too long as characters is
//   aligned in several runs: one stretch of it as characters, the rest of the
//   window around it as BPE tokens;
// - runs never step back in time: each t_dtw is at least the previous one.
static void whisper_exp_compute_token_level_timestamps_dtw(
            struct whisper_context * ctx,
              struct whisper_state * state,
        struct whisper_full_params   params,
                               int   i_segment,
                            size_t   n_segments,
                               int   seek,
                               int   n_frames,
                               int   /*medfilt_width*/,
                               int   n_threads)
{
    const int n_audio_ctx = state->exp_n_audio_ctx > 0 ? state->exp_n_audio_ctx : ctx->model.hparams.n_audio_ctx;
    WHISPER_ASSERT(n_frames <= n_audio_ctx * 2);
    WHISPER_ASSERT(ctx->params.dtw_aheads_preset != WHISPER_AHEADS_NONE);

    const whisper_token eot = whisper_token_eot(ctx);
    const auto & vocab = ctx->vocab;

    std::vector<whisper_token_data *> text;
    for (size_t i = i_segment; i < i_segment + n_segments; ++i) {
        for (auto & t : state->result_all[i].tokens) {
            if (t.id < eot) {
                text.push_back(&t);
            }
        }
    }
    if (text.empty()) {
        return;
    }

    std::vector<whisper_token> sot_seq = { whisper_token_sot(ctx) };
    if (whisper_is_multilingual(ctx)) {
        const int lang_id = whisper_lang_id(params.language);
        state->lang_id = lang_id;
        sot_seq.push_back(whisper_token_lang(ctx, lang_id));
    }
    sot_seq.push_back(whisper_token_not(ctx));

    // Each text token as one token per character. A character with no token of
    // its own goes as its bytes; a token that cannot be split stays whole.
    const auto find_id = [&](const std::string & s, whisper_token & id) {
        const auto it = vocab.token_to_id.find(s);
        if (it == vocab.token_to_id.end()) return false;
        id = it->second;
        return true;
    };
    std::vector<std::vector<whisper_token>> chars(text.size());
    for (size_t k = 0; k < text.size(); ++k) {
        const std::string & s = vocab.id_to_token.at(text[k]->id);
        std::vector<whisper_token> out;
        bool ok = true;
        for (size_t i = 0; ok && i < s.size();) {
            const unsigned char c = s[i];
            const size_t len = std::min<size_t>(c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 1, s.size() - i);
            const std::string piece = s.substr(i, len);
            i += len;
            whisper_token id;
            if (find_id(piece, id)) {
                out.push_back(id);
                continue;
            }
            for (size_t b = 0; ok && b < piece.size(); ++b) {
                ok = find_id(piece.substr(b, 1), id);
                if (ok) out.push_back(id);
            }
        }
        chars[k] = ok ? std::move(out) : std::vector<whisper_token>{ text[k]->id };
    }

    if (state->lang_id == whisper_lang_id("fr")) {
        // One silent final consonant per word of two letters or more. A word is a
        // run of letters, across tokens; a byte >= 0x80 counts as a letter.
        const auto ch = [&](whisper_token id) {
            const std::string & s = vocab.id_to_token.at(id);
            return s.size() == 1 ? (unsigned char) s[0] : (unsigned char) 0x80;
        };
        std::vector<std::pair<size_t, size_t>> word; // (token, character)
        const auto end_word = [&]() {
            if (word.size() >= 2 && strchr("stxdz", tolower(ch(chars[word.back().first][word.back().second]))) != nullptr) {
                chars[word.back().first][word.back().second] = -1;
            }
            word.clear();
        };
        for (size_t k = 0; k < chars.size(); ++k) {
            for (size_t i = 0; i < chars[k].size(); ++i) {
                const unsigned char c = ch(chars[k][i]);
                if (c >= 0x80 || isalpha(c)) {
                    word.push_back({ k, i });
                } else {
                    end_word();
                }
            }
        }
        end_word();
        for (auto & cs : chars) {
            cs.erase(std::remove(cs.begin(), cs.end(), -1), cs.end());
        }
    }

    struct ggml_init_params gparams = {
        /*.mem_size   =*/ ctx->params.dtw_mem_size,
        /*.mem_buffer =*/ NULL,
        /*.no_alloc   =*/ false,
    };

    int64_t t_floor = 0;
    for (int i = i_segment - 1; i >= 0 && t_floor == 0; --i) {
        for (const auto & t : state->result_all[i].tokens) {
            if (t.id < eot && t.t_dtw > t_floor) t_floor = t.t_dtw;
        }
    }

    const int n_ctx  = ctx->model.hparams.n_text_ctx;
    const int n_text = (int) text.size();
    for (int k0 = 0; k0 < n_text;) {
        // Tokens [k0, k1) as characters, as many as fit.
        int len = (int) sot_seq.size() + n_text + 1;
        int k1 = k0;
        while (k1 < n_text && len - 1 + (int) chars[k1].size() <= n_ctx) {
            len += (int) chars[k1].size() - 1;
            ++k1;
        }
        if (k1 == k0) {
            chars[k0] = { text[k0]->id };
            continue;
        }

        std::vector<whisper_token> tokens = sot_seq;
        std::vector<int> first(n_text + 1); // each text token's first row after `not`
        for (int k = 0; k < n_text; ++k) {
            first[k] = (int) (tokens.size() - sot_seq.size());
            if (k >= k0 && k < k1) {
                tokens.insert(tokens.end(), chars[k].begin(), chars[k].end());
            } else {
                tokens.push_back(text[k]->id);
            }
        }
        first[n_text] = (int) (tokens.size() - sot_seq.size());
        tokens.push_back(eot);

        whisper_kv_cache_clear(state->kv_self);
        whisper_batch_prep_legacy(state->batch, tokens.data(), tokens.size(), 0, 0);
        whisper_kv_cache_seq_rm(state->kv_self, 0, 0, -1);
        if (!whisper_decode_internal(*ctx, *state, state->batch, n_threads, true, nullptr, nullptr)) {
            WHISPER_LOG_INFO("DECODER FAILED\n");
            WHISPER_ASSERT(0);
        }
        const ggml_tensor * qk = state->aheads_cross_QKs;
        WHISPER_ASSERT(qk != nullptr && qk->type == GGML_TYPE_F32 && ggml_is_contiguous(qk));
        const int64_t n_tok  = qk->ne[0];
        const int64_t n_actx = qk->ne[1];
        const int64_t n_head = qk->ne[2];
        const int64_t F      = n_frames / 2; // 20 ms per frame
        WHISPER_ASSERT(F <= n_actx);
        auto & data = state->aheads_cross_QKs_data;
        data.resize(n_tok * n_actx * n_head);
        ggml_backend_tensor_get(qk, data.data(), 0, sizeof(float) * data.size());

        // Rows: `not`, then every token after it but eot. Row r predicts the
        // token after it, so entering row r is where that token starts.
        const int64_t row0 = (int64_t) sot_seq.size() - 1;
        const int64_t R    = (int64_t) tokens.size() - 1 - row0;

        struct ggml_context * gctx = ggml_init(gparams);
        ggml_tensor * x = ggml_new_tensor_2d(gctx, GGML_TYPE_F32, R, F);
        float * xd = (float *) x->data;
        for (int64_t f = 0; f < F; ++f) {
            double norm = 0.0;
            for (int64_t r = 0; r < R; ++r) {
                float a = 0.0f;
                for (int64_t h = 0; h < n_head; ++h) {
                    a += data[(row0 + r) + f * n_tok + h * n_tok * n_actx];
                }
                xd[r + f * R] = a;
                norm += (double) a * a;
            }
            norm = std::sqrt(norm) + 1e-9;
            for (int64_t r = 0; r < R; ++r) {
                xd[r + f * R] = (float) (-xd[r + f * R] / norm);
            }
        }

        const ggml_tensor * path = dtw_and_backtrace(gctx, x);
        std::vector<int32_t> entry(R, 0);
        for (int64_t i = path->ne[1] - 1; i >= 0; --i) {
            const int32_t r = whisper_get_i32_nd(path, 0, i, 0, 0);
            if (r >= 0 && r < R) entry[r] = whisper_get_i32_nd(path, 1, i, 0, 0);
        }
        ggml_free(gctx);

        for (int k = k0; k < k1; ++k) {
            t_floor = std::max(t_floor, (int64_t) entry[first[k + 1]] * 2 + seek);
            text[k]->t_dtw = t_floor;
        }
        k0 = k1;
    }
}
