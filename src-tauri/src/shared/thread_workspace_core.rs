//! Workspace ownership is scoped to one app-server session/source. A caller or
//! the process-launch workspace is not evidence of a thread's project.
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

pub(crate) fn normalize_root_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let lower = normalized.to_ascii_lowercase();
    let normalized = if lower.starts_with("//?/unc/") {
        format!("//{}", &normalized[8..])
    } else if lower.starts_with("//?/") || lower.starts_with("//./") {
        normalized[4..].to_string()
    } else {
        normalized.to_string()
    };
    if normalized.as_bytes().get(1) == Some(&b':') || normalized.starts_with("//") {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
}

pub(crate) fn resolve_workspace_for_cwd(
    cwd: &str,
    roots: &HashMap<String, String>,
) -> Option<String> {
    let cwd = normalize_root_path(cwd);
    roots
        .iter()
        .filter(|(_, root)| {
            !root.is_empty()
                && (cwd == **root
                    || (cwd.starts_with(root.as_str())
                        && cwd.as_bytes().get(root.len()) == Some(&b'/')))
        })
        .max_by_key(|(_, root)| root.len())
        .map(|(id, _)| id.clone())
}

pub(crate) fn remember_request_workspace(
    owners: &mut HashMap<String, String>,
    thread_id: &str,
    caller: &str,
) {
    owners
        .entry(thread_id.to_string())
        .or_insert_with(|| caller.to_string());
}

pub(crate) fn remember_thread_workspace(
    owners: &mut HashMap<String, String>,
    roots: &HashMap<String, String>,
    thread_id: &str,
    message: &Value,
) {
    let container = message
        .get("params")
        .or_else(|| message.get("result"))
        .unwrap_or(message);
    let thread = container.get("thread").unwrap_or(container);
    let by_cwd = thread
        .get("cwd")
        .or_else(|| container.get("cwd"))
        .and_then(Value::as_str)
        .and_then(|cwd| resolve_workspace_for_cwd(cwd, roots));
    let parent = thread
        .get("parentThreadId")
        .or_else(|| thread.get("parent_thread_id"))
        .or_else(|| thread.pointer("/source/subagent/thread_spawn/parent_thread_id"))
        .or_else(|| thread.pointer("/source/subAgent/threadSpawn/parentThreadId"))
        .and_then(Value::as_str)
        .and_then(|id| owners.get(id))
        .cloned();
    if let Some(owner) = by_cwd.or(parent) {
        owners.insert(thread_id.to_string(), owner);
    }
}

const MAX_DEFERRED_EVENTS: usize = 1_024;
const MAX_DEFERRED_BYTES: usize = 8 * 1_024 * 1_024;

#[derive(Default)]
pub(crate) struct DeferredThreadEvents {
    events: VecDeque<(String, Value, usize)>,
    bytes: usize,
}

impl DeferredThreadEvents {
    // Only notifications are buffered. Interactive server requests must stay
    // reachable even when their workspace has not been discovered yet.
    pub(crate) fn push(&mut self, thread_id: String, message: Value) -> usize {
        let bytes = thread_id.len() + message.to_string().len();
        self.events.push_back((thread_id, message, bytes));
        self.bytes += bytes;
        let mut dropped = 0;
        while self.events.len() > MAX_DEFERRED_EVENTS || self.bytes > MAX_DEFERRED_BYTES {
            if let Some((_, _, bytes)) = self.events.pop_front() {
                self.bytes -= bytes;
                dropped += 1;
            }
        }
        dropped
    }

    pub(crate) fn take_resolved(
        &mut self,
        owners: &mut HashMap<String, String>,
        roots: &HashMap<String, String>,
    ) -> Vec<(String, Value)> {
        // A child can arrive before its parent. Resolve the deferred metadata
        // after a creation response, list response, or native spawn establishes
        // the parent owner, without waiting for another child event.
        loop {
            let previous_count = owners.len();
            for (thread, message, _) in &self.events {
                remember_thread_workspace(owners, roots, thread, message);
            }
            if owners.len() == previous_count {
                break;
            }
        }
        let mut ready = Vec::new();
        self.events.retain(|(thread, message, bytes)| {
            if let Some(owner) = owners.get(thread) {
                ready.push((owner.clone(), message.clone()));
                self.bytes -= bytes;
                false
            } else {
                true
            }
        });
        ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn started_before_create_response_uses_cwd_and_reads_cannot_reassign_it() {
        let roots = HashMap::from([
            ("tf".into(), "d:/project/tf".into()),
            ("eazyai".into(), "d:/project/eazyai".into()),
        ]);
        let mut owners = HashMap::new();
        remember_thread_workspace(
            &mut owners,
            &roots,
            "audit",
            &json!({"method":"thread/started", "params":{"thread":{"id":"audit","cwd":"\\\\?\\D:\\Project\\eazyai"}}}),
        );
        remember_request_workspace(&mut owners, "audit", "tf");
        assert_eq!(owners["audit"], "eazyai");
        remember_thread_workspace(
            &mut owners,
            &roots,
            "child",
            &json!({"params":{"thread":{"source":{"subagent":{"thread_spawn":{"parent_thread_id":"audit"}}}}}}),
        );
        assert_eq!(owners["child"], "eazyai");
    }

    #[test]
    fn unknown_events_wait_for_ownership_and_replay_in_order() {
        let mut deferred = DeferredThreadEvents::default();
        deferred.push("audit".into(), json!({"method":"turn/started"}));
        deferred.push("audit".into(), json!({"method":"item/started"}));
        let mut owners = HashMap::new();
        assert!(deferred
            .take_resolved(&mut owners, &HashMap::new())
            .is_empty());
        owners.insert("audit".into(), "eazyai".into());
        let ready = deferred.take_resolved(&mut owners, &HashMap::new());
        assert_eq!(ready.len(), 2);
        assert_eq!(
            ready[0],
            ("eazyai".into(), json!({"method":"turn/started"}))
        );
        assert!(deferred
            .take_resolved(&mut owners, &HashMap::new())
            .is_empty());
        deferred.push("child".into(), json!({"params":{"thread":{"source":{"subagent":{"thread_spawn":{"parent_thread_id":"audit"}}}}}}));
        assert_eq!(
            deferred.take_resolved(&mut owners, &HashMap::new()).len(),
            1
        );
        assert_eq!(owners["child"], "eazyai");
    }

    #[test]
    fn permanently_unknown_notifications_have_bounded_storage() {
        let mut deferred = DeferredThreadEvents::default();
        for _ in 0..MAX_DEFERRED_EVENTS {
            assert_eq!(deferred.push("unknown".into(), json!({})), 0);
        }
        assert_eq!(deferred.push("known".into(), json!({})), 1);
        let mut owners = HashMap::from([("known".into(), "eazyai".into())]);
        assert_eq!(
            deferred.take_resolved(&mut owners, &HashMap::new()).len(),
            1
        );
        assert_eq!(deferred.events.len(), MAX_DEFERRED_EVENTS - 1);
        let oversized = json!({"text": "x".repeat(MAX_DEFERRED_BYTES)});
        assert_eq!(
            deferred.push("unknown".into(), oversized),
            MAX_DEFERRED_EVENTS
        );
        assert!(deferred.events.is_empty());
        assert_eq!(deferred.bytes, 0);
    }
}
