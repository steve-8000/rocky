//! Encrypted channel state machine, mirroring
//! `core/packages/relay/src/encrypted-channel.ts`.
//!
//! Handshake (encrypted-channel.ts:50-57, 120-176, 186-259):
//! - client sends plaintext JSON `{"type":"e2ee_hello","key":<base64 pubkey>}`.
//! - daemon replies plaintext JSON `{"type":"e2ee_ready"}`.
//! - thereafter every frame is an encrypted bundle, transmitted as STANDARD
//!   base64 text (encrypted-channel.ts:387-400, 354-358).
//!
//! States: `connecting | handshaking | open | closed` (encrypted-channel.ts:36).
//!
//! The transport is abstracted behind [`Transport`] (send/close) so the channel
//! is testable without a real socket. Inbound frames are fed in via
//! [`EncryptedChannel::handle_inbound`], and decrypted application payloads are
//! delivered through the [`Transport`] / returned to the caller.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use crypto_box::PublicKey;
use serde::{Deserialize, Serialize};

use crate::crypto::{
    self, derive_shared_key, export_public_key, import_public_key, KeyPair, SharedKey,
};

/// Channel lifecycle states. Mirrors `ChannelState` (encrypted-channel.ts:36).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelState {
    Connecting,
    Handshaking,
    Open,
    Closed,
}

/// Errors surfaced by the channel.
#[derive(Debug, thiserror::Error)]
pub enum ChannelError {
    #[error(transparent)]
    Crypto(#[from] crypto::CryptoError),
    #[error("invalid hello message: {0}")]
    InvalidHello(String),
    #[error("received plaintext frame on encrypted channel")]
    PlaintextFrame,
    #[error("channel not open")]
    NotOpen,
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Abstraction over a WebSocket-like transport. Mirrors the TS `Transport`
/// interface (encrypted-channel.ts:21-27): `send` + `close`. Inbound delivery
/// is driven by the caller via [`EncryptedChannel::handle_inbound`].
pub trait Transport: Send {
    /// Send a text frame over the wire.
    fn send(&mut self, data: &str);
    /// Close the transport with a code + reason.
    fn close(&mut self, code: u16, reason: &str);
}

/// Plaintext handshake messages. Wire shapes match encrypted-channel.ts:50-57.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
enum HandshakeMessage {
    #[serde(rename = "e2ee_hello")]
    Hello { key: String },
    #[serde(rename = "e2ee_ready")]
    Ready,
}

/// Result of handling an inbound frame.
#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    /// A handshake frame was consumed; no application payload.
    Handshake,
    /// The channel just became open (daemon sent/received `e2ee_ready`).
    Opened,
    /// A decrypted application payload.
    Message(Vec<u8>),
    /// Frame ignored (stray handshake traffic on an open channel).
    Ignored,
}

/// Re-handshake close code/reason (encrypted-channel.ts:95-96).
const REHANDSHAKE_MISMATCH_CODE: u16 = 1008;
const REHANDSHAKE_MISMATCH_REASON: &str = "E2EE re-handshake key mismatch";

/// Encrypted channel wrapping a [`Transport`]. Works for both client and daemon
/// sides (encrypted-channel.ts:264).
pub struct EncryptedChannel<T: Transport> {
    transport: T,
    shared_key: SharedKey,
    state: ChannelState,
    /// Set on the daemon side to allow idempotent re-handshake
    /// (encrypted-channel.ts:38-48, 458-486).
    daemon_key_pair: Option<KeyPair>,
    /// Client public key that established this channel (daemon side), used to
    /// detect re-handshake key mismatch (encrypted-channel.ts:476-485).
    peer_public_key: Option<PublicKey>,
}

impl<T: Transport> EncryptedChannel<T> {
    fn new(
        transport: T,
        shared_key: SharedKey,
        state: ChannelState,
        daemon_key_pair: Option<KeyPair>,
        peer_public_key: Option<PublicKey>,
    ) -> Self {
        Self {
            transport,
            shared_key,
            state,
            daemon_key_pair,
            peer_public_key,
        }
    }

