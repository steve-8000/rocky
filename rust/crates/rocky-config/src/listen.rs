use thiserror::Error;

/// A parsed listen target, matching `ListenTarget` in `bootstrap.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListenTarget {
    Tcp { host: String, port: u16 },
    Socket { path: String },
    Pipe { path: String },
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ListenParseError {
    #[error("Invalid listen string (Windows path is not a valid listen target): {0}")]
    WindowsPath(String),
    #[error("Invalid port in listen string: {0}")]
    InvalidPort(String),
    #[error("Invalid listen string: {0}")]
    Invalid(String),
}

fn is_windows_drive(listen: &str) -> bool {
    let bytes = listen.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'\\'
}

/// Parse a listen string into a [`ListenTarget`].
///
/// Mirrors `parseListenString` in `bootstrap.ts` exactly, including ordering:
/// 1. Windows named pipes (`\\.\pipe\...` or `pipe://...`)
/// 2. explicit `unix://` sockets
/// 3. reject Windows drive paths
/// 4. POSIX absolute path (`/` or `~`) -> unix socket
/// 5. pure numeric -> TCP on 127.0.0.1
/// 6. `host:port` -> TCP (empty host defaults to 127.0.0.1)
pub fn parse_listen_string(listen: &str) -> Result<ListenTarget, ListenParseError> {
    // 1. Windows named pipes
    if listen.starts_with("\\\\.\\pipe\\") || listen.starts_with("pipe://") {
        let path = if let Some(rest) = listen.strip_prefix("pipe://") {
            rest.to_string()
        } else {
            listen.to_string()
        };
        return Ok(ListenTarget::Pipe { path });
    }

    // 2. Explicit unix:// prefix
    if let Some(rest) = listen.strip_prefix("unix://") {
        return Ok(ListenTarget::Socket {
            path: rest.to_string(),
        });
    }

    // 3. Reject Windows absolute drive paths
    if is_windows_drive(listen) {
        return Err(ListenParseError::WindowsPath(listen.to_string()));
    }

    // 4. POSIX absolute path -> unix socket
    if listen.starts_with('/') || listen.starts_with('~') {
        return Ok(ListenTarget::Socket {
            path: listen.to_string(),
        });
    }

    // 5. Pure numeric -> TCP on 127.0.0.1
    let trimmed = listen.trim();
    if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
        // JS parseInt clamps oversized values differently, but the TS server
        // ultimately binds via Node which rejects out-of-range ports. We treat
        // an out-of-range port as invalid rather than silently truncating.
        let port = trimmed
            .parse::<u16>()
            .map_err(|_| ListenParseError::InvalidPort(listen.to_string()))?;
        return Ok(ListenTarget::Tcp {
            host: "127.0.0.1".to_string(),
            port,
        });
    }

    // 6. host:port -> TCP
    if let Some(idx) = listen.find(':') {
        let host = &listen[..idx];
        let port_str = &listen[idx + 1..];
        let port = port_str
            .parse::<u16>()
            .map_err(|_| ListenParseError::InvalidPort(listen.to_string()))?;
        let host = if host.is_empty() { "127.0.0.1" } else { host };
        return Ok(ListenTarget::Tcp {
            host: host.to_string(),
            port,
        });
    }

    Err(ListenParseError::Invalid(listen.to_string()))
}

/// Format a listen target back to its canonical string, matching
/// `formatListenTarget` in `bootstrap.ts`.
pub fn format_listen_target(target: &ListenTarget) -> String {
    match target {
        ListenTarget::Tcp { host, port } => format!("{host}:{port}"),
        ListenTarget::Socket { path } | ListenTarget::Pipe { path } => path.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pure_port() {
        assert_eq!(
            parse_listen_string("7767").unwrap(),
            ListenTarget::Tcp {
                host: "127.0.0.1".into(),
                port: 7767
            }
        );
    }

    #[test]
    fn parses_host_port() {
        assert_eq!(
            parse_listen_string("0.0.0.0:7767").unwrap(),
            ListenTarget::Tcp {
                host: "0.0.0.0".into(),
                port: 7767
            }
        );
    }

    #[test]
    fn empty_host_defaults_to_loopback() {
        assert_eq!(
            parse_listen_string(":7767").unwrap(),
            ListenTarget::Tcp {
                host: "127.0.0.1".into(),
                port: 7767
            }
        );
    }

    #[test]
    fn parses_unix_socket() {
        assert_eq!(
            parse_listen_string("unix:///tmp/rocky.sock").unwrap(),
            ListenTarget::Socket {
                path: "/tmp/rocky.sock".into()
            }
        );
    }

    #[test]
    fn parses_posix_absolute_path_socket() {
        assert_eq!(
            parse_listen_string("/tmp/rocky.sock").unwrap(),
            ListenTarget::Socket {
                path: "/tmp/rocky.sock".into()
            }
        );
    }

    #[test]
    fn parses_named_pipe() {
        assert_eq!(
            parse_listen_string("pipe://rocky").unwrap(),
            ListenTarget::Pipe {
                path: "rocky".into()
            }
        );
    }

    #[test]
    fn rejects_windows_drive_path() {
        assert_eq!(
            parse_listen_string("C:\\rocky"),
            Err(ListenParseError::WindowsPath("C:\\rocky".into()))
        );
    }

    #[test]
    fn rejects_invalid_port() {
        assert_eq!(
            parse_listen_string("localhost:notaport"),
            Err(ListenParseError::InvalidPort("localhost:notaport".into()))
        );
    }

    #[test]
    fn round_trips_tcp() {
        let target = parse_listen_string("127.0.0.1:7767").unwrap();
        assert_eq!(format_listen_target(&target), "127.0.0.1:7767");
    }
}
