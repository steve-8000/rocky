//! Relay E2EE crypto primitives + encrypted channel for rockyd.
//!
//! Byte-compatible with the TypeScript relay clients in
//! `core/packages/relay` and `core/packages/server`:
//! - [`crypto`]: NaCl box (X25519 + XSalsa20-Poly1305) primitives, wire-format
//!   compatible with `tweetnacl` (`crypto_box::SalsaBox`).
//! - [`channel`]: the e2ee_hello / e2ee_ready handshake state machine over an
//!   abstract [`channel::Transport`].
//! - [`pairing`]: connection-offer fragment URL encoding matching the app.

pub mod channel;
pub mod crypto;
pub mod pairing;

pub use channel::{ChannelError, ChannelState, EncryptedChannel, Inbound, Transport};
pub use crypto::{
    decrypt, derive_shared_key, encrypt, export_public_key, export_secret_key, generate_key_pair,
    import_public_key, import_secret_key, CryptoError, KeyPair, SharedKey, KEY_LENGTH, NONCE_LENGTH,
};
pub use pairing::{
    create_connection_offer, encode_offer_to_fragment_url, ConnectionOffer, RelayInfo,
};
