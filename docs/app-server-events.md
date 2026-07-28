# App-Server Events Reference (Codex `5d1fbf26c43abc65a203928b2e31561cb039e06d` / `rust-v0.144.6`)

This document helps agents quickly answer:
- Which app-server events ThreadFleet supports right now.
- Which app-server requests ThreadFleet sends right now.
- Where to look in ThreadFleet to add support.
- Where to look in `../Codex` to compare event lists and find emitters.

When updating this document:
1. Confirm the intended Codex baseline. This revision is pinned to
   `5d1fbf26c43abc65a203928b2e31561cb039e06d` (`rust-v0.144.6`); do not replace it with
   `origin/main` unless the baseline is intentionally advanced.
2. Compare Codex events vs ThreadFleet routing.
3. Compare Codex client request methods vs ThreadFleet outgoing request methods.
4. Compare Codex server request methods vs ThreadFleet inbound request handling.
5. Update supported and missing lists below.

Related project skill:
- `.codex/skills/app-server-events-sync/SKILL.md`

Multi-agent schema notes:
- Upstream `spawn_agent` can expose per-spawn `model`, `reasoning_effort`, `service_tier`, and `fork_turns`.
- In Codex 0.144.6, `features.multi_agent_v2.hide_spawn_agent_metadata` defaults to `true`; when enabled, the tool schema removes `agent_type`, `model`, `reasoning_effort`, and `service_tier`. Automatic routing must inspect the effective runtime schema before using overrides.
- `fork_turns` accepts `none`, `all`, or a positive recent-turn count and defaults to `all`. Full-history forks cannot override agent type, model, or reasoning effort; heterogeneous children require `none` or a bounded recent-turn count.
- Upstream validates requested model IDs and reasoning efforts against the current model catalog. It has no generic per-spawn metadata or token-level context budget field.
- Multi-agent items have two observed shapes: a real `spawn_agent` can arrive as `subAgentActivity` with the spawn call `id` and `agentThreadId`, while metadata-visible generic collaboration items arrive as `collabAgentToolCall`. The latter must be checked for `tool = spawn_agent` before treating it as a binding; `wait`/`wait_agent` is not a spawn. Neither shape carries portable plan ID, node ID, task name, or correlation metadata. ThreadFleet retains model/effort only as actual binding evidence; they are not planned routing values.

## Where To Look In ThreadFleet

Primary app-server event source of truth (methods + typed parsing helpers):
- `src/utils/appServerEvents.ts`

Primary event router:
- `src/features/app/hooks/useAppServerEvents.ts`

Event handler composition:
- `src/features/threads/hooks/useThreadEventHandlers.ts`

Thread/turn/item handlers:
- `src/features/threads/hooks/useThreadTurnEvents.ts`
- `src/features/threads/hooks/useThreadItemEvents.ts`
- `src/features/threads/hooks/useThreadApprovalEvents.ts`
- `src/features/threads/hooks/useThreadUserInputEvents.ts`
- `src/features/skills/hooks/useSkills.ts`

State updates:
- `src/features/threads/hooks/useThreadsReducer.ts`

Item normalization / display shaping:
- `src/utils/threadItems.ts`

UI rendering of items:
- `src/features/messages/components/Messages.tsx`

Primary outgoing request layer:
- `src/services/tauri.ts`
- `src-tauri/src/shared/codex_core.rs`
- `src-tauri/src/codex/mod.rs`
- `src-tauri/src/bin/codex_monitor_daemon.rs`

## Supported Notifications (Codex v2)

These are the current Codex v2 `ServerNotification` methods that ThreadFleet
supports in `src/utils/appServerEvents.ts` (`SUPPORTED_APP_SERVER_METHODS`) and
then either routes in `useAppServerEvents.ts` or handles in feature-specific
subscriptions.

