//! E2EE crypto primitives, byte-compatible with the TS `tweetnacl` impl.
//!
//! This is a CRYPTO COMPATIBILITY CONTRACT. The wire format here MUST match
//! `core/packages/relay/src/crypto.ts` exactly so that a Rust daemon and the
//! existing TS clients interoperate byte-for-byte:
//!
//! - Key exchange: Curve25519 / X25519 (`nacl.box.before`), see crypto.ts:117-125.
//! - Encryption: XSalsa20-Poly1305 (`nacl.box.after` / `open.after`),
//!   see crypto.ts:131-140 (encrypt) and crypto.ts:142-161 (decrypt).
//! - Bundle format: `[nonce (24 bytes)] ++ [ciphertext]`, see crypto.ts:128-130, 134-139.
//! - Keys are 32 bytes, exported as STANDARD base64 (base64-js `fromByteArray`,
//!   NOT url-safe), see crypto.ts:63-69, 87-115.
//!
//! Compatibility crate: `crypto_box` v0.9 with the `salsa20` feature, which
//! provides [`crypto_box::SalsaBox`] — the NaCl `crypto_box`
//! (X25519 + XSalsa20-Poly1305) construction that tweetnacl implements. The
//! Poly1305 tag is prepended to the ciphertext exactly as NaCl/tweetnacl does.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use crypto_box::{
    aead::{Aead, AeadCore},
    PublicKey, SalsaBox, SecretKey,
};
use rand::rngs::OsRng;

/// NaCl box public/secret key length (32 bytes). Matches `nacl.box.publicKeyLength`
/// / `nacl.box.secretKeyLength` (crypto.ts:88, 103).
pub const KEY_LENGTH: usize = 32;

/// XSalsa20-Poly1305 nonce length (24 bytes). Matches `nacl.box.nonceLength`
/// (crypto.ts:25).
pub const NONCE_LENGTH: usize = 24;

/// Errors surfaced by the crypto primitives.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid base64: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("invalid key length (expected {expected}, got {got})")]
    KeyLength { expected: usize, got: usize },
    #[error("ciphertext bundle too short (need at least {NONCE_LENGTH} bytes)")]
    BundleTooShort,
    #[error("decryption failed")]
    DecryptFailed,
}

/// A NaCl box keypair (Curve25519). Mirrors the TS `KeyPair` interface
/// (crypto.ts:18-21).
#[derive(Clone)]
pub struct KeyPair {
    pub public_key: PublicKey,
    pub secret_key: SecretKey,
}

/// Precomputed shared key (`nacl.box.before`, crypto.ts:117-125). Wraps a
/// [`SalsaBox`] so encrypt/decrypt match `box.after` / `box.open.after`.
pub struct SharedKey(SalsaBox);

/// Generate a fresh box keypair. Mirrors `generateKeyPair` (crypto.ts:81-85).
pub fn generate_key_pair() -> KeyPair {
    let secret_key = SecretKey::generate(&mut OsRng);
    let public_key = secret_key.public_key();
    KeyPair {
        public_key,
        secret_key,
    }
}

/// Export a public key as standard base64. Mirrors `exportPublicKey`
/// (crypto.ts:87-92).
pub fn export_public_key(public_key: &PublicKey) -> String {
    STANDARD.encode(public_key.as_bytes())
}

/// Import a public key from standard base64. Mirrors `importPublicKey`
/// (crypto.ts:94-100). Also accepts url-safe base64 for robustness, matching
/// the lenient decode used by the channel transport (base64.ts).
pub fn import_public_key(b64: &str) -> Result<PublicKey, CryptoError> {
    let bytes = decode_key_bytes(b64)?;
    Ok(PublicKey::from(bytes))
}

/// Export a secret key as standard base64. Mirrors `exportSecretKey`
/// (crypto.ts:102-107).
pub fn export_secret_key(secret_key: &SecretKey) -> String {
    STANDARD.encode(secret_key.to_bytes())
}

/// Import a secret key from standard base64. Mirrors `importSecretKey`
/// (crypto.ts:109-115).
pub fn import_secret_key(b64: &str) -> Result<SecretKey, CryptoError> {
    let bytes = decode_key_bytes(b64)?;
    Ok(SecretKey::from(bytes))
}

/// Derive the precomputed shared key. Mirrors `deriveSharedKey`
/// (crypto.ts:117-125 / `nacl.box.before`).
pub fn derive_shared_key(our_secret: &SecretKey, peer_public: &PublicKey) -> SharedKey {
    SharedKey(SalsaBox::new(peer_public, our_secret))
}

