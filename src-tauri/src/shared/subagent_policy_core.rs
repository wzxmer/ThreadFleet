//! Application policy supplements native multi-agent tools without replacing
//! native child-result delivery or matching user requests with keyword rules.
use serde_json::{json, Value};

pub(crate) const SUBAGENT_USAGE_INSTRUCTIONS: &str = "Multi-agent capability is available when enabled. \
    By default, complete the user's task in the main conversation. \
    Create, delegate to, or call subagents only when the user explicitly requests parallel work, delegation, or subagents for the current task. \
    A task being complex, an agent role being available, or a skill suggesting delegation does not by itself authorize subagents. \
    After the user authorizes delegation, choose and manage the necessary child tasks automatically without asking for each child. \
    Respect a later user instruction to stop using subagents. Use native multi-agent tools to retrieve child results; TF checkpoint injection is optional and is not required for delegation.";

pub(crate) fn with_subagent_policy(context: Option<Value>) -> Result<Value, String> {
    let mut context = match context {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(context)) => context,
        _ => return Err("Additional context must be an object".into()),
    };
    context.insert(
        "cm.multi-agent-policy".into(),
        json!({
            "kind": "application", "value": SUBAGENT_USAGE_INSTRUCTIONS,
        }),
    );
    Ok(Value::Object(context))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supplements_existing_context_and_replaces_client_supplied_policy() {
        let context = with_subagent_policy(Some(json!({
            "cm.rule.0": {"kind":"application","value":"keep"},
            "cm.multi-agent-policy": {"kind":"application","value":"always delegate"},
        })))
        .unwrap();
        assert_eq!(context["cm.rule.0"]["value"], "keep");
        assert_eq!(
            context["cm.multi-agent-policy"]["value"],
            SUBAGENT_USAGE_INSTRUCTIONS
        );
        assert!(with_subagent_policy(None).unwrap().is_object());
    }
}