- `account/login/completed`
- `account/rateLimits/updated`
- `account/updated`
- `app/list/updated`
- `error`
- `hook/completed`
- `hook/started`
- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/completed`
- `item/fileChange/outputDelta` (deprecated legacy apply-patch stream)
- `item/plan/delta` (upstream documents this as experimental; it is not
  `#[experimental]`-gated)
- `item/reasoning/summaryPartAdded`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/textDelta`
- `item/started`
- `thread/archived`
- `thread/closed`
- `thread/name/updated`
- `thread/started`
- `thread/status/changed`
- `thread/tokenUsage/updated`
- `thread/unarchived`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`
- `turn/started`

### Plan state handling

- `turn/plan/updated` is the source of truth for structured steps and their
  statuses. `item/plan/delta` remains a separate display stream and is never
  parsed to infer structured status.
- A terminal turn with a fully completed structured plan clears that plan.
- A terminal turn with pending or in-progress steps triggers at most one
  forced `thread/read` for that workspace, thread, and turn. If no final
  structured update arrives, ThreadFleet keeps the steps visible and marks
  them stale; it never changes unfinished steps to completed.
- A completed structured update arriving after terminal state clears the plan.
  A late unfinished update remains visible and stale.
- Turn start and steer requests include a short `cm.plan-consistency`
  application context asking agents that use `update_plan` to publish a final
  accurate update before their final response.

## Additional Stream Methods Handled In ThreadFleet

These arrive on the same frontend event stream but are not Codex v2
`ServerNotification` methods:

- approval requests ending in `requestApproval`, including
  `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, and
  `item/permissions/requestApproval`, via suffix match in
  `isApprovalRequestMethod(method)`
- `item/tool/requestUserInput` (a Codex v2 server request, not a notification)
- `codex/backgroundThread` (ThreadFleet synthetic bridge event)
- `codex/connected` (ThreadFleet synthetic bridge event)
- `codex/event/skills_update_available` (handled via
  `isSkillsUpdateAvailableEvent(...)` in `useSkills.ts`)

## Conversation Compaction Signals (Codex v2)

Codex currently exposes two compaction signals:

- Preferred: `item/started` + `item/completed` with `item.type = "contextCompaction"` (`ThreadItem::ContextCompaction`).
- Deprecated: `thread/compacted` (`ContextCompactedNotification`).

ThreadFleet status:

- It routes `item/started` and `item/completed`, so the preferred signal reaches the frontend event layer.
- It renders/stores `contextCompaction` items via the normal item lifecycle.
- It no longer routes deprecated `thread/compacted`.

## Missing Events (Codex v2 Notifications)

Compared against Codex app-server protocol v2 notifications, the following
events are currently not routed:

At the baseline hash, upstream defines 69 server notifications; CM routes 28 and leaves 41 below unsupported.

- `command/exec/outputDelta`
- `configWarning`
- `deprecationNotice`
- `externalAgentConfig/import/completed`
- `externalAgentConfig/import/progress`
- `fs/changed`
- `fuzzyFileSearch/sessionCompleted`
- `fuzzyFileSearch/sessionUpdated`
- `guardianWarning`
- `item/mcpToolCall/progress`
- `item/autoApprovalReview/completed`
- `item/autoApprovalReview/started`
- `item/fileChange/patchUpdated`
- `mcpServer/oauthLogin/completed`
- `mcpServer/startupStatus/updated`
- `model/rerouted`
- `model/safetyBuffering/updated`
- `model/verification`
- `process/exited` (experimental)
- `process/outputDelta` (experimental)
- `rawResponseItem/completed` (internal-only)
- `remoteControl/status/changed`
- `serverRequest/resolved`
- `skills/changed`
- `thread/compacted` (deprecated; intentionally not routed)
- `thread/deleted`
- `thread/goal/cleared`
- `thread/goal/updated`
- `thread/realtime/closed` (experimental)
- `thread/realtime/error` (experimental)
- `thread/realtime/itemAdded` (experimental)
- `thread/realtime/outputAudio/delta` (experimental)
- `thread/realtime/sdp` (experimental)
- `thread/realtime/started` (experimental)
- `thread/realtime/transcript/delta` (experimental)
- `thread/realtime/transcript/done` (experimental)
- `thread/settings/updated` (experimental)
- `turn/moderationMetadata` (experimental)
- `warning`
- `windows/worldWritableWarning`
- `windowsSandbox/setupCompleted`

## Supported Requests (ThreadFleet -> App-Server, v2)

These are v2 request methods ThreadFleet currently sends to Codex app-server:

- `initialize`
- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/list`
- `thread/read`
- `thread/archive`
- `thread/compact/start`
- `thread/name/set`
- `thread/rollback`
- `turn/start`
- `turn/steer` (used for explicit steer follow-ups while a turn is active)
- `turn/interrupt`
- `review/start`
- `model/list`
- `experimentalFeature/list`
- `collaborationMode/list` (experimental)
- `mcpServerStatus/list`
- `plugin/list`
- `config/read`
- `account/login/start`
- `account/login/cancel`
- `account/rateLimits/read`
- `account/read`
- `skills/list`
- `app/list`