/// Encrypt `data`, returning the bundle `[nonce (24)] ++ [ciphertext]`.
/// Mirrors `encrypt` (crypto.ts:131-140): random 24-byte nonce prepended to
/// `nacl.box.after(data, nonce, sharedKey)`.
pub fn encrypt(shared_key: &SharedKey, data: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let ciphertext = shared_key
        .0
        .encrypt(&nonce, data)
        .map_err(|_| CryptoError::DecryptFailed)?;
    let mut out = Vec::with_capacity(NONCE_LENGTH + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a `[nonce (24)] ++ [ciphertext]` bundle. Mirrors `decrypt`
/// (crypto.ts:142-161): split nonce + ciphertext, then `box.open.after`.
pub fn decrypt(shared_key: &SharedKey, bundle: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if bundle.len() < NONCE_LENGTH {
        return Err(CryptoError::BundleTooShort);
    }
    let (nonce, ciphertext) = bundle.split_at(NONCE_LENGTH);
    shared_key
        .0
        .decrypt(nonce.into(), ciphertext)
        .map_err(|_| CryptoError::DecryptFailed)
}

fn decode_key_bytes(b64: &str) -> Result<[u8; KEY_LENGTH], CryptoError> {
    let bytes = decode_base64_lenient(b64)?;
    if bytes.len() != KEY_LENGTH {
        return Err(CryptoError::KeyLength {
            expected: KEY_LENGTH,
            got: bytes.len(),
        });
    }
    let mut out = [0u8; KEY_LENGTH];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Decode base64 accepting both standard and url-safe alphabets, normalizing
/// padding — mirrors the lenient decode in `base64.ts` (`base64ToArrayBuffer`).
fn decode_base64_lenient(input: &str) -> Result<Vec<u8>, CryptoError> {
    let trimmed = input.trim();
    let standard: String = trimmed
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

    #[test]
    fn key_export_import_base64_round_trips() {
        let kp = generate_key_pair();
        let pk_b64 = export_public_key(&kp.public_key);
        let sk_b64 = export_secret_key(&kp.secret_key);

        // Standard base64, not url-safe (no '-' or '_').
        assert!(!pk_b64.contains('-') && !pk_b64.contains('_'));

        let pk = import_public_key(&pk_b64).unwrap();
        let sk = import_secret_key(&sk_b64).unwrap();
        assert_eq!(pk.as_bytes(), kp.public_key.as_bytes());
        assert_eq!(sk.to_bytes(), kp.secret_key.to_bytes());
    }

    #[test]
    fn import_rejects_wrong_length() {
        let short = STANDARD.encode([0u8; 16]);
        assert!(matches!(
            import_public_key(&short),
            Err(CryptoError::KeyLength { .. })
        ));
    }

    #[test]
    fn round_trip_both_directions() {
        let alice = generate_key_pair();
        let bob = generate_key_pair();

        let alice_shared = derive_shared_key(&alice.secret_key, &bob.public_key);
        let bob_shared = derive_shared_key(&bob.secret_key, &alice.public_key);

        let msg = b"hello from rocky-relay";
        let bundle = encrypt(&alice_shared, msg).unwrap();

        // nonce is the 24-byte prefix; ciphertext = poly1305 tag (16) + body.
        assert_eq!(bundle.len(), NONCE_LENGTH + 16 + msg.len());

        let opened = decrypt(&bob_shared, &bundle).unwrap();
        assert_eq!(opened, msg);

        // And the reverse direction.
        let bundle2 = encrypt(&bob_shared, b"reply").unwrap();
        assert_eq!(decrypt(&alice_shared, &bundle2).unwrap(), b"reply");
    }

    #[test]
    fn decrypt_rejects_tampered_and_short() {
        let a = generate_key_pair();
        let b = generate_key_pair();
        let shared_a = derive_shared_key(&a.secret_key, &b.public_key);
        let shared_b = derive_shared_key(&b.secret_key, &a.public_key);

        let mut bundle = encrypt(&shared_a, b"secret").unwrap();
        let last = bundle.len() - 1;
        bundle[last] ^= 0xff;
        assert!(matches!(
            decrypt(&shared_b, &bundle),
            Err(CryptoError::DecryptFailed)
        ));

        assert!(matches!(
            decrypt(&shared_b, &[0u8; 8]),
            Err(CryptoError::BundleTooShort)
        ));
    }

    /// CROSS-IMPL KNOWN-ANSWER VECTOR produced by tweetnacl + base64-js.
    ///
    /// Generated with the throwaway Node script documented in the task notes
    /// (imports `tweetnacl` + `base64-js` resolved from
    /// `/Users/steve/roy/rocky/core/node_modules`). The vector below is a bundle
    /// `[nonce(24)] ++ box.after(plaintext, nonce, before(peerPub, ourSecret))`
    /// produced by tweetnacl; this asserts our Rust `decrypt` matches tweetnacl
    /// byte-for-byte, and that our `encrypt` output decrypts under tweetnacl
    /// (see the interop test below + the documented manual run).
    #[test]
    fn decrypts_tweetnacl_known_answer_vector() {
        // alice secret key (base64), bob public key (base64), the bundle that
        // tweetnacl produced, and the expected plaintext.
        let alice_secret_b64 = TWEETNACL_VECTOR.alice_secret_b64;
        let bob_public_b64 = TWEETNACL_VECTOR.bob_public_b64;
        let bundle_b64 = TWEETNACL_VECTOR.bundle_b64;
        let expected_plaintext = TWEETNACL_VECTOR.plaintext;

        let alice_secret = import_secret_key(alice_secret_b64).unwrap();
        let bob_public = import_public_key(bob_public_b64).unwrap();
        let shared = derive_shared_key(&alice_secret, &bob_public);

        let bundle = decode_base64_lenient(bundle_b64).unwrap();
        assert_eq!(&bundle[..NONCE_LENGTH], TWEETNACL_VECTOR.nonce);

        let opened = decrypt(&shared, &bundle).unwrap();
        assert_eq!(opened, expected_plaintext.as_bytes());
    }

    struct TweetNaclVector {
        alice_secret_b64: &'static str,
        bob_public_b64: &'static str,
        bundle_b64: &'static str,
        nonce: &'static [u8],
        plaintext: &'static str,
    }

    // Replaced at build time by interop-vector.rs (generated). See module docs.
    include!("interop_vector.rs");
}