    /// Create the channel as the initiator (client) and emit the plaintext
    /// `e2ee_hello`. Mirrors `createClientChannel` (encrypted-channel.ts:120-176).
    pub fn connect_client(
        mut transport: T,
        daemon_public_key_b64: &str,
    ) -> Result<Self, ChannelError> {
        let key_pair = crypto::generate_key_pair();
        let daemon_public_key = import_public_key(daemon_public_key_b64)?;
        let shared_key = derive_shared_key(&key_pair.secret_key, &daemon_public_key);

        let hello = HandshakeMessage::Hello {
            key: export_public_key(&key_pair.public_key),
        };
        transport.send(&serde_json::to_string(&hello)?);

        Ok(Self::new(
            transport,
            shared_key,
            ChannelState::Handshaking,
            None,
            None,
        ))
    }

    /// Create the channel as the responder (daemon) from a received
    /// `e2ee_hello`, reply with `e2ee_ready`, and transition to open.
    /// Mirrors `createDaemonChannel` (encrypted-channel.ts:186-259).
    pub fn accept_daemon(
        mut transport: T,
        daemon_key_pair: KeyPair,
        hello_frame: &str,
    ) -> Result<Self, ChannelError> {
        let parsed: HandshakeMessage = serde_json::from_str(hello_frame.trim())
            .map_err(|e| ChannelError::InvalidHello(e.to_string()))?;
        let HandshakeMessage::Hello { key } = parsed else {
            return Err(ChannelError::InvalidHello("expected e2ee_hello".into()));
        };
        if key.trim().is_empty() {
            return Err(ChannelError::InvalidHello("empty key".into()));
        }

        let client_public_key = import_public_key(&key)?;
        let shared_key = derive_shared_key(&daemon_key_pair.secret_key, &client_public_key);

        transport.send(&serde_json::to_string(&HandshakeMessage::Ready)?);

        Ok(Self::new(
            transport,
            shared_key,
            ChannelState::Open,
            Some(daemon_key_pair),
            Some(client_public_key),
        ))
    }

    /// Current channel state.
    pub fn state(&self) -> ChannelState {
        self.state
    }

    /// Whether the channel is open (encrypted-channel.ts:495-497).
    pub fn is_open(&self) -> bool {
        self.state == ChannelState::Open
    }

    /// Encrypt and send an application payload. Sent as STANDARD base64 text
    /// (encrypted-channel.ts:387-400).
    pub fn send(&mut self, data: &[u8]) -> Result<(), ChannelError> {
        if self.state != ChannelState::Open {
            return Err(ChannelError::NotOpen);
        }
        let bundle = crypto::encrypt(&self.shared_key, data)?;
        self.transport.send(&STANDARD.encode(bundle));
        Ok(())
    }

    /// Feed an inbound frame. Drives the state machine, mirroring
    /// `handleMessage` (encrypted-channel.ts:302-385).
    pub fn handle_inbound(&mut self, frame: &str) -> Result<Inbound, ChannelError> {
        match self.state {
            ChannelState::Handshaking => {
                // Client waits for plaintext `e2ee_ready` (encrypted-channel.ts:303-318).
                if let Ok(HandshakeMessage::Ready) = serde_json::from_str(frame.trim()) {
                    self.state = ChannelState::Open;
                    return Ok(Inbound::Opened);
                }
                Ok(Inbound::Handshake)
            }
            ChannelState::Open => self.handle_open_frame(frame),
            ChannelState::Connecting | ChannelState::Closed => Ok(Inbound::Ignored),
        }
    }

    fn handle_open_frame(&mut self, frame: &str) -> Result<Inbound, ChannelError> {
        let trimmed = frame.trim();
        // Stray plaintext JSON handshake traffic (encrypted-channel.ts:323-353).
        if trimmed.starts_with('{') {
            match serde_json::from_str::<HandshakeMessage>(trimmed) {
                Ok(HandshakeMessage::Hello { key }) => {
                    if self.daemon_key_pair.is_some() {
                        self.handle_daemon_rehello(&key)?;
                    }
                    return Ok(Inbound::Ignored);
                }
                Ok(HandshakeMessage::Ready) => return Ok(Inbound::Ignored),
                Err(_) => return Err(ChannelError::PlaintextFrame),
            }
        }

        // Ciphertext is always base64 text on the wire (encrypted-channel.ts:392-398).
        let bundle = decode_base64_lenient(trimmed)?;
        let plaintext = crypto::decrypt(&self.shared_key, &bundle)?;
        Ok(Inbound::Message(plaintext))
    }