Runtime ownership:
- `thread/list` uses a Provider-neutral session-source history runtime for the target `CODEX_HOME` and workspace.
- Read-only `thread/read` first checks the primary and source-bound execution pools. When the target thread has a tracked active turn, the request uses that owning execution runtime and returns `codexMonitorReadAuthority: "execution"`. Otherwise it uses the history runtime and returns `codexMonitorReadAuthority: "history-no-active-execution"`.
- The frontend never runs active-thread reconciliation merely because the window regains focus. Stall reconciliation remains bounded to the inactivity threshold. A legacy daemon response without `codexMonitorReadAuthority` cannot terminate or replace a locally active turn.
- `thread/resume` and turn execution use the execution runtime selected by the active Provider. History and execution runtimes have distinct pool identities, so a custom Provider cannot replace or hide the local history index.
- When an active ThreadFleet Provider profile exists, `thread/start` and `thread/resume` explicitly send `modelProvider: "codex_monitor"`; this rebinds threads created under an older Provider instead of allowing persisted `model_provider: "openai"` metadata to route turns to the official endpoint.

Notes:
- `turn/start` now forwards the optional `serviceTier` override (`"fast"` for `/fast`, `null` for default/off) alongside `model`, `effort`, and `collaborationMode`.
- `turn/interrupt` acknowledgement is not treated as terminal. ThreadFleet keeps the matching turn active until `turn/completed` arrives; after a bounded wait it may use `thread/read` on the same execution runtime to confirm that exact turn is `completed`, `interrupted`, or `failed`. An unknown or still-running status remains fail-closed so Provider runtime switching cannot terminate live work.
- `turn/start` and `turn/steer` forward CM workflow rules, matched skills/agents, bounded knowledge excerpts, and non-direct computer-control route decisions through experimental `additionalContext` entries. The `cm.computer-control` entry is independent of Workflow mode, omitted for direct tasks, and contains only normalized route metadata. CM initializes app-server with `experimentalApi: true`; this context is separate from persisted user input.
- `spawn_agent` is an internal Codex collaboration tool, not a ThreadFleet-to-app-server request. In the Codex 0.144.6 runtime, its live item may be `subAgentActivity` with child-thread metadata; when a `collabAgentToolCall` shape is emitted, CM accepts it for binding only when its tool is `spawn_agent`. `wait` and `wait_agent` collaboration items are excluded.
- `execution_router_shadow_preview` accepts an optional approved-plan reference plus expected and actual bindings. The shared core validates plan-reference shape, checks the expected model/effort against the observed model catalog, and returns `bindingAudit`; missing evidence or mismatch produces `decision-gate` advice without dispatching, switching models, or mutating runtime configuration.
- CM automatically observes real spawn-shaped `item/started` / `item/completed` items (`subAgentActivity`, or `collabAgentToolCall` with `tool = spawn_agent`) and persists actual bindings in an app/daemon sidecar keyed by source, runtime, workspace, parent thread, and spawn call ID. Default hidden metadata leaves model/effort null; this remains fail-closed until expected binding evidence arrives. Exact retries are idempotent, and sender/actual conflicts or expired/stale registrations fail closed.
- Portable workflow remains the source of approved expected bindings. Its adapter must explicitly register the approved expected envelope against the same collab tool-call ID; expected-first and actual-first arrival are both supported across restart. CM does not derive expected model/effort from free-form text, event order, prompt similarity, or model/effort coincidence.
- Because the upstream item has no portable node correlation metadata, CM cannot safely infer which concurrent plan node produced a call. Fully automatic plan-node correlation remains blocked pending upstream metadata or a controlled adapter hook. This sidecar does not enable Active Router, spawn children, or replace the portable Root Task Ledger.

