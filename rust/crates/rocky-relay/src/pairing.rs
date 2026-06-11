//! Connection-offer (pairing) encoding, mirroring
//! `core/packages/server/src/server/connection-offer.ts` and the schema in
//! `core/packages/protocol/src/connection-offer.ts`.
//!
//! A Rust daemon MUST produce the SAME pairing URLs the app expects:
//!   `<appBaseUrl>/#offer=<base64url(JSON)>`
//! (connection-offer.ts:43-50). The JSON is a v2 offer
//! (protocol/connection-offer.ts:9-16):
//!   `{ "v": 2, "serverId", "daemonPublicKeyB64", "relay": { "endpoint", "useTls"? } }`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// Relay connection details for a pairing offer
/// (protocol/connection-offer.ts:13-16).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayInfo {
    pub endpoint: String,
    /// Serialized only when present, matching the optional `useTls` field.
    #[serde(rename = "useTls")]
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub use_tls: Option<bool>,
}

/// A v2 connection offer (protocol/connection-offer.ts:9-16). Field order is
/// chosen to match the TS object literal so `serde_json` produces identical
/// JSON (connection-offer.ts:36-40).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectionOffer {
    pub v: u8,
    #[serde(rename = "serverId")]
    pub server_id: String,
    #[serde(rename = "daemonPublicKeyB64")]
    pub daemon_public_key_b64: String,
    pub relay: RelayInfo,
}

/// Build a v2 connection offer. Mirrors `createConnectionOfferV2`
/// (connection-offer.ts:30-41).
pub fn create_connection_offer(
    server_id: impl Into<String>,
    daemon_public_key_b64: impl Into<String>,
    relay: RelayInfo,
) -> ConnectionOffer {
    ConnectionOffer {
        v: 2,
        server_id: server_id.into(),
        daemon_public_key_b64: daemon_public_key_b64.into(),
        relay,
    }
}

/// Encode an offer to a fragment URL `<appBaseUrl>/#offer=<base64url>`.
/// Mirrors `encodeOfferToFragmentUrl` (connection-offer.ts:43-50):
/// JSON -> `base64url` (Node `base64url`: url-safe alphabet, NO padding) ->
/// appended to the trimmed base URL.
pub fn encode_offer_to_fragment_url(offer: &ConnectionOffer, app_base_url: &str) -> String {
    let json = serde_json::to_string(offer).expect("offer serializes");
    let encoded = URL_SAFE_NO_PAD.encode(json.as_bytes());
    let base = app_base_url.strip_suffix('/').unwrap_or(app_base_url);
    format!("{base}/#offer={encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offer_json_field_order_matches_ts() {
        let offer = create_connection_offer(
            "server-123",
            "cHVibGlja2V5",
            RelayInfo {
                endpoint: "wss://relay.example/ws".to_string(),
                use_tls: Some(true),
            },
        );
        let json = serde_json::to_string(&offer).unwrap();
        assert_eq!(
            json,
            r#"{"v":2,"serverId":"server-123","daemonPublicKeyB64":"cHVibGlja2V5","relay":{"endpoint":"wss://relay.example/ws","useTls":true}}"#
        );
    }

    #[test]
    fn use_tls_omitted_when_none() {
        let offer = create_connection_offer(
            "s",
            "k",
            RelayInfo {
                endpoint: "wss://r".to_string(),
                use_tls: None,
            },
        );
        let json = serde_json::to_string(&offer).unwrap();
        assert_eq!(
            json,
            r#"{"v":2,"serverId":"s","daemonPublicKeyB64":"k","relay":{"endpoint":"wss://r"}}"#
        );
    }

    #[test]
    fn fragment_url_matches_ts_format() {
        let offer = create_connection_offer(
            "server-123",
            "cHVibGlja2V5",
            RelayInfo {
                endpoint: "wss://relay.example/ws".to_string(),
                use_tls: Some(true),
            },
        );

        // Expected encoded value computed from the canonical JSON via Node
        // `Buffer.from(json,"utf8").toString("base64url")` (connection-offer.ts:47).
        let json = serde_json::to_string(&offer).unwrap();
        let expected_encoded = URL_SAFE_NO_PAD.encode(json.as_bytes());

        // Trailing slash on the base URL is stripped (connection-offer.ts:49).
        let url = encode_offer_to_fragment_url(&offer, "https://rocky.clab.one/");
        assert_eq!(url, format!("https://rocky.clab.one/#offer={expected_encoded}"));
        assert!(url.starts_with("https://rocky.clab.one/#offer="));

        // Without a trailing slash produces the same URL.
        let url2 = encode_offer_to_fragment_url(&offer, "https://rocky.clab.one");
        assert_eq!(url, url2);
    }

    #[test]
    fn round_trips_through_base64url_decode() {
        let offer = create_connection_offer(
            "abc",
            "ZGFlbW9u",
            RelayInfo {
                endpoint: "wss://r/ws".to_string(),
                use_tls: None,
            },
        );
        let url = encode_offer_to_fragment_url(&offer, "https://app.test");
        let encoded = url.split("#offer=").nth(1).unwrap();
        let json = URL_SAFE_NO_PAD.decode(encoded).unwrap();
        let decoded: ConnectionOffer = serde_json::from_slice(&json).unwrap();
        assert_eq!(decoded, offer);
    }
}