    /// Idempotent daemon re-handshake (encrypted-channel.ts:458-486): same
    /// client key -> re-send `e2ee_ready`; different key -> close 1008.
    fn handle_daemon_rehello(&mut self, client_key_b64: &str) -> Result<(), ChannelError> {
        if self.daemon_key_pair.is_none() {
            return Ok(());
        }
        let client_public_key = import_public_key(client_key_b64)?;

        // Same client key (handshake retry) -> re-send `ready`, do not re-key.
        // Comparing the peer public key is equivalent to comparing the derived
        // shared key here, since the daemon secret is fixed.
        if self
            .peer_public_key
            .as_ref()
            .is_some_and(|pk| pk.as_bytes() == client_public_key.as_bytes())
        {
            self.transport
                .send(&serde_json::to_string(&HandshakeMessage::Ready)?);
            return Ok(());
        }

        self.state = ChannelState::Closed;
        self.transport
            .close(REHANDSHAKE_MISMATCH_CODE, REHANDSHAKE_MISMATCH_REASON);
        Ok(())
    }

    /// Close the channel (encrypted-channel.ts:488-491).
    pub fn close(&mut self, code: u16, reason: &str) {
        self.state = ChannelState::Closed;
        self.transport.close(code, reason);
    }

    /// Mark the transport as closed by the peer (encrypted-channel.ts:288-292).
    pub fn mark_closed(&mut self) {
        self.state = ChannelState::Closed;
    }