### Computer-Control Protocol Contract

At the pinned `rust-v0.144.6` baseline:

- `plugin/list` accepts optional `cwds` and `marketplaceKinds`. Its response contains `marketplaces`, `featuredPluginIds`, and `marketplaceLoadErrors`; each plugin summary includes `id`, `name`, `enabled`, `installed`, and `availability`.
- `plugin/list` is used only as management and discovery evidence. Its `enabled` field is not proof that the current app-server process loaded the plugin's skills, MCP servers, apps, or tools.
- `config/read` is used only to read the effective plugin enablement booleans needed by the capability snapshot. CM does not return or persist raw config layers, origins, paths, environment values, credentials, or native-pipe data.
- `mcpServerStatus/list` accepts `cursor`, `limit`, `detail`, and optional `threadId`; `detail` is `full` or `toolsAndAuthOnly`. A listed server is considered ready only from stable server identity plus a non-empty tool map. `authStatus: "unsupported"` means the server does not use supported OAuth, not that the server failed.
- Capability discovery sends `mcpServerStatus/list`, `plugin/list`, `skills/list`, and `config/read` concurrently on the owning app-server session. Cold MCP startup may exceed ten seconds, so the capability probe allows 20 seconds while the resulting runtime-bound snapshot remains cached for 30 seconds; manual refresh invalidates that snapshot.
- ThreadFleet appends `-c plugins.computer-use@openai-bundled.enabled=false` after user Codex arguments for every owned app-server process. This is a runtime-only last-wins override and is included in the runtime fingerprint; it never writes the user's `config.toml`.
- `turn/start` and `turn/steer` expose no stable per-turn tool allowlist at this baseline. Browser backend selection is therefore advisory; CM must not describe it as a hard tool gate.

### M2.5B Evidence Contract

M2.5B treats real collaboration, restart recovery, and prompt non-persistence as separate evidence gates:

- Real collaboration evidence must come from Codex app-server `spawn_agent` activity. CM accepts both `subAgentActivity` and metadata-visible `collabAgentToolCall` (`tool = spawn_agent` only); `wait` and `wait_agent` are excluded.
- Restart evidence must reload `execution-binding-shadow.json` from the same data directory and preserve expected-first and actual-first records. A restart must not recreate a child, clear a binding, or move a child into an unrelated workspace.
- Persisted binding evidence is structural only: source/runtime/workspace IDs, parent/call/receiver IDs, model/effort evidence, status, reason codes, and timestamps. It must not contain prompt text, `additionalContext`, user input, tool input, API keys, or environment values.
- Metadata-hidden runtimes are valid but produce incomplete actual evidence; CM must remain fail-closed instead of inferring model or effort from prompt text, event order, or coincidence.

The regression test `persisted_binding_evidence_contains_no_prompt_or_context_payload` reads the serialized sidecar and rejects forbidden prompt/context fields. Real runtime acceptance additionally requires a controlled parent/child `spawn_agent` run, CM restart, binding reload, and child `thread/read` or `thread/resume` verification. Evidence artifacts stay local under `.codex-monitor` and are not published.

