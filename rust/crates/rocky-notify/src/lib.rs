//! Push notification token store, notification builder/sender, and speech
//! capability gates for `rockyd`.
//!
//! Source baselines:
//! - `core/packages/server/src/server/push/token-store.ts`
//! - `core/packages/server/src/server/push/notifications.ts`
//! - `core/packages/server/src/server/push/push-service.ts`
//! - `core/packages/protocol/src/agent-attention-notification.ts`
//! - `core/packages/server/src/server/private-files.ts`
//! - `core/packages/server/src/server/speech/speech-runtime.ts`

mod private_file;
mod push;
mod push_store;
mod speech;

pub use private_file::{write_private_file_atomic, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE};
pub use push::{
    AttentionReason, NotConfiguredSender, PermissionRequest, PushNotification, PushSender,
    SendReport, SendStatus,
};
pub use push_store::{PushTokenStore, PushTokenStoreError};
pub use speech::{speech_capabilities, SpeechCapabilities, SpeechFeatureState, SpeechReasonCode};
