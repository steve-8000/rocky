//! Exact Rust port of the TypeScript binary stream frame codecs.
//!
//! Wire contracts mirrored byte-for-byte from:
//! - `core/packages/protocol/src/binary-frames/terminal.ts`
//! - `core/packages/protocol/src/binary-frames/file-transfer.ts`
//!
//! ## Terminal stream frame layout (`terminal.ts`)
//! `encodeTerminalStreamFrame` (terminal.ts:64-75): `byte0 = opcode`,
//! `byte1 = slot & 0xff`, `bytes2.. = payload`. `decodeTerminalStreamFrame`
//! (terminal.ts:77-90) returns `null` when `len < 2` or the opcode is unknown.
//! Resize payload (terminal.ts:106-118) is UTF-8 JSON `{"rows","cols"}`.
//!
//! ## File transfer frame layout (`file-transfer.ts`)
//! `encodeFileTransferFrame` (file-transfer.ts:56-84):
//! `byte0 = opcode`, `byte1 = requestId byte length`, then requestId bytes.
//! For `FileBegin`: a **big-endian** `uint16` metadata length
//! (`DataView.setUint16` defaults to big-endian) followed by UTF-8 JSON
//! metadata. For `FileChunk`: the raw payload. For `FileEnd`: nothing.
//! `decodeFileTransferFrame` (file-transfer.ts:86-126) rejects `len < 2`,
//! unknown opcode, `requestIdLength == 0` or `> len - 2`, a `FileBegin` body
//! shorter than 2 bytes, a metadata-length mismatch, or a non-empty `FileEnd`
//! body.

use serde::{Deserialize, Serialize};

/// Terminal stream opcodes (terminal.ts:9-15).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum TerminalStreamOpcode {
    Output = 0x01,
    Input = 0x02,
    Resize = 0x03,
    Snapshot = 0x04,
    Restore = 0x05,
}

impl TerminalStreamOpcode {
    /// Returns the opcode for a raw byte, or `None` for unknown values
    /// (mirrors `isTerminalStreamOpcode`, terminal.ts:54-62).
    #[must_use]
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0x01 => Some(Self::Output),
            0x02 => Some(Self::Input),
            0x03 => Some(Self::Resize),
            0x04 => Some(Self::Snapshot),
            0x05 => Some(Self::Restore),
            _ => None,
        }
    }
}

/// Decoded terminal stream frame (terminal.ts:19-23).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalStreamFrame {
    pub opcode: TerminalStreamOpcode,
    pub slot: u8,
    pub payload: Vec<u8>,
}

/// Encode a terminal stream frame: `[opcode, slot & 0xff, payload..]`
/// (terminal.ts:64-75).
#[must_use]
pub fn encode_terminal_stream_frame(
    opcode: TerminalStreamOpcode,
    slot: u8,
    payload: &[u8],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(2 + payload.len());
    bytes.push(opcode as u8);
    bytes.push(slot); // slot is u8; `slot & 0xff` in TS is a no-op here.
    bytes.extend_from_slice(payload);
    bytes
}

/// Decode a terminal stream frame, returning `None` when `len < 2` or the
/// opcode byte is unknown (terminal.ts:77-90).
#[must_use]
pub fn decode_terminal_stream_frame(bytes: &[u8]) -> Option<TerminalStreamFrame> {
    if bytes.len() < 2 {
        return None;
    }
    let opcode = TerminalStreamOpcode::from_u8(bytes[0])?;
    Some(TerminalStreamFrame {
        opcode,
        slot: bytes[1],
        payload: bytes[2..].to_vec(),
    })
}

/// Resize payload schema (terminal.ts:4-7): positive `rows`/`cols`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalStreamResize {
    pub rows: u16,
    pub cols: u16,
}

/// Encode resize payload as UTF-8 JSON (terminal.ts:106-110).
#[must_use]
pub fn encode_terminal_resize_payload(rows: u16, cols: u16) -> Vec<u8> {
    // serde_json never fails serializing this struct.
    serde_json::to_vec(&TerminalStreamResize { rows, cols }).unwrap_or_default()
}