## Missing Client Requests (Codex v2 ClientRequest Methods)

Compared against Codex v2 request methods, ThreadFleet currently does not send:

At the baseline hash, upstream defines 118 non-deprecated client requests; CM sends 26 including `initialize`, leaving 92 below unsupported.

- `account/logout`
- `account/rateLimitResetCredit/consume`
- `account/sendAddCreditsNudgeEmail`
- `account/usage/read`
- `account/workspaceMessages/read`
- `command/exec`
- `command/exec/resize`
- `command/exec/terminate`
- `command/exec/write`
- `config/batchWrite`
- `config/mcpServer/reload`
- `config/value/write`
- `configRequirements/read`
- `environment/add` (experimental)
- `environment/info` (experimental)
- `experimentalFeature/enablement/set`
- `externalAgentConfig/detect`
- `externalAgentConfig/import`
- `externalAgentConfig/import/readHistories`
- `feedback/upload`
- `fs/copy`
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/readDirectory`
- `fs/readFile`
- `fs/remove`
- `fs/unwatch`
- `fs/watch`
- `fs/writeFile`
- `hooks/list`
- `marketplace/add`
- `marketplace/remove`
- `marketplace/upgrade`
- `mcpServer/oauth/login`
- `mcpServer/resource/read`
- `mcpServer/tool/call`
- `memory/reset` (experimental)
- `mock/experimentalMethod` (experimental)
- `modelProvider/capabilities/read`
- `permissionProfile/list`
- `plugin/install`
- `plugin/installed`
- `plugin/read`
- `plugin/share/checkout`
- `plugin/share/delete`
- `plugin/share/list`
- `plugin/share/save`
- `plugin/share/updateTargets`
- `plugin/skill/read`
- `plugin/uninstall`
- `process/kill` (experimental)
- `process/resizePty` (experimental)
- `process/spawn` (experimental)
- `process/writeStdin` (experimental)
- `remoteControl/client/list` (experimental)
- `remoteControl/client/revoke` (experimental)
- `remoteControl/disable` (experimental)
- `remoteControl/enable` (experimental)
- `remoteControl/pairing/start` (experimental)
- `remoteControl/pairing/status` (experimental)
- `remoteControl/status/read` (experimental)
- `skills/config/write`
- `skills/extraRoots/set`
- `thread/approveGuardianDeniedAction`
- `thread/backgroundTerminals/clean` (experimental)
- `thread/backgroundTerminals/list` (experimental)
- `thread/backgroundTerminals/terminate` (experimental)
- `thread/decrement_elicitation` (experimental)
- `thread/delete`
- `thread/goal/clear`
- `thread/goal/get`
- `thread/goal/set`
- `thread/increment_elicitation` (experimental)
- `thread/inject_items`
- `thread/items/list` (experimental)
- `thread/loaded/list`
- `thread/memoryMode/set` (experimental)
- `thread/metadata/update`
- `thread/realtime/appendAudio` (experimental)
- `thread/realtime/appendSpeech` (experimental)
- `thread/realtime/appendText` (experimental)
- `thread/realtime/listVoices` (experimental)
- `thread/realtime/start` (experimental)
- `thread/realtime/stop` (experimental)
- `thread/search` (experimental)
- `thread/settings/update` (experimental)
- `thread/shellCommand`
- `thread/turns/list` (experimental)
- `thread/unarchive`
- `thread/unsubscribe`
- `windowsSandbox/readiness`
- `windowsSandbox/setupStart`

Deprecated client requests are deliberately excluded from the missing-support backlog:

- `fuzzyFileSearch`
- `fuzzyFileSearch/sessionStart` (experimental)
- `fuzzyFileSearch/sessionStop` (experimental)
- `fuzzyFileSearch/sessionUpdate` (experimental)
- `getAuthStatus`
- `getConversationSummary`
- `gitDiffToRemote`

## Server Requests (App-Server -> ThreadFleet, v2)

Supported server requests:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`

