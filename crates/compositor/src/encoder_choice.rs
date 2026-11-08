//! Which encoder an export is allowed to use, and what it actually used.
//!
//! Both directions of the same question live here because they are per-thread state on purpose:
//! an export runs start-to-finish on one worker thread (the napi `AsyncTask` thread), so a
//! thread-local is exactly the right scope — two exports in the same process cannot see each
//! other's choice or each other's result, and neither needs a signature change through the
//! three platform pipelines.
//!
//! The report is not a nicety: "the settings say NVIDIA" and "this file was encoded by
//! h264_nvenc on the RTX 4070" are different claims, and only the second one is worth showing
//! to a user. Everything that can fall back (Auto) has to say what it fell back FROM.

use std::cell::{Cell, RefCell};

/// What the user asked for. `Auto` is the historical behaviour and the default everywhere.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EncoderChoice {
    /// Try the vendor encoders in the pipeline's own order; fall back to software if none opens.
    #[default]
    Auto,
    /// Only this GPU vendor's encoder may be used (PCI vendor id: 0x10DE NVIDIA, 0x1002 AMD,
    /// 0x8086 Intel). **No fallback**: a manual choice that cannot open must fail loudly rather
    /// than quietly encode somewhere else.
    Vendor(u32),
    /// Software encoding only, whatever GPU is composing.
    Cpu,
}

impl EncoderChoice {
    /// The vendor of an encoder's name, for filtering `EncoderChoice::Vendor`.
    ///
    /// A name-to-vendor table rather than a flag on each candidate: the candidate list is a
    /// plain list of ffmpeg names and stays readable, and adding a candidate cannot forget to
    /// declare its vendor — `vendor_of` returning `None` for a hardware-looking name is caught
    /// by a test.
    pub fn vendor_of(encoder: &str) -> Option<u32> {
        if encoder.ends_with("_nvenc") {
            Some(0x10DE)
        } else if encoder.ends_with("_amf") {
            Some(0x1002)
        } else if encoder.ends_with("_qsv") {
            Some(0x8086)
        } else {
            None
        }
    }

    pub fn is_software(encoder: &str) -> bool {
        Self::vendor_of(encoder).is_none()
    }

    /// Encoders that are unambiguously software because they carry their own implementation.
    ///
    /// `*_mf` is deliberately NOT in this set even though no vendor owns it: MediaFoundation
    /// resolves to whatever MFT is installed, and on a machine with hardware encoders that is a
    /// hardware MFT. "CPU (software encoding)" must not mean "maybe the GPU" — measured on the
    /// test machine, where the CPU setting ran `h264_mf` and produced a larger, faster file than
    /// the AMF path, which is not what a software encode looks like.
    pub fn is_explicit_software(encoder: &str) -> bool {
        encoder.starts_with("lib")
    }
}

/// What actually happened, recorded by the pipeline and read back by the caller.
#[derive(Clone, Debug, Default)]
pub struct EncoderReport {
    /// ffmpeg encoder that opened, e.g. `h264_nvenc`.
    pub encoder: String,
    /// True when the composed D3D11 textures went to the encoder without a system-memory hop.
    pub zero_copy: bool,
    /// Vendors that were refused before one opened, in order, with why.
    pub refused: Vec<String>,
    /// Set when `Auto` had to use a software encoder after hardware candidates failed.
    pub fallback: Option<String>,
}

thread_local! {
    static CHOICE: Cell<EncoderChoice> = const { Cell::new(EncoderChoice::Auto) };
    static REPORT: RefCell<Option<EncoderReport>> = const { RefCell::new(None) };
}

/// Set by the exporter before it starts; applies to this thread's export only.
pub fn set_choice(choice: EncoderChoice) {
    CHOICE.with(|slot| slot.set(choice));
}

/// The choice for the export running on this thread. Cleared by `take_report`, so a later
/// export on the same (reused) worker thread cannot inherit a stale one — see `reset`.
pub fn choice() -> EncoderChoice {
    CHOICE.with(|slot| slot.get())
}

/// Record the outcome of `VideoEncoder::open`. Called by the pipeline, read by the exporter.
pub(crate) fn record(report: EncoderReport) {
    REPORT.with(|slot| *slot.borrow_mut() = Some(report));
}

/// Take the report for the export that just finished, if one was recorded.
pub fn take_report() -> Option<EncoderReport> {
    let report = REPORT.with(|slot| slot.borrow_mut().take());
    reset();
    report
}

/// Back to the defaults. Called by `take_report` and directly by callers that abort an export
/// before it reaches the encoder (a cancelled or failed-open export must not leave a choice
/// behind for the next one on that thread).
pub fn reset() {
    CHOICE.with(|slot| slot.set(EncoderChoice::Auto));
    REPORT.with(|slot| *slot.borrow_mut() = None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_hardware_candidate_maps_to_a_vendor() {
        for name in ["h264_nvenc", "hevc_nvenc", "av1_nvenc"] {
            assert_eq!(EncoderChoice::vendor_of(name), Some(0x10DE), "{name}");
        }
        for name in ["h264_amf", "hevc_amf", "av1_amf"] {
            assert_eq!(EncoderChoice::vendor_of(name), Some(0x1002), "{name}");
        }
        for name in ["h264_qsv", "hevc_qsv", "av1_qsv"] {
            assert_eq!(EncoderChoice::vendor_of(name), Some(0x8086), "{name}");
        }
        for name in ["libopenh264", "libkvazaar", "h264_mf", "hevc_mf"] {
            assert!(EncoderChoice::is_software(name), "{name}");
        }
        // The two sets differ exactly on the wildcard, and that difference is the CPU promise.
        for name in ["libopenh264", "libkvazaar"] {
            assert!(EncoderChoice::is_explicit_software(name), "{name}");
        }
        for name in ["h264_mf", "hevc_mf", "h264_nvenc"] {
            assert!(!EncoderChoice::is_explicit_software(name), "{name}");
        }
    }

    #[test]
    fn a_report_is_per_thread_and_does_not_outlive_the_take() {
        set_choice(EncoderChoice::Cpu);
        assert_eq!(choice(), EncoderChoice::Cpu);
        record(EncoderReport { encoder: "libopenh264".into(), ..Default::default() });
        assert_eq!(take_report().unwrap().encoder, "libopenh264");
        // Taken once: the next export on this thread starts from Auto, not from the last run.
        assert!(take_report().is_none());
        assert_eq!(choice(), EncoderChoice::Auto);
    }

    #[test]
    fn another_thread_has_its_own_choice() {
        set_choice(EncoderChoice::Vendor(0x10DE));
        let other = std::thread::spawn(|| (choice(), take_report().is_none())).join().unwrap();
        assert_eq!(other.0, EncoderChoice::Auto);
        assert!(other.1);
        assert_eq!(choice(), EncoderChoice::Vendor(0x10DE));
    }
}
