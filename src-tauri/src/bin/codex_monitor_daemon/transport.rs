use super::rpc::{
    build_error_response, build_result_response, forward_events, parse_auth_token,
    spawn_rpc_response_task,
};
use super::*;
use futures_util::future::{select, Either};
use tokio::io::{AsyncBufRead, Lines};
use tokio::sync::oneshot;

async fn next_client_line<R>(
    lines: &mut Lines<R>,
    writer_closed: &mut oneshot::Receiver<()>,
) -> std::io::Result<Option<String>>
where
    R: AsyncBufRead + Unpin,
{
    let next_line = lines.next_line();
    futures_util::pin_mut!(next_line);
    match select(next_line, writer_closed).await {
        Either::Left((line, _)) => line,
        Either::Right((_, _)) => Ok(None),
    }
}

pub(super) async fn handle_client(
    socket: TcpStream,
    config: Arc<DaemonConfig>,
    state: Arc<DaemonState>,
    events: broadcast::Sender<DaemonEvent>,
) {
    let _ = socket.set_nodelay(true);
    let (reader, mut writer) = socket.into_split();
    let mut lines = BufReader::new(reader).lines();

    let (out_tx, mut out_rx) = mpsc::channel::<String>(REMOTE_CLIENT_OUTBOUND_QUEUE_CAPACITY);
    let (writer_closed_tx, mut writer_closed_rx) = oneshot::channel();
    let write_task = tokio::spawn(async move {
        while let Some(message) = out_rx.recv().await {
            if writer.write_all(message.as_bytes()).await.is_err() {
                break;
            }
            if writer.write_all(b"\n").await.is_err() {
                break;
            }
        }
        let _ = writer_closed_tx.send(());
    });

    let mut authenticated = config.token.is_none();
    let mut events_task: Option<tokio::task::JoinHandle<()>> = None;
    let heartbeat_task = {
        let out_tx_heartbeat = out_tx.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            loop {
                interval.tick().await;
                let payload = json!({
                    "method": "remote/heartbeat",
                    "params": {}
                });
                let Ok(message) = serde_json::to_string(&payload) else {
                    continue;
                };
                if out_tx_heartbeat.send(message).await.is_err() {
                    break;
                }
            }
        })
    };
    let request_limiter = Arc::new(Semaphore::new(MAX_IN_FLIGHT_RPC_PER_CONNECTION));
    let client_version = format!("daemon-{}", env!("CARGO_PKG_VERSION"));

    if authenticated {
        let rx = events.subscribe();
        let out_tx_events = out_tx.clone();
        events_task = Some(tokio::spawn(forward_events(rx, out_tx_events)));
    }

    while let Ok(Some(line)) = next_client_line(&mut lines, &mut writer_closed_rx).await {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let id = message.get("id").and_then(|value| value.as_u64());
        let method = message
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);

        if !authenticated {
            if method != "auth" {
                if let Some(response) = build_error_response(id, "unauthorized") {
                    if out_tx.send(response).await.is_err() {
                        break;
                    }
                }
                continue;
            }

            let expected = config.token.clone().unwrap_or_default();
            let provided = parse_auth_token(&params).unwrap_or_default();
            if expected != provided {
                if let Some(response) = build_error_response(id, "invalid token") {
                    if out_tx.send(response).await.is_err() {
                        break;
                    }
                }
                continue;
            }

            authenticated = true;
            if let Some(response) = build_result_response(id, json!({ "ok": true })) {
                if out_tx.send(response).await.is_err() {
                    break;
                }
            }

            let rx = events.subscribe();
            let out_tx_events = out_tx.clone();
            events_task = Some(tokio::spawn(forward_events(rx, out_tx_events)));

            continue;
        }

        spawn_rpc_response_task(
            Arc::clone(&state),
            out_tx.clone(),
            id,
            method,
            params,
            client_version.clone(),
            Arc::clone(&request_limiter),
        );
    }

    drop(out_tx);
    if let Some(task) = events_task {
        task.abort();
    }
    heartbeat_task.abort();
    write_task.abort();
}

#[cfg(test)]
mod tests {
    use super::next_client_line;
    use tokio::io::{duplex, AsyncBufReadExt, BufReader};
    use tokio::sync::oneshot;
    use tokio::time::{timeout, Duration};

    #[test]
    fn writer_shutdown_interrupts_an_idle_client_reader() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
            .block_on(async {
                let (reader, _peer) = duplex(64);
                let mut lines = BufReader::new(reader).lines();
                let (writer_closed_tx, mut writer_closed_rx) = oneshot::channel();
                writer_closed_tx.send(()).expect("signal writer shutdown");

                let line = timeout(
                    Duration::from_millis(25),
                    next_client_line(&mut lines, &mut writer_closed_rx),
                )
                .await
                .expect("writer shutdown should interrupt idle read")
                .expect("client read result");

                assert_eq!(line, None);
            });
    }
}