Missing server requests:

At the baseline hash, upstream defines 9 non-deprecated server requests; CM handles 4 and leaves 5 below unsupported.

- `account/chatgptAuthTokens/refresh`
- `attestation/generate`
- `currentTime/read` (experimental)
- `item/tool/call`
- `mcpServer/elicitation/request`

Deprecated server requests `applyPatchApproval` and `execCommandApproval` are deliberately not supported; CM uses the current item-scoped approval requests.

## Upstream Classification

Classifications above are from Codex `5d1fbf26c43abc65a203928b2e31561cb039e06d` (`rust-v0.144.6`):

- `experimental`: the protocol declaration carries `#[experimental(...)]`.
- `deprecated`: the declaration or adjacent upstream documentation explicitly
  marks the method deprecated.
- `internal-only`: upstream documentation restricts the notification to Codex
  Cloud or clients requiring exact upstream usage.

These labels describe protocol status, not whether ThreadFleet supports a
method. `item/plan/delta` is separately called experimental by upstream prose
but has no `#[experimental(...)]` attribute at this baseline.

## Where To Look In ../Codex

Start here for the authoritative v2 notification list:
- `../Codex/codex-rs/app-server-protocol/src/protocol/common.rs`

Useful follow-ups:
- Notification payload types:
  - `../Codex/codex-rs/app-server-protocol/src/protocol/v2/*.rs`
- Thread item payload types:
  - `../Codex/codex-rs/app-server-protocol/src/protocol/v2/item.rs`
- Multi-agent tool schema and validation:
  - `../Codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs`
  - `../Codex/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs`
  - `../Codex/codex-rs/core/src/tools/handlers/multi_agents_common.rs`
- Emitters / wiring from core events to server notifications:
  - `../Codex/codex-rs/app-server/src/bespoke_event_handling.rs`
- Human-readable protocol notes:
  - `../Codex/codex-rs/app-server/README.md`

## Quick Comparison Workflow

Use this workflow to update the lists above:

1. Get the current Codex hash:
   - `git -C ../Codex fetch --all --prune && git -C ../Codex rev-parse origin/main`
2. List Codex v2 notification methods:
   - `git -C ../Codex show origin/main:codex-rs/app-server-protocol/src/protocol/common.rs | awk '/server_notification_definitions! \\{/,/client_notification_definitions! \\{/' | rg -N -o '=>\\s*\"[^\"]+\"|rename = \"[^\"]+\"' | sed -E 's/.*\"([^\"]+)\".*/\\1/' | sort -u`
3. List ThreadFleet routed methods:
   - `rg -n \"SUPPORTED_APP_SERVER_METHODS\" src/utils/appServerEvents.ts`
4. Update the Supported and Missing sections.

## Quick Request Comparison Workflow

Use this workflow to update request support lists:

1. Get the current Codex hash:
   - `git -C ../Codex fetch --all --prune && git -C ../Codex rev-parse origin/main`
2. List Codex client request methods:
   - `git -C ../Codex show origin/main:codex-rs/app-server-protocol/src/protocol/common.rs | awk '/client_request_definitions! \\{/,/\\/\\/\\/ DEPRECATED APIs below/' | rg -N -o '=>\\s*\"[^\"]+\"\\s*\\{' | sed -E 's/.*\"([^\"]+)\".*/\\1/' | sort -u`
3. List Codex server request methods:
   - `git -C ../Codex show origin/main:codex-rs/app-server-protocol/src/protocol/common.rs | awk '/server_request_definitions! \\{/,/\\/\\/\\/ DEPRECATED APIs below/' | rg -N -o '=>\\s*\"[^\"]+\"\\s*\\{' | sed -E 's/.*\"([^\"]+)\".*/\\1/' | sort -u`
4. List ThreadFleet outgoing requests:
   - `perl -0777 -ne 'while(/send_request_for_workspace\\(\\s*&[^,]+\\s*,\\s*\"([^\"]+)\"/g){print \"$1\\n\"}' src-tauri/src/shared/codex_core.rs | sort -u`