/// Decode resize payload, returning `None` on malformed JSON or non-positive
/// dimensions (terminal.ts:112-118; the Zod schema requires positive ints).
#[must_use]
pub fn decode_terminal_resize_payload(bytes: &[u8]) -> Option<TerminalStreamResize> {
    let parsed: TerminalStreamResize = serde_json::from_slice(bytes).ok()?;
    if parsed.rows == 0 || parsed.cols == 0 {
        return None;
    }
    Some(parsed)
}

/// File transfer opcodes (file-transfer.ts:4-8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FileTransferOpcode {
    FileBegin = 0x10,
    FileChunk = 0x11,
    FileEnd = 0x12,
}

impl FileTransferOpcode {
    /// Mirrors `isFileTransferOpcode` (file-transfer.ts:128-134).
    #[must_use]
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0x10 => Some(Self::FileBegin),
            0x11 => Some(Self::FileChunk),
            0x12 => Some(Self::FileEnd),
            _ => None,
        }
    }
}

/// `FileBegin` metadata schema (file-transfer.ts:12-17).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileBeginMetadata {
    pub mime: String,
    pub size: u64,
    /// `"utf-8"` or `"binary"`.
    pub encoding: String,
    #[serde(rename = "modifiedAt")]
    pub modified_at: String,
}

/// Decoded file transfer frame (file-transfer.ts:19-38).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileTransferFrame {
    Begin {
        request_id: String,
        metadata: FileBeginMetadata,
    },
    Chunk {
        request_id: String,
        payload: Vec<u8>,
    },
    End {
        request_id: String,
    },
}

/// Errors returned when encoding a file transfer frame (mirror the
/// `RangeError`s thrown in file-transfer.ts).
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FileTransferEncodeError {
    /// `encodeRequestId` (file-transfer.ts:140-149): empty requestId.
    #[error("file transfer requestId is required")]
    EmptyRequestId,
    /// `encodeRequestId`: requestId longer than 0xff bytes.
    #[error("file transfer requestId is too long")]
    RequestIdTooLong,
    /// `encodeFileTransferFrame` (file-transfer.ts:60-62): metadata > 0xffff.
    #[error("FileBegin metadata is too long")]
    MetadataTooLong,
}

fn encode_request_id(request_id: &str) -> Result<Vec<u8>, FileTransferEncodeError> {
    let bytes = request_id.as_bytes();
    if bytes.is_empty() {
        return Err(FileTransferEncodeError::EmptyRequestId);
    }
    if bytes.len() > 0xff {
        return Err(FileTransferEncodeError::RequestIdTooLong);
    }
    Ok(bytes.to_vec())
}

/// Encode a `FileBegin` frame (file-transfer.ts:58-72).
///
/// Layout: `[0x10, reqIdLen, reqId.., metaLenHi, metaLenLo, metadata..]`
/// where the metadata length is a big-endian `uint16`.
pub fn encode_file_begin_frame(
    request_id: &str,
    metadata: &FileBeginMetadata,
) -> Result<Vec<u8>, FileTransferEncodeError> {
    let request_id = encode_request_id(request_id)?;
    let metadata = serde_json::to_vec(metadata).unwrap_or_default();
    if metadata.len() > 0xffff {
        return Err(FileTransferEncodeError::MetadataTooLong);
    }
    let mut bytes = Vec::with_capacity(4 + request_id.len() + metadata.len());
    bytes.push(FileTransferOpcode::FileBegin as u8);
    bytes.push(request_id.len() as u8);
    bytes.extend_from_slice(&request_id);
    // big-endian uint16, matching DataView.setUint16 default.
    bytes.extend_from_slice(&(metadata.len() as u16).to_be_bytes());
    bytes.extend_from_slice(&metadata);
    Ok(bytes)
}

