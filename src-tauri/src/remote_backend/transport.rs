use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, Lines,
};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;

use super::protocol::{parse_incoming_line, IncomingMessage, DISCONNECTED_MESSAGE};

pub(crate) type PendingMap = HashMap<u64, oneshot::Sender<Result<Value, String>>>;
const OUTBOUND_QUEUE_CAPACITY: usize = 512;
const REMOTE_INBOUND_IDLE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Debug)]
pub(crate) enum RemoteTransportConfig {
    Tcp {
        host: String,
        auth_token: Option<String>,
    },
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) enum RemoteTransportKind {
    Tcp,
}

impl RemoteTransportConfig {
    pub(crate) fn kind(&self) -> RemoteTransportKind {
        match self {
            RemoteTransportConfig::Tcp { .. } => RemoteTransportKind::Tcp,
        }
    }

    pub(crate) fn auth_token(&self) -> Option<&str> {
        match self {
            RemoteTransportConfig::Tcp { auth_token, .. } => auth_token.as_deref(),
        }
    }
}

pub(crate) struct TransportConnection {
    pub(crate) out_tx: mpsc::Sender<String>,
    pub(crate) pending: Arc<Mutex<PendingMap>>,
    pub(crate) connected: Arc<AtomicBool>,
}

pub(crate) type TransportFuture =
    Pin<Box<dyn Future<Output = Result<TransportConnection, String>> + Send>>;

pub(crate) trait RemoteTransport: Send + Sync {
    fn connect(&self, app: AppHandle, config: RemoteTransportConfig) -> TransportFuture;
}

pub(crate) fn spawn_transport_io<R, W>(
    app: AppHandle,
    reader: R,
    mut writer: W,
) -> TransportConnection
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (out_tx, mut out_rx) = mpsc::channel::<String>(OUTBOUND_QUEUE_CAPACITY);
    let pending = Arc::new(Mutex::new(PendingMap::new()));
    let pending_for_writer = Arc::clone(&pending);
    let pending_for_reader = Arc::clone(&pending);

    let connected = Arc::new(AtomicBool::new(true));
    let connected_for_writer = Arc::clone(&connected);
    let connected_for_reader = Arc::clone(&connected);
    let app_for_writer = app.clone();

    tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if writer.write_all(message.as_bytes()).await.is_err()
                || writer.write_all(b"\n").await.is_err()
            {
                if mark_disconnected(&pending_for_writer, &connected_for_writer).await {
                    emit_remote_backend_event_gap(&app_for_writer, "disconnected", None);
                }
                break;
            }
        }
    });

    tokio::spawn(async move {
        read_loop(app, reader, pending_for_reader, connected_for_reader).await;
    });

    TransportConnection {
        out_tx,
        pending,
        connected,
    }
}

async fn read_loop<R>(
    app: AppHandle,
    reader: R,
    pending: Arc<Mutex<PendingMap>>,
    connected: Arc<AtomicBool>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    let mut lines = BufReader::new(reader).lines();
    let mut heartbeat_observed = false;

    loop {
        let next_line = if heartbeat_observed {
            next_line_until_idle(&mut lines, REMOTE_INBOUND_IDLE_TIMEOUT).await
        } else {
            lines.next_line().await.ok().flatten()
        };
        let Some(line) = next_line else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        heartbeat_observed |= dispatch_incoming_line(&app, &pending, trimmed).await;
    }

    if mark_disconnected(&pending, &connected).await {
        emit_remote_backend_event_gap(&app, "disconnected", None);
    }
}

async fn next_line_until_idle<R>(lines: &mut Lines<R>, idle_timeout: Duration) -> Option<String>
where
    R: AsyncBufRead + Unpin,
{
    match timeout(idle_timeout, lines.next_line()).await {
        Ok(Ok(Some(line))) => Some(line),
        _ => None,
    }
}

fn emit_remote_backend_event_gap(app: &AppHandle, reason: &str, skipped: Option<u64>) {
    let payload = match skipped {
        Some(skipped) => json!({ "reason": reason, "skipped": skipped }),
        None => json!({ "reason": reason }),
    };
    let _ = app.emit("remote-backend-event-gap", payload);
}

pub(crate) async fn dispatch_incoming_line(
    app: &AppHandle,
    pending: &Arc<Mutex<PendingMap>>,
    line: &str,
) -> bool {
    let Some(message) = parse_incoming_line(line) else {
        return false;
    };

    match message {
        IncomingMessage::Response { id, payload } => {
            let sender = pending.lock().await.remove(&id);
            if let Some(sender) = sender {
                let _ = sender.send(payload);
            }
            false
        }
        IncomingMessage::Notification { method, params } => {
            let is_heartbeat = method == "remote/heartbeat";
            match method.as_str() {
                "app-server-event" => {
                    let _ = app.emit("app-server-event", params);
                }
                "terminal-output" => {
                    let _ = app.emit("terminal-output", params);
                }
                "terminal-exit" => {
                    let _ = app.emit("terminal-exit", params);
                }
                "remote/events_lagged" => {
                    let skipped = params.get("skipped").and_then(Value::as_u64);
                    emit_remote_backend_event_gap(app, "lagged", skipped);
                }
                _ => {}
            }
            is_heartbeat
        }
    }
}

pub(crate) async fn mark_disconnected(
    pending: &Arc<Mutex<PendingMap>>,
    connected: &Arc<AtomicBool>,
) -> bool {
    let was_connected = connected.swap(false, Ordering::SeqCst);
    let mut pending = pending.lock().await;
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(DISCONNECTED_MESSAGE.to_string()));
    }
    was_connected
}

#[cfg(test)]
mod tests {
    use super::{mark_disconnected, next_line_until_idle, PendingMap};
    use crate::remote_backend::protocol::DISCONNECTED_MESSAGE;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{duplex, AsyncBufReadExt, BufReader};
    use tokio::sync::{oneshot, Mutex};

    #[test]
    fn inbound_idle_timeout_detects_a_half_open_transport() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(async {
                let (reader, _writer) = duplex(64);
                let mut lines = BufReader::new(reader).lines();

                assert_eq!(
                    next_line_until_idle(&mut lines, Duration::from_millis(10)).await,
                    None
                );
            });
    }

    #[test]
    fn disconnect_transition_is_reported_once_and_fails_pending_requests() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(async {
                let pending = Arc::new(Mutex::new(PendingMap::new()));
                let connected = Arc::new(AtomicBool::new(true));
                let (sender, receiver) = oneshot::channel();
                pending.lock().await.insert(7, sender);

                assert!(mark_disconnected(&pending, &connected).await);
                assert_eq!(
                    receiver.await.expect("pending response"),
                    Err(DISCONNECTED_MESSAGE.to_string())
                );
                assert!(!mark_disconnected(&pending, &connected).await);
            });
    }
}
