//! Terminal PTY manager + binary stream frame protocol for rockyd.
//!
//! - [`frames`] is an exact Rust port of the TypeScript wire codecs in
//!   `core/packages/protocol/src/binary-frames/{terminal,file-transfer}.ts`.
//! - [`manager`] is a `portable-pty`-backed terminal manager mirroring the
//!   lifecycle subset of
//!   `core/packages/server/src/terminal/terminal-manager.ts`, including the
//!   resize-ownership rule (spec 03 line 111).

pub mod frames;
pub mod manager;

pub use frames::{
    decode_file_transfer_frame, decode_terminal_resize_payload, decode_terminal_stream_frame,
    encode_file_begin_frame, encode_file_chunk_frame, encode_file_end_frame,
    encode_terminal_resize_payload, encode_terminal_stream_frame, FileBeginMetadata,
    FileTransferEncodeError, FileTransferFrame, FileTransferOpcode, TerminalStreamFrame,
    TerminalStreamOpcode, TerminalStreamResize,
};
pub use manager::{
    CreateTerminalOptions, CreatedTerminal, TerminalError, TerminalInfo, TerminalManager,
};