/// Encode a `FileChunk` frame (file-transfer.ts:74-83).
///
/// Layout: `[0x11, reqIdLen, reqId.., payload..]`.
pub fn encode_file_chunk_frame(
    request_id: &str,
    payload: &[u8],
) -> Result<Vec<u8>, FileTransferEncodeError> {
    let request_id = encode_request_id(request_id)?;
    let mut bytes = Vec::with_capacity(2 + request_id.len() + payload.len());
    bytes.push(FileTransferOpcode::FileChunk as u8);
    bytes.push(request_id.len() as u8);
    bytes.extend_from_slice(&request_id);
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

/// Encode a `FileEnd` frame (file-transfer.ts:74-83 with empty payload).
///
/// Layout: `[0x12, reqIdLen, reqId..]`.
pub fn encode_file_end_frame(request_id: &str) -> Result<Vec<u8>, FileTransferEncodeError> {
    let request_id = encode_request_id(request_id)?;
    let mut bytes = Vec::with_capacity(2 + request_id.len());
    bytes.push(FileTransferOpcode::FileEnd as u8);
    bytes.push(request_id.len() as u8);
    bytes.extend_from_slice(&request_id);
    Ok(bytes)
}

/// Decode a file transfer frame, returning `None` on any malformed input
/// (file-transfer.ts:86-126).
#[must_use]
pub fn decode_file_transfer_frame(bytes: &[u8]) -> Option<FileTransferFrame> {
    if bytes.len() < 2 {
        return None;
    }
    let opcode = FileTransferOpcode::from_u8(bytes[0])?;
    let request_id_len = bytes[1] as usize;
    if request_id_len == 0 || request_id_len > bytes.len() - 2 {
        return None;
    }
    let request_id = String::from_utf8_lossy(&bytes[2..2 + request_id_len]).into_owned();
    let body = &bytes[2 + request_id_len..];

    match opcode {
        FileTransferOpcode::FileBegin => {
            if body.len() < 2 {
                return None;
            }
            let metadata_len = u16::from_be_bytes([body[0], body[1]]) as usize;
            if metadata_len != body.len() - 2 {
                return None;
            }
            let metadata: FileBeginMetadata = serde_json::from_slice(&body[2..]).ok()?;
            Some(FileTransferFrame::Begin {
                request_id,
                metadata,
            })
        }
        FileTransferOpcode::FileChunk => Some(FileTransferFrame::Chunk {
            request_id,
            payload: body.to_vec(),
        }),
        FileTransferOpcode::FileEnd => {
            if !body.is_empty() {
                return None;
            }
            Some(FileTransferFrame::End { request_id })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_stream_round_trip_all_opcodes() {
        let cases = [
            (TerminalStreamOpcode::Output, b"out".as_slice()),
            (TerminalStreamOpcode::Input, b"in".as_slice()),
            (TerminalStreamOpcode::Resize, b"{}".as_slice()),
            (TerminalStreamOpcode::Snapshot, b"snap".as_slice()),
            (TerminalStreamOpcode::Restore, b"".as_slice()),
        ];
        for (opcode, payload) in cases {
            let encoded = encode_terminal_stream_frame(opcode, 7, payload);
            assert_eq!(encoded[0], opcode as u8);
            assert_eq!(encoded[1], 7);
            let decoded = decode_terminal_stream_frame(&encoded).expect("decodes");
            assert_eq!(decoded.opcode, opcode);
            assert_eq!(decoded.slot, 7);
            assert_eq!(decoded.payload, payload);
        }
    }

    #[test]
    fn terminal_stream_slot_masked_to_byte() {
        // 0x1_2345 & 0xff == 0x45; the Rust API takes a u8 so the wire value is
        // already masked, matching `slot & 0xff` in terminal.ts:71.
        let encoded = encode_terminal_stream_frame(TerminalStreamOpcode::Output, 0x45, b"x");
        assert_eq!(encoded[1], 0x45);
        let decoded = decode_terminal_stream_frame(&encoded).unwrap();
        assert_eq!(decoded.slot, 0x45);
    }

    #[test]
    fn terminal_stream_rejects_unknown_opcode() {
        let frame = [0xffu8, 0x00, 0x01];
        assert!(decode_terminal_stream_frame(&frame).is_none());
    }

    #[test]
    fn terminal_stream_rejects_short_frame() {
        assert!(decode_terminal_stream_frame(&[]).is_none());
        assert!(decode_terminal_stream_frame(&[0x01]).is_none());
        // Exactly 2 bytes is valid with an empty payload.
        assert!(decode_terminal_stream_frame(&[0x01, 0x00]).is_some());
    }

    #[test]
    fn resize_payload_round_trips() {
        let encoded = encode_terminal_resize_payload(24, 80);
        assert_eq!(encoded, br#"{"rows":24,"cols":80}"#);
        let decoded = decode_terminal_resize_payload(&encoded).expect("decodes");
        assert_eq!(decoded, TerminalStreamResize { rows: 24, cols: 80 });
    }

    #[test]
    fn resize_payload_rejects_malformed_and_nonpositive() {
        assert!(decode_terminal_resize_payload(b"not json").is_none());
        assert!(decode_terminal_resize_payload(br#"{"rows":0,"cols":80}"#).is_none());
    }

    fn sample_metadata() -> FileBeginMetadata {
        FileBeginMetadata {
            mime: "text/plain".into(),
            size: 3,
            encoding: "utf-8".into(),
            modified_at: "2026-06-11T00:00:00Z".into(),
        }
    }

    #[test]
    fn file_begin_round_trips_with_metadata() {
        let meta = sample_metadata();
        let encoded = encode_file_begin_frame("req-1", &meta).expect("encodes");
        assert_eq!(encoded[0], FileTransferOpcode::FileBegin as u8);
        assert_eq!(encoded[1] as usize, "req-1".len());
        // Verify the big-endian uint16 metadata length prefix.
        let meta_json = serde_json::to_vec(&meta).unwrap();
        let len_off = 2 + "req-1".len();
        assert_eq!(
            u16::from_be_bytes([encoded[len_off], encoded[len_off + 1]]) as usize,
            meta_json.len()
        );
        match decode_file_transfer_frame(&encoded).expect("decodes") {
            FileTransferFrame::Begin {
                request_id,
                metadata,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(metadata, meta);
            }
            other => panic!("expected Begin, got {other:?}"),
        }
    }

    #[test]
    fn file_chunk_round_trips_raw_payload() {
        let payload = [0u8, 1, 2, 255, 254];
        let encoded = encode_file_chunk_frame("r", &payload).expect("encodes");
        match decode_file_transfer_frame(&encoded).expect("decodes") {
            FileTransferFrame::Chunk {
                request_id,
                payload: out,
            } => {
                assert_eq!(request_id, "r");
                assert_eq!(out, payload);
            }
            other => panic!("expected Chunk, got {other:?}"),
        }
    }

    #[test]
    fn file_end_round_trips() {
        let encoded = encode_file_end_frame("abc").expect("encodes");
        assert_eq!(encoded, vec![0x12, 3, b'a', b'b', b'c']);
        match decode_file_transfer_frame(&encoded).expect("decodes") {
            FileTransferFrame::End { request_id } => assert_eq!(request_id, "abc"),
            other => panic!("expected End, got {other:?}"),
        }
    }

    #[test]
    fn file_transfer_encode_rejects_bad_request_id() {
        assert_eq!(
            encode_file_chunk_frame("", b"x"),
            Err(FileTransferEncodeError::EmptyRequestId)
        );
        let long = "a".repeat(256);
        assert_eq!(
            encode_file_chunk_frame(&long, b"x"),
            Err(FileTransferEncodeError::RequestIdTooLong)
        );
    }

    #[test]
    fn file_transfer_decode_rejects_malformed() {
        // Too short.
        assert!(decode_file_transfer_frame(&[0x10]).is_none());
        // Unknown opcode.
        assert!(decode_file_transfer_frame(&[0x99, 1, b'a']).is_none());
        // requestIdLength == 0.
        assert!(decode_file_transfer_frame(&[0x11, 0]).is_none());
        // requestIdLength overflows the buffer.
        assert!(decode_file_transfer_frame(&[0x11, 5, b'a']).is_none());
        // FileBegin body < 2 bytes.
        assert!(decode_file_transfer_frame(&[0x10, 1, b'a']).is_none());
        // FileBegin metadata-length mismatch.
        assert!(decode_file_transfer_frame(&[0x10, 1, b'a', 0x00, 0xff]).is_none());
        // FileEnd with non-empty body.
        assert!(decode_file_transfer_frame(&[0x12, 1, b'a', 0x00]).is_none());
    }
}
