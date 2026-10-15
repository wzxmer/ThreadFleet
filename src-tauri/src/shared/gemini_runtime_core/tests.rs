use super::*;
use crate::backend::events::{TerminalExit, TerminalOutput};
use crate::shared::process_core::tokio_command;
use std::fs;
use std::sync::Mutex as TestMutex;

#[derive(Clone, Default)]
struct Sink(Arc<TestMutex<Vec<AppServerEvent>>>);

impl EventSink for Sink {
    fn emit_app_server_event(&self, event: AppServerEvent) {
        self.0.lock().unwrap().push(event);
    }
    fn emit_terminal_output(&self, _: TerminalOutput) {}
    fn emit_terminal_exit(&self, _: TerminalExit) {}
}

impl Sink {
    fn events(&self) -> Vec<Value> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.message.clone())
            .collect()
    }
    async fn wait(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(event) = self.events().iter().find(|event| predicate(event)) {
                    return event.clone();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("mock ACP event did not arrive")
    }
}

struct Fixture {
    root: PathBuf,
    executable: PathBuf,
    script: PathBuf,
    trace: PathBuf,
}

impl Fixture {
    fn new(scenario: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("threadfleet-gemini-acp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let script = root.join("mock.cjs");
        let trace = root.join("trace.jsonl");
        #[cfg(windows)]
        let executable = root.join("gemini.cmd");
        #[cfg(not(windows))]
        let executable = root.join("gemini");
        let fixture = Self {
            root,
            executable,
            script,
            trace,
        };
        fixture.scenario(scenario);
        #[cfg(windows)]
        fs::write(
            &fixture.executable,
            format!("@echo off\r\nnode \"{}\" %*\r\n", fixture.script.display()),
        )
        .unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(
                &fixture.executable,
                format!(
                    "#!/usr/bin/env node\nrequire({});\n",
                    serde_json::to_string(&fixture.script.to_string_lossy()).unwrap()
                ),
            )
            .unwrap();
            fs::set_permissions(&fixture.executable, fs::Permissions::from_mode(0o700)).unwrap();
        }
        fixture
    }
    fn scenario(&self, scenario: &str) {
        fs::write(
            &self.script,
            MOCK.replace("__SCENARIO__", &serde_json::to_string(scenario).unwrap())
                .replace(
                    "__TRACE__",
                    &serde_json::to_string(&self.trace.to_string_lossy()).unwrap(),
                ),
        )
        .unwrap();
    }
    fn runtime(&self) -> GeminiRuntime {
        GeminiRuntime::new(self.root.join("tf-data"))
    }
    fn cwd(&self) -> &str {
        self.root.to_str().unwrap()
    }
    fn bin(&self) -> Option<String> {
        Some(self.executable.to_string_lossy().into_owned())
    }
    fn requests(&self) -> Vec<Value> {
        fs::read_to_string(&self.trace)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
    async fn request(
        &self,
        runtime: &GeminiRuntime,
        operation: &str,
        params: Value,
        sink: &Sink,
    ) -> Result<Value, String> {
        runtime
            .request(
                "workspace",
                self.cwd(),
                self.bin(),
                operation,
                params,
                sink.clone(),
            )
            .await
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn run(test: impl std::future::Future<Output = ()>) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(test);
}

#[test]
fn acp_round_trip_streams_utf8_tools_and_explicit_thread_scoped_approval() {
    run(async {
        let fixture = Fixture::new("approval");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let started = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let id = started["thread"]["id"].as_str().unwrap();
        assert!(id.starts_with("gemini:"));
        assert_eq!(started["thread"]["engine"], "gemini");
        let sent = fixture
            .request(
                &runtime,
                "send",
                json!({"threadId":id,"text":"hello","model":"gemini-test"}),
                &sink,
            )
            .await
            .unwrap();
        let turn_id = sent["turn"]["id"].as_str().unwrap();
        assert!(turn_id.starts_with("gemini:turn:"));
        let approval = sink
            .wait(|event| event["method"] == "item/commandExecution/requestApproval")
            .await;
        let request_id = approval["id"].as_str().unwrap();
        assert!(request_id.starts_with(&format!("{id}:approval:")));
        assert_eq!(approval["params"]["threadId"], id);
        assert_eq!(approval["params"]["turnId"], turn_id);
        assert!(!fixture
            .requests()
            .iter()
            .any(|request| request.get("result").is_some()));
        let wrong = runtime
            .request(
                "other-workspace",
                fixture.cwd(),
                fixture.bin(),
                "respond",
                json!({"requestId":request_id,"result":{"decision":"accept"}}),
                sink.clone(),
            )
            .await;
        assert!(wrong.unwrap_err().contains("not pending in this workspace"));
        let overlap = fixture
            .request(
                &runtime,
                "send",
                json!({"threadId":id,"text":"overlap"}),
                &sink,
            )
            .await;
        assert!(overlap.unwrap_err().contains("already generating"));
        fixture
            .request(
                &runtime,
                "respond",
                json!({"requestId":request_id,"result":{"decision":"accept"}}),
                &sink,
            )
            .await
            .unwrap();
        sink.wait(|event| {
            event["method"] == "turn/completed" && event["params"]["turn"]["id"] == turn_id
        })
        .await;
        let history = fixture
            .request(&runtime, "read", json!({"threadId":id}), &sink)
            .await
            .unwrap();
        let items = history["thread"]["turns"][0]["items"].as_array().unwrap();
        assert_eq!(
            items
                .iter()
                .filter(|item| item["type"] == "userMessage")
                .count(),
            1
        );
        assert!(items
            .iter()
            .any(|item| item["type"] == "reasoning" && item["content"] == "思考🙂"));
        assert!(items.iter().any(|item| item["type"] == "commandExecution"
            && item["status"] == "completed"
            && item["aggregatedOutput"] == "approved:proceed_once"));
        assert!(items
            .iter()
            .any(|item| item["phase"] == "final_answer" && item["text"] == "完成🙂"));
        assert!(fixture.requests().iter().any(|request| request
            .pointer("/result/outcome/optionId")
            .and_then(Value::as_str)
            == Some("proceed_once")));
        assert!(!fixture
            .requests()
            .iter()
            .any(|request| request["method"] == "authenticate"));
        assert!(sink
            .0
            .lock()
            .unwrap()
            .iter()
            .all(|event| event.workspace_id == "workspace"
                || event.message["method"] != "turn/started"));
        runtime.shutdown().await;
    });
}

#[test]
fn acp_cancel_resolves_pending_approval_and_preserves_partial_output() {
    run(async {
        let fixture = Fixture::new("approval");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let started = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let id = started["thread"]["id"].as_str().unwrap();
        let sent = fixture
            .request(
                &runtime,
                "send",
                json!({"threadId":id,"text":"cancel"}),
                &sink,
            )
            .await
            .unwrap();
        let turn_id = sent["turn"]["id"].as_str().unwrap();
        let approval = sink
            .wait(|event| event["method"] == "item/commandExecution/requestApproval")
            .await;
        let wrong_turn = fixture
            .request(
                &runtime,
                "interrupt",
                json!({"threadId":id,"turnId":"gemini:turn:wrong"}),
                &sink,
            )
            .await
            .unwrap_err();
        assert!(wrong_turn.contains("different turn"));
        fixture
            .request(
                &runtime,
                "interrupt",
                json!({"threadId":id,"turnId":turn_id}),
                &sink,
            )
            .await
            .unwrap();
        let completed = sink.wait(|event| event["method"] == "turn/completed").await;
        assert_eq!(completed["params"]["turn"]["status"], "interrupted");
        assert!(fixture.requests().iter().any(|request| request
            .pointer("/result/outcome/outcome")
            .and_then(Value::as_str)
            == Some("cancelled")));
        assert!(fixture
            .requests()
            .iter()
            .any(|request| request["method"] == "session/cancel"));
        assert!(sink
            .events()
            .iter()
            .any(|event| event["method"] == "serverRequest/resolved"
                && event["params"]["requestId"] == approval["id"]));
        let stale = fixture
            .request(
                &runtime,
                "respond",
                json!({"requestId":approval["id"],"result":{"decision":"accept"}}),
                &sink,
            )
            .await
            .unwrap_err();
        assert!(stale.contains("not pending"));
        let read = fixture
            .request(&runtime, "read", json!({"threadId":id}), &sink)
            .await
            .unwrap();
        assert!(read["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["text"] == "准备执行"));
        runtime.shutdown().await;
    });
}

#[test]
fn acp_process_failure_finalizes_turn_and_keeps_history() {
    run(async {
        let fixture = Fixture::new("failure");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let started = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let id = started["thread"]["id"].as_str().unwrap();
        fixture
            .request(
                &runtime,
                "send",
                json!({"threadId":id,"text":"crash"}),
                &sink,
            )
            .await
            .unwrap();
        let failed = sink.wait(|event| event["method"] == "turn/completed").await;
        assert_eq!(failed["params"]["turn"]["status"], "failed");
        assert!(sink.events().iter().any(|event| event["method"] == "error"));
        let read = fixture
            .request(&runtime, "read", json!({"threadId":id}), &sink)
            .await
            .unwrap();
        assert_eq!(read["thread"]["turns"][0]["status"], "failed");
        assert_eq!(read["thread"]["status"]["type"], "idle");
        assert!(read["thread"]["turns"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["text"] == "准备执行"));
        runtime.shutdown().await;
    });
}

#[test]
fn acp_restart_uses_native_load_without_duplicating_history_and_checks_capability() {
    run(async {
        let fixture = Fixture::new("simple");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let started = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let id = started["thread"]["id"].as_str().unwrap().to_string();
        fixture
            .request(
                &runtime,
                "send",
                json!({"threadId":id,"text":"persist"}),
                &sink,
            )
            .await
            .unwrap();
        sink.wait(|event| event["method"] == "turn/completed").await;
        let before = fixture
            .request(&runtime, "read", json!({"threadId":id}), &sink)
            .await
            .unwrap();
        runtime.shutdown().await;
        let restored = fixture.runtime();
        let restored_sink = Sink::default();
        let resumed = fixture
            .request(&restored, "resume", json!({"threadId":id}), &restored_sink)
            .await
            .unwrap();
        assert_eq!(resumed["thread"]["turns"], before["thread"]["turns"]);
        assert!(!restored_sink.events().iter().any(|event| matches!(
            event["method"].as_str(),
            Some("item/started" | "item/agentMessage/delta" | "turn/started")
        )));
        assert!(fixture
            .requests()
            .iter()
            .any(|request| request["method"] == "session/load"));
        restored.shutdown().await;
        fixture.scenario("no-load");
        let old_cli = fixture.runtime();
        let error = fixture
            .request(&old_cli, "resume", json!({"threadId":id}), &restored_sink)
            .await
            .unwrap_err();
        assert!(error.contains("loadSession is unavailable"));
        let history = fixture
            .request(&old_cli, "read", json!({"threadId":id}), &restored_sink)
            .await
            .unwrap();
        assert_eq!(history["thread"]["turns"], before["thread"]["turns"]);
        old_cli.shutdown().await;
    });
}

#[test]
fn acp_model_discovery_has_no_hidden_tf_thread_or_model_prompt() {
    run(async {
        let fixture = Fixture::new("simple");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let models = fixture
            .request(&runtime, "models", json!({"threadId":null}), &sink)
            .await
            .unwrap();
        assert_eq!(models["currentModelId"], "gemini-test");
        assert_eq!(models["availableModels"][0]["modelId"], "gemini-test");
        let list = fixture
            .request(&runtime, "list", json!({}), &sink)
            .await
            .unwrap();
        assert_eq!(list["data"], json!([]));
        let cached = fixture
            .request(&runtime, "models", json!({}), &sink)
            .await
            .unwrap();
        assert_eq!(models, cached);
        assert_eq!(
            fixture
                .requests()
                .iter()
                .filter(|request| request["method"] == "session/new")
                .count(),
            1
        );
        assert!(!fixture
            .requests()
            .iter()
            .any(|request| request["method"] == "session/prompt"
                || request["method"] == "authenticate"));
        assert!(!fixture
            .root
            .join("tf-data/gemini-runtime/threads.json")
            .exists());
        runtime.shutdown().await;
    });
}

#[test]
fn acp_auth_required_leaves_no_tf_session_and_never_starts_login() {
    run(async {
        let fixture = Fixture::new("auth");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let error = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap_err();
        assert!(error.contains("Gemini authentication required"));
        assert_eq!(
            fixture
                .request(&runtime, "list", json!({}), &sink)
                .await
                .unwrap()["data"],
            json!([])
        );
        assert!(!fixture
            .requests()
            .iter()
            .any(|request| request["method"] == "authenticate"));
        runtime.shutdown().await;
    });
}

#[test]
fn acp_timeout_terminates_owned_process_and_rejects_late_requests() {
    run(async {
        let fixture = Fixture::new("timeout");
        let mut command = tokio_command("node");
        command.arg(&fixture.script);
        let connection = AcpConnection::spawn_command(
            command,
            Arc::new(HistoryStore::new(fixture.root.join("data"))),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let error = connection
            .call(
                "initialize",
                json!({"protocolVersion":1}),
                Duration::from_millis(150),
            )
            .await
            .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(connection.is_closed());
        assert!(connection
            .call("session/new", json!({}), Duration::from_secs(1))
            .await
            .unwrap_err()
            .contains("no longer running"));
    });
}

#[test]
fn gemini_history_paging_bounds_items_and_rejects_foreign_cursor() {
    let thread = json!({"id":"gemini:session","turns":[
        {"id":"t1","items":[{"id":"a"},{"id":"b"}]},
        {"id":"t2","items":[{"id":"c"},{"id":"d"},{"id":"e"}]},
    ]});
    let latest = history_page(thread.clone(), &json!({"itemLimit":2})).unwrap();
    assert_eq!(latest["codexMonitorHistoryPage"]["itemCount"], 2);
    assert_eq!(
        latest["thread"]["turns"][0]["items"],
        json!([{"id":"d"},{"id":"e"}])
    );
    let older = history_page(
        thread.clone(),
        &json!({"itemLimit":2,"cursor":latest["codexMonitorHistoryPage"]["nextCursor"]}),
    )
    .unwrap();
    assert_eq!(older["thread"]["turns"][0]["items"], json!([{"id":"b"}]));
    assert_eq!(older["thread"]["turns"][1]["items"], json!([{"id":"c"}]));
    let oldest = history_page(
        thread.clone(),
        &json!({"cursor":older["codexMonitorHistoryPage"]["nextCursor"]}),
    )
    .unwrap();
    assert_eq!(oldest["thread"]["turns"][0]["items"], json!([{"id":"a"}]));
    assert_eq!(oldest["codexMonitorHistoryPage"]["hasMore"], false);
    let foreign = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({"threadId":"gemini:other","beforeItemId":"d"})).unwrap(),
    );
    assert!(history_page(thread, &json!({"cursor":foreign}))
        .unwrap_err()
        .contains("another session"));
}

#[test]
fn gemini_workspace_ownership_and_archiving_do_not_touch_native_history() {
    run(async {
        let fixture = Fixture::new("simple");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let start = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let id = start["thread"]["id"].as_str().unwrap();
        let wrong = runtime
            .request(
                "wrong",
                fixture.cwd(),
                fixture.bin(),
                "read",
                json!({"threadId":id}),
                sink.clone(),
            )
            .await
            .unwrap_err();
        assert!(wrong.contains("different workspace"));
        let codex = fixture
            .request(&runtime, "read", json!({"threadId":"codex-session"}), &sink)
            .await
            .unwrap_err();
        assert!(codex.contains("Namespaced Gemini thread"));
        fixture
            .request(
                &runtime,
                "rename",
                json!({"threadId":id,"name":"Renamed"}),
                &sink,
            )
            .await
            .unwrap();
        fixture
            .request(&runtime, "archive", json!({"threadId":id}), &sink)
            .await
            .unwrap();
        assert_eq!(
            fixture
                .request(&runtime, "list", json!({}), &sink)
                .await
                .unwrap()["data"],
            json!([])
        );
        assert_eq!(
            fixture
                .request(&runtime, "read", json!({"threadId":id}), &sink)
                .await
                .unwrap()["thread"]["name"],
            "Renamed"
        );
        assert!(!fixture.requests().iter().any(|request| request["method"]
            .as_str()
            .is_some_and(|method| method.contains("delete") || method == "session/close")));
        runtime.shutdown().await;
    });
}

#[test]
fn gemini_artifact_context_reaches_prompt_without_changing_user_history() {
    run(async {
        let (prompt, user, text) = build_prompt(
            &json!({"text":"hello", "artifactContext":"Store artifacts in /task-output"}),
            "/workspace", &json!({}),
        ).await.unwrap();
        assert_eq!(prompt[0]["text"], "Store artifacts in /task-output");
        assert_eq!(prompt[1]["text"], "hello");
        assert_eq!(user, vec![json!({"type":"text", "text":"hello"})]);
        assert_eq!(text, "hello");
        assert!(build_prompt(&json!({"artifactContext":"output policy"}), "/workspace", &json!({})).await.is_err());
    });
}

#[test]
fn gemini_prompt_capabilities_and_read_only_mode_fail_before_prompt_execution() {
    run(async {
        let fixture = Fixture::new("no-plan");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let start = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let id = start["thread"]["id"].as_str().unwrap();
        let readonly = fixture
            .request(
                &runtime,
                "send",
                json!({"threadId":id,"text":"hello","accessMode":"read-only"}),
                &sink,
            )
            .await
            .unwrap_err();
        assert!(readonly.contains("'plan' approval mode"));
        let model = fixture
            .request(
                &runtime,
                "send",
                json!({"threadId":id,"text":"hello","model":"codex-model"}),
                &sink,
            )
            .await
            .unwrap_err();
        assert!(model.contains("does not advertise model"));
        let images = build_prompt(
            &json!({"text":"hello","images":["data:image/png;base64,aA=="]}),
            fixture.cwd(),
            &json!({"image":false}),
        )
        .await
        .unwrap_err();
        assert!(images.contains("does not support image prompts"));
        assert!(!fixture
            .requests()
            .iter()
            .any(|request| request["method"] == "session/prompt"));
        assert!(fixture
            .requests()
            .iter()
            .filter(|request| request["method"] == "session/set_mode")
            .all(|request| request["params"]["modeId"] == "default"));
        runtime.shutdown().await;
    });
}

#[test]
fn acp_stop_before_prompt_write_prevents_model_execution() {
    run(async {
        let fixture = Fixture::new("simple");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let start = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let id = start["thread"]["id"].as_str().unwrap();
        let session = runtime.running_session(id).await.unwrap().unwrap();
        let turn = session
            .connection
            .begin_turn(
                "cancel early",
                vec![json!({"type":"text","text":"cancel early"})],
            )
            .await
            .unwrap();
        let turn_id = turn["id"].as_str().unwrap();
        session.connection.cancel(Some(turn_id)).await.unwrap();
        let response = session
            .connection
            .start_prompt(turn_id, vec![json!({"type":"text","text":"cancel early"})])
            .await
            .unwrap();
        assert!(response.is_none());
        session
            .connection
            .finish_turn(turn_id, Ok(json!({"stopReason":"cancelled"})))
            .await;
        assert!(!fixture
            .requests()
            .iter()
            .any(|request| request["method"] == "session/prompt"));
        assert_eq!(
            fixture
                .request(&runtime, "read", json!({"threadId":id}), &sink)
                .await
                .unwrap()["thread"]["turns"][0]["status"],
            "interrupted"
        );
        runtime.shutdown().await;
    });
}

#[test]
fn acp_distinct_sessions_generate_concurrently_with_correct_event_routing() {
    run(async {
        let fixture = Fixture::new("simple");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let first = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let second = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let first_id = first["thread"]["id"].as_str().unwrap();
        let second_id = second["thread"]["id"].as_str().unwrap();
        assert_ne!(first_id, second_id);
        let (first_turn, second_turn) = futures_util::future::join(
            fixture.request(
                &runtime,
                "send",
                json!({"threadId":first_id,"text":"first"}),
                &sink,
            ),
            fixture.request(
                &runtime,
                "send",
                json!({"threadId":second_id,"text":"second"}),
                &sink,
            ),
        )
        .await;
        let first_turn = first_turn.unwrap();
        let second_turn = second_turn.unwrap();
        for (id, turn) in [(first_id, &first_turn), (second_id, &second_turn)] {
            sink.wait(|event| {
                event["method"] == "turn/completed" && event["params"]["threadId"] == id
            })
            .await;
            assert!(sink
                .events()
                .iter()
                .filter(|event| event["params"]["turnId"] == turn["turn"]["id"])
                .all(|event| event["params"]["threadId"] == id));
            let history = fixture
                .request(&runtime, "read", json!({"threadId":id}), &sink)
                .await
                .unwrap();
            assert_eq!(history["thread"]["turns"][0]["status"], "completed");
        }
        runtime.shutdown().await;
    });
}

#[test]
fn gemini_history_uses_separate_transcripts_and_recovers_interrupted_tool_state() {
    let fixture = Fixture::new("simple");
    let directory = fixture.root.join("tf-data");
    let history = HistoryStore::new(directory.clone());
    for index in 0..12 {
        let native_id = format!("session-{index}");
        let mut stored = make_thread("workspace", fixture.cwd(), &native_id, &json!({}), "");
        stored.thread["turns"] = json!([{"id":format!("turn-{index}"),"status":"completed","items":[{"id":"message","type":"agentMessage","text":"saved transcript"}]}]);
        history.insert(stored).unwrap();
    }
    // Opening old sessions after idle cache eviction loads their own files.
    for index in 0..12 {
        assert_eq!(
            history
                .get(
                    "workspace",
                    fixture.cwd(),
                    &format!("gemini:session-{index}")
                )
                .unwrap()
                .thread["turns"][0]["items"][0]["text"],
            "saved transcript"
        );
    }
    let index: Value =
        serde_json::from_slice(&fs::read(directory.join("gemini-runtime/threads.json")).unwrap())
            .unwrap();
    assert!(index["threads"]
        .as_object()
        .unwrap()
        .values()
        .all(|stored| stored["thread"].get("turns").is_none()));
    assert_eq!(
        fs::read_dir(directory.join("gemini-runtime/sessions"))
            .unwrap()
            .count(),
        12
    );
    history.update("gemini:session-0", true, |stored| {
        stored.thread["status"] = json!({"type":"active"});
        stored.thread["turns"] = json!([{"id":"unfinished","status":"inProgress","items":[{"id":"tool","type":"commandExecution","status":"inProgress"}]}]);
        Ok(())
    }).unwrap();
    let restored = HistoryStore::new(directory);
    let recovered = restored
        .get("workspace", fixture.cwd(), "gemini:session-0")
        .unwrap();
    assert_eq!(recovered.thread["turns"][0]["status"], "interrupted");
    assert_eq!(
        recovered.thread["turns"][0]["items"][0]["status"],
        "declined"
    );
    assert_eq!(recovered.thread["status"]["type"], "idle");
}

#[test]
fn acp_workspace_shutdown_stops_only_owned_session_and_retains_transcript() {
    run(async {
        let fixture = Fixture::new("approval");
        let runtime = fixture.runtime();
        let sink = Sink::default();
        let first = fixture
            .request(&runtime, "start", json!({}), &sink)
            .await
            .unwrap();
        let second = runtime
            .request(
                "other",
                fixture.cwd(),
                fixture.bin(),
                "start",
                json!({}),
                sink.clone(),
            )
            .await
            .unwrap();
        let first_id = first["thread"]["id"].as_str().unwrap();
        let second_id = second["thread"]["id"].as_str().unwrap();
        fixture
            .request(
                &runtime,
                "send",
                json!({"threadId":first_id,"text":"first"}),
                &sink,
            )
            .await
            .unwrap();
        runtime
            .request(
                "other",
                fixture.cwd(),
                fixture.bin(),
                "send",
                json!({"threadId":second_id,"text":"second"}),
                sink.clone(),
            )
            .await
            .unwrap();
        sink.wait(|event| {
            event["method"] == "item/commandExecution/requestApproval"
                && event["params"]["threadId"] == first_id
        })
        .await;
        let second_approval = sink
            .wait(|event| {
                event["method"] == "item/commandExecution/requestApproval"
                    && event["params"]["threadId"] == second_id
            })
            .await;
        runtime.shutdown_workspace("workspace").await;
        assert!(runtime.running_session(first_id).await.unwrap().is_none());
        assert!(runtime.running_session(second_id).await.unwrap().is_some());
        let first_read = fixture
            .request(&runtime, "read", json!({"threadId":first_id}), &sink)
            .await
            .unwrap();
        assert_eq!(first_read["thread"]["turns"][0]["status"], "interrupted");
        runtime
            .request(
                "other",
                fixture.cwd(),
                fixture.bin(),
                "respond",
                json!({"requestId":second_approval["id"],"result":{"decision":"accept"}}),
                sink.clone(),
            )
            .await
            .unwrap();
        let completed = sink
            .wait(|event| {
                event["method"] == "turn/completed" && event["params"]["threadId"] == second_id
            })
            .await;
        assert_eq!(completed["params"]["turn"]["status"], "completed");
        runtime.shutdown().await;
    });
}

const MOCK: &str = r#"
const fs = require('node:fs');
const crypto = require('node:crypto');
const readline = require('node:readline');
const scenario = __SCENARIO__;
const trace = __TRACE__;
let nativeId = null;
let pendingPrompt = null;
let approvalPending = false;
let writeQueue = Promise.resolve();
function send(message, fragments = false) {
  writeQueue = writeQueue.then(async () => {
    const buffer = Buffer.from(JSON.stringify({jsonrpc:'2.0', ...message}) + '\n');
    if (!fragments) { process.stdout.write(buffer); return; }
    // Split both JSON tokens and UTF-8 sequences to exercise NDJSON framing.
    for (let offset = 0; offset < buffer.length; offset += 7) {
      process.stdout.write(buffer.subarray(offset, offset + 7));
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  });
  return writeQueue;
}
const result = (id, value) => send({id, result:value});
const update = (update) => send({method:'session/update',params:{sessionId:nativeId,update}}, true);
function sessionResponse(includeId) {
  const availableModes = [{id:'default',name:'Default'},{id:'yolo',name:'YOLO'}];
  if (scenario !== 'no-plan') availableModes.push({id:'plan',name:'Read only'});
  return {
    ...(includeId ? {sessionId:nativeId} : {}),
    modes:{availableModes,currentModeId:'yolo'},
    models:{availableModels:[{modelId:'gemini-test',name:'Gemini Test'}],currentModelId:'gemini-test'},
  };
}
readline.createInterface({input:process.stdin}).on('line', async line => {
  const request = JSON.parse(line);
  fs.appendFileSync(trace, JSON.stringify(request) + '\n');
  if (!request.method) {
    if (!approvalPending || !pendingPrompt) return;
    approvalPending = false;
    const active = pendingPrompt;
    pendingPrompt = null;
    const outcome = request.result.outcome;
    const selected = outcome.outcome === 'selected' ? outcome.optionId : 'cancelled';
    if (selected === 'cancelled') { await result(active.id,{stopReason:'cancelled'}); return; }
    await update({sessionUpdate:'tool_call_update',toolCallId:'tool-1',status:'completed',kind:'execute',content:[{type:'content',content:{type:'text',text:'approved:' + selected}}]});
    await update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'完成'}});
    await update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'🙂'}});
    await result(active.id,{stopReason:'end_turn'});
    return;
  }
  if (request.method === 'initialize') {
    if (scenario === 'timeout') return;
    await result(request.id,{protocolVersion:1,agentCapabilities:{loadSession:scenario !== 'no-load',promptCapabilities:{image:true}},agentInfo:{name:'mock-gemini',version:'test'}});
  } else if (request.method === 'session/new') {
    if (scenario === 'auth') { await send({id:request.id,error:{code:-32000,message:'Authentication required'}}); return; }
    nativeId = crypto.randomUUID();
    await result(request.id,sessionResponse(true));
  } else if (request.method === 'session/load') {
    nativeId = request.params.sessionId;
    await update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'native user history'}});
    await update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'native assistant history'}});
    await result(request.id,sessionResponse(false));
  } else if (request.method === 'session/set_mode' || request.method === 'session/set_model') {
    await result(request.id,{});
  } else if (request.method === 'session/prompt') {
    pendingPrompt = request;
    await update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'思考🙂'}});
    await update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'准备执行'}});
    if (scenario === 'failure') { await writeQueue; process.exit(7); return; }
    if (scenario === 'simple') {
      pendingPrompt = null;
      await result(request.id,{stopReason:'end_turn'});
      return;
    }
    approvalPending = true;
    // Deliberately collide with the client's outstanding prompt request ID.
    await send({id:request.id,method:'session/request_permission',params:{sessionId:nativeId,
      toolCall:{toolCallId:'tool-1',kind:'execute',title:'echo test',status:'pending'},
      options:[{optionId:'proceed_always_and_save',kind:'allow_always',name:'Always'},{optionId:'proceed_once',kind:'allow_once',name:'Once'},{optionId:'cancel',kind:'reject_once',name:'Reject'}],
    }});
  } else if (request.method === 'session/cancel') {
    if (pendingPrompt) {
      const active = pendingPrompt; pendingPrompt = null; approvalPending = false;
      await result(active.id,{stopReason:'cancelled'});
    }
  } else if (Object.prototype.hasOwnProperty.call(request,'id')) {
    await send({id:request.id,error:{code:-32601,message:'Unknown mock method'}});
  }
});
"#;
