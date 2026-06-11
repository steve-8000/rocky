//! Speech capability gate for the Rust daemon.
//!
//! This is a *capability gate*, NOT a silent no-op. The TS daemon exposes a
//! per-feature readiness descriptor (see
//! `core/packages/server/src/server/speech/speech-runtime.ts`:
//! `SpeechReadinessState { enabled, available, reasonCode, message,
//! retryable, missingModelIds }`). The WebUI renders an explicit unsupported
//! state from that descriptor.
//!
//! The Rust daemon does not (yet) host the local STT/TTS/turn-detection
//! services, so [`speech_capabilities`] reports `dictation` and `voiceMode`
//! as `available = false` with explicit, non-empty reason strings. This makes
//! the WebUI show a clear "unsupported" state instead of a silent failure.
//! When the Rust daemon gains real speech providers, this gate should be
//! replaced by a runtime-derived snapshot (mirroring `buildDictationReadiness`
//! / `buildRealtimeVoiceReadiness`), not by flipping the flags blindly.

use serde::{Deserialize, Serialize};

/// Reason code for a speech feature's readiness. Mirrors the subset of TS
/// `SpeechReadinessReasonCode` the Rust daemon currently emits. `Unsupported`
/// is the Rust-daemon-specific code indicating the feature is not implemented
/// by this runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechReasonCode {
    Ready,
    Disabled,
    Unsupported,
}

/// Readiness descriptor for one speech feature. Field names match the TS
/// `SpeechReadinessState` JSON shape the WebUI consumes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFeatureState {
    pub enabled: bool,
    pub available: bool,
    pub reason_code: SpeechReasonCode,
    pub message: String,
    pub retryable: bool,
}

/// Capability descriptor returned to the WebUI. `dictation` and `voice_mode`
/// mirror the `dictation` / `realtimeVoice` readiness blocks in the TS
/// snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCapabilities {
    pub dictation: SpeechFeatureState,
    pub voice_mode: SpeechFeatureState,
}

/// Returns the speech capability gate for the Rust daemon.
///
/// Both features are reported unavailable with explicit reasons because the
/// Rust daemon does not host local speech providers. This is a deliberate
/// capability gate: the WebUI renders a clear unsupported state rather than a
/// silent no-op.
pub fn speech_capabilities() -> SpeechCapabilities {
    SpeechCapabilities {
        dictation: SpeechFeatureState {
            enabled: false,
            available: false,
            reason_code: SpeechReasonCode::Unsupported,
            message: "Dictation is unavailable: the Rust daemon does not host a \
                      speech-to-text service yet."
                .to_string(),
            retryable: false,
        },
        voice_mode: SpeechFeatureState {
            enabled: false,
            available: false,
            reason_code: SpeechReasonCode::Unsupported,
            message: "Realtime voice is unavailable: the Rust daemon does not host \
                      turn-detection, speech-to-text, or text-to-speech services yet."
                .to_string(),
            retryable: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_dictation_and_voice_mode_unavailable_with_reasons() {
        let caps = speech_capabilities();

        assert!(!caps.dictation.available);
        assert!(!caps.dictation.enabled);
        assert_eq!(caps.dictation.reason_code, SpeechReasonCode::Unsupported);
        assert!(!caps.dictation.message.is_empty());

        assert!(!caps.voice_mode.available);
        assert!(!caps.voice_mode.enabled);
        assert_eq!(caps.voice_mode.reason_code, SpeechReasonCode::Unsupported);
        assert!(!caps.voice_mode.message.is_empty());
    }

    #[test]
    fn serializes_with_camelcase_ui_shape() {
        let caps = speech_capabilities();
        let json = serde_json::to_value(&caps).unwrap();
        assert!(json.get("dictation").is_some());
        assert!(json.get("voiceMode").is_some());
        let dictation = json.get("dictation").unwrap();
        assert_eq!(dictation.get("available").unwrap(), false);
        assert_eq!(dictation.get("reasonCode").unwrap(), "unsupported");
        assert!(dictation.get("message").is_some());
    }
}