5. Check `src-tauri/src/backend/app_server.rs` separately for the initial `initialize` request; it is not sent through `send_request_for_workspace`.
6. Update the Supported Requests, Missing Client Requests, and Server Requests sections.

## Schema Drift Workflow (Best)

Use this when the method list is unchanged but behavior looks off.

1. Confirm the current Codex hash:
   - `git -C ../Codex fetch --all --prune && git -C ../Codex rev-parse origin/main`
2. Inspect the authoritative notification structs:
   - `git -C ../Codex grep -n \"struct .*Notification\" origin/main -- codex-rs/app-server-protocol/src/protocol/v2`
3. For a specific method, jump to its struct definition:
   - Example: `git -C ../Codex grep -n \"struct TurnPlanUpdatedNotification|struct ThreadTokenUsageUpdatedNotification|struct AccountRateLimitsUpdatedNotification|struct ItemStartedNotification|struct ItemCompletedNotification\" origin/main -- codex-rs/app-server-protocol/src/protocol/v2`
4. Compare payload shapes to the router expectations:
   - Parser/source of truth: `src/utils/appServerEvents.ts`
   - Router: `src/features/app/hooks/useAppServerEvents.ts`
   - Turn/plan/token/rate-limit normalization: `src/features/threads/utils/threadNormalize.ts`
   - Item shaping for display: `src/utils/threadItems.ts`
5. Verify the ThreadItem schema (many UI issues start here):
   - `git -C ../Codex show origin/main:codex-rs/app-server-protocol/src/protocol/v2/item.rs | rg -n \"enum ThreadItem|CommandExecution|FileChange|McpToolCall|CollabAgentToolCall|EnteredReviewMode|ExitedReviewMode|ContextCompaction\"`
6. Check for camelCase vs snake_case mismatches:
   - The protocol uses `#[serde(rename_all = \"camelCase\")]`, but fields are often declared in snake_case.
   - ThreadFleet generally defends against this by checking both forms (for example in `threadNormalize.ts` and `useAppServerEvents.ts`), while centralizing method/type parsing in `appServerEvents.ts`.
7. If a schema change is found, fix it at the edges first:
   - Prefer updating `src/utils/appServerEvents.ts`, `useAppServerEvents.ts`, and `threadNormalize.ts` rather than spreading conditionals into components.

## Notes

- Not all missing events must be surfaced in the conversation view; some may
  be better as toasts, settings warnings, or debug-only entries.
- For conversation view changes, prefer:
  - Add method/type support in `src/utils/appServerEvents.ts`
  - Route in `useAppServerEvents.ts`
  - Handle in `useThreadTurnEvents.ts` or `useThreadItemEvents.ts`
  - Update state in `useThreadsReducer.ts`
  - Render in `Messages.tsx`
- `turn/diff/updated` is now fully wired:
  - Routed in `useAppServerEvents.ts`
  - Handled in `useThreadTurnEvents.ts` / `useThreadEventHandlers.ts`
  - Stored in `useThreadsReducer.ts` (`turnDiffByThread`)
  - Exposed by `useThreads.ts` for UI consumers
- Steering behavior while a turn is processing:
  - ThreadFleet attempts `turn/steer` only when steer capability is enabled, the thread is processing, and an active turn id exists.
  - If `turn/steer` fails, ThreadFleet does not fall back to `turn/start`; it clears stale processing/turn state when applicable, surfaces an error, and returns `steer_failed`.
  - Local queue fallback on `steer_failed` is handled in the composer queued-send flow (`useQueuedSend`), not by all direct `sendUserMessageToThread` callers.
- Feature toggles in Settings:
  - `experimentalFeature/list` is an app-server request.
  - Toggle writes use local/daemon command surfaces (`set_codex_feature_flag` and app settings update),
    which write `config.toml`; they are not app-server `ClientRequest` methods.