    /// Borrow the underlying transport (e.g. for assertions in tests).
    pub fn transport(&self) -> &T {
        &self.transport
    }
}

/// Lenient base64 decode mirroring `base64ToArrayBuffer` (base64.ts).
fn decode_base64_lenient(input: &str) -> Result<Vec<u8>, crypto::CryptoError> {
    let standard: String = input
        .trim()
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .filter(|c| !c.is_whitespace())
        .collect();
    let pad = (4 - (standard.len() % 4)) % 4;
    let padded = format!("{standard}{}", "=".repeat(pad));
    Ok(STANDARD.decode(padded)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// Mock transport recording sent frames and close calls.
    #[derive(Clone, Default)]
    struct MockTransport {
        sent: Rc<RefCell<Vec<String>>>,
        closed: Rc<RefCell<Option<(u16, String)>>>,
    }

    // Tests are single-threaded; the Rc-based mock is fine here.
    unsafe impl Send for MockTransport {}

    impl Transport for MockTransport {
        fn send(&mut self, data: &str) {
            self.sent.borrow_mut().push(data.to_string());
        }
        fn close(&mut self, code: u16, reason: &str) {
            *self.closed.borrow_mut() = Some((code, reason.to_string()));
        }
    }

    fn last_sent(t: &MockTransport) -> String {
        t.sent.borrow().last().cloned().unwrap()
    }

    #[test]
    fn full_handshake_and_encrypted_exchange() {
        let daemon_kp = crypto::generate_key_pair();
        let daemon_pub_b64 = export_public_key(&daemon_kp.public_key);

        // Client side: connect emits plaintext e2ee_hello.
        let client_tx = MockTransport::default();
        let mut client =
            EncryptedChannel::connect_client(client_tx.clone(), &daemon_pub_b64).unwrap();
        let hello = last_sent(&client_tx);
        let hello_parsed: HandshakeMessage = serde_json::from_str(&hello).unwrap();
        assert!(matches!(hello_parsed, HandshakeMessage::Hello { .. }));
        assert_eq!(client.state(), ChannelState::Handshaking);

        // Daemon side: accept hello -> replies plaintext e2ee_ready, opens.
        let daemon_tx = MockTransport::default();
        let mut daemon =
            EncryptedChannel::accept_daemon(daemon_tx.clone(), daemon_kp, &hello).unwrap();
        let ready = last_sent(&daemon_tx);
        assert_eq!(
            serde_json::from_str::<HandshakeMessage>(&ready).unwrap(),
            HandshakeMessage::Ready
        );
        assert!(daemon.is_open());

        // Client receives ready -> opens.
        assert_eq!(client.handle_inbound(&ready).unwrap(), Inbound::Opened);
        assert!(client.is_open());

        // Client -> daemon encrypted payload.
        client.send(b"hello daemon").unwrap();
        let ct = last_sent(&client_tx);
        // The frame is base64, NOT plaintext JSON.
        assert!(!ct.trim_start().starts_with('{'));
        assert_eq!(
            daemon.handle_inbound(&ct).unwrap(),
            Inbound::Message(b"hello daemon".to_vec())
        );

        // Daemon -> client encrypted payload.
        daemon.send(b"hello client").unwrap();
        let ct2 = last_sent(&daemon_tx);
        assert_eq!(
            client.handle_inbound(&ct2).unwrap(),
            Inbound::Message(b"hello client".to_vec())
        );
    }

    #[test]
    fn send_before_open_errors() {
        let daemon_kp = crypto::generate_key_pair();
        let daemon_pub_b64 = export_public_key(&daemon_kp.public_key);
        let mut client =
            EncryptedChannel::connect_client(MockTransport::default(), &daemon_pub_b64).unwrap();
        assert!(matches!(client.send(b"x"), Err(ChannelError::NotOpen)));
    }

    #[test]
    fn daemon_rejects_invalid_hello() {
        let daemon_kp = crypto::generate_key_pair();
        let result = EncryptedChannel::accept_daemon(MockTransport::default(), daemon_kp, "not json");
        assert!(matches!(
            result.err(),
            Some(ChannelError::InvalidHello(_))
        ));
    }

    #[test]
    fn rehello_same_key_resends_ready() {
        let daemon_kp = crypto::generate_key_pair();
        let daemon_pub_b64 = export_public_key(&daemon_kp.public_key);
        let client_tx = MockTransport::default();
        let client = EncryptedChannel::connect_client(client_tx.clone(), &daemon_pub_b64).unwrap();
        let hello = last_sent(&client_tx);

        let daemon_tx = MockTransport::default();
        let mut daemon =
            EncryptedChannel::accept_daemon(daemon_tx.clone(), daemon_kp, &hello).unwrap();
        daemon_tx.sent.borrow_mut().clear();

        // Same client hello again -> daemon re-sends ready, stays open.
        assert_eq!(daemon.handle_inbound(&hello).unwrap(), Inbound::Ignored);
        assert_eq!(
            serde_json::from_str::<HandshakeMessage>(&last_sent(&daemon_tx)).unwrap(),
            HandshakeMessage::Ready
        );
        assert!(daemon.is_open());
        drop(client);
    }

    #[test]
    fn rehello_different_key_closes() {
        let daemon_kp = crypto::generate_key_pair();
        let daemon_pub_b64 = export_public_key(&daemon_kp.public_key);
        let hello = last_sent(
            EncryptedChannel::connect_client(MockTransport::default(), &daemon_pub_b64)
                .unwrap()
                .transport(),
        );

        let daemon_tx = MockTransport::default();
        let mut daemon =
            EncryptedChannel::accept_daemon(daemon_tx.clone(), daemon_kp, &hello).unwrap();

        // A different client's hello on an open channel -> close 1008.
        let other = crypto::generate_key_pair();
        let other_hello = serde_json::to_string(&HandshakeMessage::Hello {
            key: export_public_key(&other.public_key),
        })
        .unwrap();
        daemon.handle_inbound(&other_hello).unwrap();
        assert_eq!(daemon.state(), ChannelState::Closed);
        assert_eq!(
            *daemon_tx.closed.borrow(),
            Some((
                REHANDSHAKE_MISMATCH_CODE,
                REHANDSHAKE_MISMATCH_REASON.to_string()
            ))
        );
    }

    #[test]
    fn plaintext_frame_on_open_channel_errors() {
        let daemon_kp = crypto::generate_key_pair();
        let daemon_pub_b64 = export_public_key(&daemon_kp.public_key);
        let client_tx = MockTransport::default();
        let client = EncryptedChannel::connect_client(client_tx.clone(), &daemon_pub_b64).unwrap();
        let hello = last_sent(&client_tx);
        let mut daemon =
            EncryptedChannel::accept_daemon(MockTransport::default(), daemon_kp, &hello).unwrap();

        // Non-handshake JSON payload on an open channel is a protocol mismatch.
        assert!(matches!(
            daemon.handle_inbound("{\"foo\":1}"),
            Err(ChannelError::PlaintextFrame)
        ));
        drop(client);
    }
}
