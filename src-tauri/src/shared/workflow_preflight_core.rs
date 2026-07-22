use git2::Repository;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::UNIX_EPOCH;
use tokio::sync::Mutex;

use crate::shared::workflow_gate_adapter_core;
use crate::types::WorkspaceEntry;

const MAX_RULE_DEPTH: usize = 4;
const MAX_RULE_ENTRIES: usize = 2_000;
const MAX_KNOWLEDGE_DEPTH: usize = 5;
const MAX_KNOWLEDGE_FILES: usize = 400;
const MAX_KNOWLEDGE_FILE_BYTES: u64 = 256 * 1024;
const MAX_KNOWLEDGE_TOTAL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_KNOWLEDGE_CANDIDATES: usize = 8;
// Require multiple strong matches so generic verbs do not flood context.
const MIN_KNOWLEDGE_MATCH_SCORE: u32 = 16;
const MAX_KNOWLEDGE_CACHE_ENTRIES: usize = 8;
const MAX_MATCH_TERMS: usize = 5;
const MAX_TASK_CHARS: usize = 8_000;
const MAX_CONTEXT_FRAGMENT_CHARS: usize = 4_000;
const MAX_RULE_CONTEXT_CHARS: usize = 16_000;
const MAX_KNOWLEDGE_CONTEXT_CHARS: usize = 12_000;
const MAX_RULE_FILE_BYTES: u64 = 256 * 1024;
const DEFAULT_CONTEXT_BUDGET_TOKENS: usize = 12_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRuleCandidate {
    path: String,
    kind: String,
    scope: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowKnowledgeCandidate {
    knowledge_id: String,
    path: String,
    title: String,
    score: u32,
    matched_terms: Vec<String>,
    content_fingerprint: String,
    #[serde(skip)]
    estimated_tokens: usize,
    freshness: WorkflowKnowledgeFreshness,
    #[serde(skip)]
    content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowKnowledgeFreshness {
    state: String,
    reason: String,
    source_project: String,
    source_revision: String,
    source_branch: String,
    verified_at: String,
    implementation_status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRetrievalOmission {
    knowledge_id: String,
    path: String,
    reason: String,
    detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRetrievalSelection {
    knowledge_id: String,
    path: String,
    content_fingerprint: String,
    estimated_tokens: usize,
    freshness: WorkflowKnowledgeFreshness,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowRetrievalReceipt {
    schema_version: u32,
    query_fingerprint: String,
    project_id: String,
    index_revision: String,
    selected: Vec<WorkflowRetrievalSelection>,
    omitted: Vec<WorkflowRetrievalOmission>,
    cache_hit: bool,
    estimated_injected_tokens: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowContextSource {
    phase: String,
    kind: String,
    path: String,
    fingerprint: String,
    estimated_tokens: usize,
    selected: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowContextPlan {
    context_fingerprint: String,
    stable_prefix_fingerprint: String,
    dynamic_context_fingerprint: String,
    budget_tokens: usize,
    mandatory_tokens: usize,
    selected_tokens: usize,
    truncated: bool,
    sources: Vec<WorkflowContextSource>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowValidationGate {
    id: String,
    kind: String,
    instruction: String,
    status: String,
    source_areas: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowChangedDiffReviewGate {
    required: bool,
    status: String,
    scope: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowKnowledgeCaptureCandidate {
    status: String,
    category: String,
    reason: String,
    submission_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowCompletionPlan {
    required: bool,
    phase: String,
    validations: Vec<WorkflowValidationGate>,
    changed_diff_review: WorkflowChangedDiffReviewGate,
    knowledge_capture: WorkflowKnowledgeCaptureCandidate,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowImpactItem {
    area: String,
    reason: String,
    validation: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowContextFragment {
    source_id: String,
    kind: String,
    value: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowHostPreflightPreview {
    mode: String,
    provider_kind: String,
    model: Option<String>,
    task_length: usize,
    rules: Vec<WorkflowRuleCandidate>,
    knowledge_candidates: Vec<WorkflowKnowledgeCandidate>,
    impacts: Vec<WorkflowImpactItem>,
    impact_summary: String,
    validation_suggestions: Vec<String>,
    source_errors: Vec<String>,
    knowledge_cache_hit: bool,
    retrieval_receipt: WorkflowRetrievalReceipt,
    context_fragments: Vec<WorkflowContextFragment>,
    context_plan: WorkflowContextPlan,
    completion_plan: WorkflowCompletionPlan,
    workflow_gate: Option<Value>,
}

#[derive(Clone)]
struct KnowledgeDocument {
    knowledge_id: String,
    project_id: String,
    path: String,
    title: String,
    normalized_path: String,
    normalized_title: String,
    normalized_content: String,
    content_fingerprint: String,
    estimated_tokens: usize,
    lifecycle_status: String,
    implementation_status: String,
    source_project: String,
    source_revision: String,
    source_branch: String,
    verified_at: String,
    content: String,
}

struct RankedKnowledge {
    candidates: Vec<WorkflowKnowledgeCandidate>,
    omissions: Vec<WorkflowRetrievalOmission>,
    project_id: String,
    index_revision: String,
    cache_hit: bool,
}

fn content_fingerprint(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn estimate_tokens(content: &str) -> usize {
    let mut ascii = 0usize;
    let mut non_ascii = 0usize;
    for character in content.chars() {
        if character.is_ascii() {
            ascii += 1;
        } else {
            non_ascii += 1;
        }
    }
    ascii.div_ceil(4).saturating_add(non_ascii)
}

fn frontmatter_scalar(content: &str, key: &str) -> String {
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((candidate, value)) = line.split_once(':') else {
            continue;
        };
        if candidate.trim() == key {
            return value.trim().trim_matches(['"', '\'']).to_string();
        }
    }
    String::new()
}

fn active_knowledge_status(status: &str) -> bool {
    status.is_empty()
        || matches!(
            status.to_ascii_lowercase().as_str(),
            "active" | "fixed" | "completed" | "verified" | "stable"
        )
}

fn unknown_freshness(document: &KnowledgeDocument, reason: &str) -> WorkflowKnowledgeFreshness {
    WorkflowKnowledgeFreshness {
        state: "unknown".to_string(),
        reason: reason.to_string(),
        source_project: document.source_project.clone(),
        source_revision: document.source_revision.clone(),
        source_branch: document.source_branch.clone(),
        verified_at: document.verified_at.clone(),
        implementation_status: document.implementation_status.clone(),
    }
}

fn knowledge_freshness(
    document: &KnowledgeDocument,
    repository: Option<&Repository>,
) -> WorkflowKnowledgeFreshness {
    if document.source_revision.is_empty() {
        return unknown_freshness(document, "source_revision_missing");
    }
    if !document.source_project.is_empty()
        && !document.project_id.is_empty()
        && document.source_project != document.project_id
    {
        return unknown_freshness(document, "source_project_mismatch");
    }
    let Some(repository) = repository else {
        return unknown_freshness(document, "source_repository_unavailable");
    };
    let Ok(head) = repository.head() else {
        return unknown_freshness(document, "source_head_unavailable");
    };
    let Some(head_oid) = head.target() else {
        return unknown_freshness(document, "source_head_unavailable");
    };
    let Ok(source_object) = repository.revparse_single(&document.source_revision) else {
        return unknown_freshness(document, "source_revision_unavailable");
    };
    let Ok(source_commit) = source_object.peel_to_commit() else {
        return unknown_freshness(document, "source_revision_not_commit");
    };
    let is_current = head_oid == source_commit.id()
        || repository
            .graph_descendant_of(head_oid, source_commit.id())
            .unwrap_or(false);
    WorkflowKnowledgeFreshness {
        state: if is_current { "current" } else { "stale" }.to_string(),
        reason: if is_current {
            "source_revision_is_ancestor"
        } else {
            "source_revision_not_ancestor"
        }
        .to_string(),
        source_project: document.source_project.clone(),
        source_revision: document.source_revision.clone(),
        source_branch: document.source_branch.clone(),
        verified_at: document.verified_at.clone(),
        implementation_status: document.implementation_status.clone(),
    }
}

#[derive(Clone)]
struct CachedKnowledgeIndex {
    fingerprint: String,
    documents: Arc<Vec<KnowledgeDocument>>,
}

fn knowledge_cache() -> &'static StdMutex<HashMap<String, CachedKnowledgeIndex>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, CachedKnowledgeIndex>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn knowledge_root() -> Option<PathBuf> {
    std::env::var_os("DEV_KNOWLEDGE_BASE")
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| {
            let fallback = PathBuf::from(r"D:\DevKnowledgeBase");
            fallback.is_dir().then_some(fallback)
        })
}

fn push_rule(
    output: &mut Vec<WorkflowRuleCandidate>,
    seen: &mut HashSet<String>,
    path: PathBuf,
    scope: &str,
) {
    if !path.is_file() {
        return;
    }
    let normalized = normalized_path(&path);
    if !seen.insert(normalized.clone()) {
        return;
    }
    let kind = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "rules".to_string());
    output.push(WorkflowRuleCandidate {
        path: normalized,
        kind,
        scope: scope.to_string(),
    });
}

fn collect_nested_rules(
    root: &Path,
    depth: usize,
    output: &mut Vec<WorkflowRuleCandidate>,
    seen: &mut HashSet<String>,
    visited: &mut usize,
) {
    if depth > MAX_RULE_DEPTH || *visited >= MAX_RULE_ENTRIES || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if *visited >= MAX_RULE_ENTRIES {
            break;
        }
        *visited += 1;
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if matches!(name.as_str(), ".git" | "node_modules" | "target") {
                continue;
            }
            collect_nested_rules(&path, depth + 1, output, seen, visited);
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if matches!(name.as_str(), "agents.md" | "rtk.md") {
            push_rule(output, seen, path, "nested");
        }
    }
}

fn discover_rules(workspace_path: &Path) -> Vec<WorkflowRuleCandidate> {
    let mut rules = Vec::new();
    let mut seen = HashSet::new();
    if let Some(home) = home_dir() {
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        push_rule(
            &mut rules,
            &mut seen,
            codex_home.join("AGENTS.md"),
            "global",
        );
        push_rule(&mut rules, &mut seen, codex_home.join("RTK.md"), "global");
    }

    let mut ancestors = workspace_path.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for ancestor in ancestors {
        push_rule(
            &mut rules,
            &mut seen,
            ancestor.join("AGENTS.md"),
            "workspace",
        );
        push_rule(&mut rules, &mut seen, ancestor.join("RTK.md"), "workspace");
    }
    let mut visited = 0;
    collect_nested_rules(workspace_path, 0, &mut rules, &mut seen, &mut visited);
    rules.sort_by(|left, right| left.path.cmp(&right.path));
    rules
}

fn normalized_project_name(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn resolve_project_knowledge_dir(
    root: &Path,
    workspace_name: &str,
    workspace_path: &Path,
) -> Option<PathBuf> {
    let projects = root.join("20-项目知识");
    let path_name = workspace_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let targets = [workspace_name, path_name.as_str()]
        .into_iter()
        .map(normalized_project_name)
        .filter(|name| !name.is_empty())
        .collect::<HashSet<_>>();
    let entries = fs::read_dir(projects).ok()?;
    entries.flatten().find_map(|entry| {
        let path = entry.path();
        let name = normalized_project_name(&entry.file_name().to_string_lossy());
        (path.is_dir() && targets.contains(&name)).then_some(path)
    })
}

fn collect_markdown_files(root: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth > MAX_KNOWLEDGE_DEPTH || output.len() >= MAX_KNOWLEDGE_FILES || !root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if output.len() >= MAX_KNOWLEDGE_FILES {
            break;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_markdown_files(&path, depth + 1, output);
        } else if path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            output.push(path);
        }
    }
}

fn knowledge_fingerprint(files: &[PathBuf]) -> String {
    let mut hasher = Sha256::new();
    for path in files {
        hasher.update(normalized_path(path).as_bytes());
        if let Ok(metadata) = fs::metadata(path) {
            hasher.update(metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                    hasher.update(duration.as_nanos().to_le_bytes());
                }
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

fn load_knowledge_documents(project_dir: &Path) -> (Arc<Vec<KnowledgeDocument>>, bool, String) {
    let mut files = Vec::new();
    collect_markdown_files(project_dir, 0, &mut files);
    files.sort();
    let fingerprint = knowledge_fingerprint(&files);
    let cache_key = normalized_path(project_dir);
    if let Ok(cache) = knowledge_cache().lock() {
        if let Some(cached) = cache.get(&cache_key) {
            if cached.fingerprint == fingerprint {
                return (
                    Arc::clone(&cached.documents),
                    true,
                    cached.fingerprint.clone(),
                );
            }
        }
    }

    let mut total_bytes: u64 = 0;
    let mut documents = Vec::new();
    for path in files {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if metadata.len() > MAX_KNOWLEDGE_FILE_BYTES
            || total_bytes.saturating_add(metadata.len()) > MAX_KNOWLEDGE_TOTAL_BYTES
        {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        total_bytes += metadata.len();
        let title = markdown_title(&content, &path);
        let normalized = normalized_path(&path);
        let content_fingerprint = content_fingerprint(&content);
        let estimated_tokens = estimate_tokens(&content);
        let project_id = frontmatter_scalar(&content, "项目");
        let source_project = frontmatter_scalar(&content, "source_project");
        documents.push(KnowledgeDocument {
            knowledge_id: frontmatter_scalar(&content, "id"),
            project_id: project_id.clone(),
            path: normalized.clone(),
            normalized_path: normalized.to_lowercase(),
            normalized_title: title.to_lowercase(),
            normalized_content: content.to_lowercase(),
            content_fingerprint,
            estimated_tokens,
            lifecycle_status: frontmatter_scalar(&content, "状态"),
            implementation_status: frontmatter_scalar(&content, "实现状态"),
            source_project: if source_project.is_empty() {
                project_id
            } else {
                source_project
            },
            source_revision: frontmatter_scalar(&content, "source_revision"),
            source_branch: frontmatter_scalar(&content, "source_branch"),
            verified_at: frontmatter_scalar(&content, "verified_at"),
            content,
            title,
        });
    }
    let documents = Arc::new(documents);
    if let Ok(mut cache) = knowledge_cache().lock() {
        if cache.len() >= MAX_KNOWLEDGE_CACHE_ENTRIES && !cache.contains_key(&cache_key) {
            if let Some(oldest_key) = cache.keys().next().cloned() {
                cache.remove(&oldest_key);
            }
        }
        cache.insert(
            cache_key,
            CachedKnowledgeIndex {
                fingerprint: fingerprint.clone(),
                documents: Arc::clone(&documents),
            },
        );
    }
    (documents, false, fingerprint)
}

fn task_terms(task: &str) -> Vec<String> {
    let task = task.chars().take(MAX_TASK_CHARS).collect::<String>();
    let mut terms = HashSet::new();
    let mut current = String::new();
    let flush = |current: &mut String, terms: &mut HashSet<String>| {
        if current.chars().count() >= 2 {
            terms.insert(current.to_lowercase());
        }
        current.clear();
    };
    for character in task.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
            current.push(character);
        } else {
            flush(&mut current, &mut terms);
        }
    }
    flush(&mut current, &mut terms);

    let cjk = task
        .chars()
        .filter(|character| matches!(*character as u32, 0x3400..=0x9fff))
        .collect::<Vec<_>>();
    if cjk.len() <= 4 {
        if !cjk.is_empty() {
            terms.insert(cjk.iter().collect::<String>());
        }
    } else {
        for size in [2usize, 3, 4] {
            for window in cjk.windows(size) {
                terms.insert(window.iter().collect::<String>());
            }
        }
    }
    let mut terms = terms.into_iter().collect::<Vec<_>>();
    terms.sort_by(|left, right| {
        right
            .chars()
            .count()
            .cmp(&left.chars().count())
            .then(left.cmp(right))
    });
    terms.truncate(80);
    terms
}

fn markdown_title(content: &str, path: &Path) -> String {
    content
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .or_else(|| {
            path.file_stem()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "Knowledge".to_string())
}

fn rank_knowledge(
    root: Option<&Path>,
    workspace_name: &str,
    workspace_path: &Path,
    task: &str,
    errors: &mut Vec<String>,
) -> RankedKnowledge {
    let fallback_project_id = normalized_project_name(workspace_name);
    let Some(root) = root else {
        errors.push("development knowledge base unavailable".to_string());
        return RankedKnowledge {
            candidates: Vec::new(),
            omissions: Vec::new(),
            project_id: fallback_project_id,
            index_revision: String::new(),
            cache_hit: false,
        };
    };
    let Some(project_dir) = resolve_project_knowledge_dir(root, workspace_name, workspace_path)
    else {
        errors.push(format!("project knowledge not found for {workspace_name}"));
        return RankedKnowledge {
            candidates: Vec::new(),
            omissions: Vec::new(),
            project_id: fallback_project_id,
            index_revision: String::new(),
            cache_hit: false,
        };
    };
    let terms = task_terms(task);
    if terms.is_empty() {
        return RankedKnowledge {
            candidates: Vec::new(),
            omissions: Vec::new(),
            project_id: fallback_project_id,
            index_revision: String::new(),
            cache_hit: false,
        };
    }
    let (documents, cache_hit, index_revision) = load_knowledge_documents(&project_dir);
    let project_id = documents
        .iter()
        .find_map(|document| (!document.project_id.is_empty()).then(|| document.project_id.clone()))
        .unwrap_or(fallback_project_id);
    let repository = Repository::discover(workspace_path).ok();
    let mut candidates = Vec::new();
    let mut omissions = Vec::new();
    for document in documents.iter() {
        let mut score = 0;
        let mut matched_terms = Vec::new();
        for term in &terms {
            let term_score = if document.normalized_title.contains(term) {
                8
            } else if document.normalized_path.contains(term) {
                5
            } else if document.normalized_content.contains(term) {
                1
            } else {
                0
            };
            if term_score > 0 {
                score += term_score;
                if matched_terms.len() < MAX_MATCH_TERMS {
                    matched_terms.push(term.clone());
                }
            }
        }
        if score >= MIN_KNOWLEDGE_MATCH_SCORE {
            let knowledge_id = if document.knowledge_id.is_empty() {
                document.path.clone()
            } else {
                document.knowledge_id.clone()
            };
            if !active_knowledge_status(&document.lifecycle_status) {
                omissions.push(WorkflowRetrievalOmission {
                    knowledge_id,
                    path: document.path.clone(),
                    reason: "lifecycle".to_string(),
                    detail: document.lifecycle_status.clone(),
                });
                continue;
            }
            let freshness = knowledge_freshness(document, repository.as_ref());
            if !document.source_revision.is_empty() && freshness.state != "current" {
                omissions.push(WorkflowRetrievalOmission {
                    knowledge_id,
                    path: document.path.clone(),
                    reason: if freshness.state == "stale" {
                        "source_revision_stale"
                    } else {
                        "source_revision_unverifiable"
                    }
                    .to_string(),
                    detail: freshness.reason,
                });
                continue;
            }
            candidates.push(WorkflowKnowledgeCandidate {
                knowledge_id,
                path: document.path.clone(),
                title: document.title.clone(),
                score,
                matched_terms,
                content_fingerprint: document.content_fingerprint.clone(),
                estimated_tokens: document.estimated_tokens,
                freshness,
                content: document.content.clone(),
            });
        }
    }
    candidates.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then(left.path.cmp(&right.path))
    });
    candidates.truncate(MAX_KNOWLEDGE_CANDIDATES);
    RankedKnowledge {
        candidates,
        omissions,
        project_id,
        index_revision,
        cache_hit,
    }
}

fn fingerprint_context_sources<'a>(
    sources: impl Iterator<Item = &'a WorkflowContextSource>,
) -> String {
    let mut hasher = Sha256::new();
    for source in sources.filter(|source| source.selected) {
        hasher.update(source.phase.as_bytes());
        hasher.update([0]);
        hasher.update(source.kind.as_bytes());
        hasher.update([0]);
        hasher.update(source.path.as_bytes());
        hasher.update([0]);
        hasher.update(source.fingerprint.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn build_context_plan(
    rules: &[WorkflowRuleCandidate],
    knowledge_candidates: &[WorkflowKnowledgeCandidate],
    completion_plan: &WorkflowCompletionPlan,
    source_errors: &mut Vec<String>,
) -> WorkflowContextPlan {
    let mut sources = Vec::new();
    let mut mandatory_tokens = 0usize;
    for rule in rules.iter().filter(|rule| rule.scope != "nested") {
        let path = Path::new(&rule.path);
        if fs::metadata(path).is_ok_and(|metadata| metadata.len() > MAX_RULE_FILE_BYTES) {
            source_errors.push(format!(
                "workflow rule exceeds context limit: {}",
                rule.path
            ));
            continue;
        }
        match fs::read_to_string(path) {
            Ok(content) => {
                let estimated_tokens = estimate_tokens(&content);
                mandatory_tokens = mandatory_tokens.saturating_add(estimated_tokens);
                sources.push(WorkflowContextSource {
                    phase: "stable".to_string(),
                    kind: rule.kind.clone(),
                    path: rule.path.clone(),
                    fingerprint: content_fingerprint(&content),
                    estimated_tokens,
                    selected: true,
                });
            }
            Err(error) => source_errors.push(format!(
                "workflow rule unavailable for context plan: {} ({error})",
                rule.path
            )),
        }
    }

    let mut selected_tokens = mandatory_tokens;
    if completion_plan.required {
        let serialized = serde_json::to_string(completion_plan).unwrap_or_default();
        let estimated_tokens = estimate_tokens(&serialized);
        selected_tokens = selected_tokens.saturating_add(estimated_tokens);
        sources.push(WorkflowContextSource {
            phase: "dynamic".to_string(),
            kind: "workflow".to_string(),
            path: "cm://workflow/completion".to_string(),
            fingerprint: content_fingerprint(&serialized),
            estimated_tokens,
            selected: true,
        });
    }
    for candidate in knowledge_candidates {
        let fits_budget = selected_tokens.saturating_add(candidate.estimated_tokens)
            <= DEFAULT_CONTEXT_BUDGET_TOKENS;
        if fits_budget {
            selected_tokens = selected_tokens.saturating_add(candidate.estimated_tokens);
        }
        sources.push(WorkflowContextSource {
            phase: "dynamic".to_string(),
            kind: "knowledge".to_string(),
            path: candidate.path.clone(),
            fingerprint: candidate.content_fingerprint.clone(),
            estimated_tokens: candidate.estimated_tokens,
            selected: fits_budget,
        });
    }

    let stable_prefix_fingerprint =
        fingerprint_context_sources(sources.iter().filter(|source| source.phase == "stable"));
    let dynamic_context_fingerprint =
        fingerprint_context_sources(sources.iter().filter(|source| source.phase == "dynamic"));
    let context_fingerprint = fingerprint_context_sources(sources.iter());
    WorkflowContextPlan {
        context_fingerprint,
        stable_prefix_fingerprint,
        dynamic_context_fingerprint,
        budget_tokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
        mandatory_tokens,
        selected_tokens,
        truncated: sources.iter().any(|source| !source.selected),
        sources,
    }
}

fn contains_any(task: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| task.contains(term))
}

fn analyze_impacts(task: &str) -> Vec<WorkflowImpactItem> {
    let task = task.to_lowercase();
    let mut impacts = Vec::new();
    let definitions = [
        (
            "provider-model",
            &[
                "provider",
                "model",
                "opencode",
                "codex",
                "模型",
                "服务商",
                "配置",
            ] as &[&str],
            "Provider or model selection may affect runtime capability negotiation.",
            &[
                "npm run test -- src/features/models",
                "cd src-tauri && cargo check",
            ] as &[&str],
        ),
        (
            "capability-runtime",
            &[
                "skill",
                "agent",
                "workflow",
                "知识库",
                "工作流",
                "能力",
                "触发",
            ],
            "Capability registry, trigger, or knowledge behavior may change.",
            &[
                "npm run test -- src/features/workflow",
                "cd src-tauri && cargo test workflow_ --lib",
            ],
        ),
        (
            "frontend-ui-i18n",
            &["ui", "界面", "窗口", "按钮", "页面", "显示", "文案", "i18n"],
            "Frontend presentation or localized behavior may change.",
            &[
                "npm run test",
                "npm run typecheck",
                "visual runtime verification",
            ],
        ),
        (
            "backend-daemon-ipc",
            &[
                "backend",
                "daemon",
                "rpc",
                "ipc",
                "tauri",
                "后端",
                "守护进程",
            ],
            "Shared backend behavior requires App and Daemon parity.",
            &[
                "cd src-tauri && cargo check",
                "verify App/Daemon command parity",
            ],
        ),
        (
            "persistence-config",
            &["save", "persist", "保存", "持久化", "设置", "配置"],
            "Persisted settings or migration behavior may change.",
            &[
                "npm run test -- src/features/settings",
                "cd src-tauri && cargo check",
            ],
        ),
        (
            "test-build-release",
            &["test", "build", "release", "测试", "构建", "打包", "发布"],
            "Validation or packaging surfaces are directly in scope.",
            &["npm run typecheck", "npm run test"],
        ),
    ];
    for (area, terms, reason, validations) in definitions {
        if contains_any(&task, terms) {
            impacts.push(WorkflowImpactItem {
                area: area.to_string(),
                reason: reason.to_string(),
                validation: validations.iter().map(|value| value.to_string()).collect(),
            });
        }
    }
    if impacts.is_empty() {
        impacts.push(WorkflowImpactItem {
            area: "workspace-source".to_string(),
            reason: "Task may change workspace source or configuration.".to_string(),
            validation: vec!["run focused tests for changed modules".to_string()],
        });
    }
    impacts
}

fn requires_completion_workflow(task: &str) -> bool {
    let task = task.to_lowercase();
    let ascii_terms = [
        "implement",
        "modify",
        "update",
        "add",
        "create",
        "remove",
        "delete",
        "refactor",
        "debug",
        "diagnose",
        "fix",
        "fixed",
        "fixing",
        "review",
        "check",
        "test",
        "build",
        "release",
    ];
    let ascii_match = task
        .split(|character: char| {
            !character.is_ascii_alphanumeric() && character != '-' && character != '_'
        })
        .filter(|token| !token.is_empty())
        .any(|token| ascii_terms.contains(&token));
    ascii_match
        || contains_any(
            &task,
            &[
                "实现",
                "修改",
                "更新",
                "增加",
                "新增",
                "添加",
                "创建",
                "移除",
                "删除",
                "重构",
                "排查",
                "修复",
                "审查",
                "检查",
                "测试",
                "运行",
                "启动",
                "构建",
                "打包",
                "发布",
                "执行方案",
            ],
        )
}

fn validation_kind(instruction: &str) -> String {
    if instruction.starts_with("npm ")
        || instruction.starts_with("cargo ")
        || instruction.starts_with("cd ")
    {
        "command".to_string()
    } else {
        "manual".to_string()
    }
}

fn knowledge_category(task: &str) -> String {
    let task = task.to_lowercase();
    if contains_any(
        &task,
        &[
            "bug", "debug", "diagnose", "失败", "错误", "异常", "修复", "排查",
        ],
    ) {
        "bug".to_string()
    } else if contains_any(
        &task,
        &[
            "architecture",
            "design",
            "workflow",
            "架构",
            "方案",
            "工作流",
            "决策",
        ],
    ) {
        "decision".to_string()
    } else {
        "checkpoint".to_string()
    }
}

fn build_completion_plan(task: &str, impacts: &[WorkflowImpactItem]) -> WorkflowCompletionPlan {
    let required = requires_completion_workflow(task);
    let mut validations = Vec::new();
    if required {
        let mut by_instruction = Vec::<(String, Vec<String>)>::new();
        for impact in impacts {
            for instruction in &impact.validation {
                if let Some((_, areas)) = by_instruction
                    .iter_mut()
                    .find(|(current, _)| current == instruction)
                {
                    if !areas.contains(&impact.area) {
                        areas.push(impact.area.clone());
                    }
                } else {
                    by_instruction.push((instruction.clone(), vec![impact.area.clone()]));
                }
            }
        }
        if !by_instruction
            .iter()
            .any(|(instruction, _)| instruction == "npm run typecheck")
        {
            by_instruction.push((
                "npm run typecheck".to_string(),
                vec!["project-baseline".to_string()],
            ));
        }
        validations = by_instruction
            .into_iter()
            .enumerate()
            .map(
                |(index, (instruction, source_areas))| WorkflowValidationGate {
                    id: format!("validation-{}", index + 1),
                    kind: validation_kind(&instruction),
                    instruction,
                    status: "pending".to_string(),
                    source_areas,
                },
            )
            .collect();
    }
    WorkflowCompletionPlan {
        required,
        phase: if required {
            "focused_validation".to_string()
        } else {
            "not_required".to_string()
        },
        validations,
        changed_diff_review: WorkflowChangedDiffReviewGate {
            required,
            status: if required { "pending" } else { "not_required" }.to_string(),
            scope: "task-owned-changed-diff".to_string(),
        },
        knowledge_capture: WorkflowKnowledgeCaptureCandidate {
            status: if required { "evaluate" } else { "not_required" }.to_string(),
            category: knowledge_category(task),
            reason: "Capture only validated reusable requirements, decisions, root causes, or regression constraints."
                .to_string(),
            submission_mode: "candidate-only-concurrency-safe".to_string(),
        },
    }
}

fn completion_context_fragment(
    completion_plan: &WorkflowCompletionPlan,
) -> Option<WorkflowContextFragment> {
    if !completion_plan.required {
        return None;
    }
    let validations = completion_plan
        .validations
        .iter()
        .map(|gate| format!("- [{}] {}", gate.kind, gate.instruction))
        .collect::<Vec<_>>()
        .join("\n");
    Some(WorkflowContextFragment {
        source_id: "cm.workflow.completion".to_string(),
        kind: "application".to_string(),
        value: format!(
            "CM completion workflow (host-enforced):\n{validations}\n- Review only the task-owned changed diff after validation.\n- Perform applicable runtime verification before claiming completion.\n- Evaluate durable knowledge; submit only validated candidates through the configured concurrency-safe knowledge tools. Never overwrite a hash conflict.\n- Report incomplete gates explicitly; do not imply completion without evidence."
        ),
    })
}

fn truncate_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn rule_context_fragments(rules: &[WorkflowRuleCandidate]) -> Vec<WorkflowContextFragment> {
    let mut total_chars = 0;
    let mut fragments = Vec::new();
    for rule in rules.iter().filter(|rule| rule.scope != "nested") {
        if total_chars >= MAX_RULE_CONTEXT_CHARS {
            break;
        }
        let path = Path::new(&rule.path);
        if fs::metadata(path).is_ok_and(|metadata| metadata.len() > MAX_RULE_FILE_BYTES) {
            continue;
        }
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        let remaining = MAX_RULE_CONTEXT_CHARS - total_chars;
        let body = truncate_chars(&content, remaining.min(MAX_CONTEXT_FRAGMENT_CHARS));
        if body.trim().is_empty() {
            continue;
        }
        total_chars += body.chars().count();
        fragments.push(WorkflowContextFragment {
            source_id: format!("cm.rule.{}", fragments.len()),
            kind: "application".to_string(),
            value: format!("CM rule source: {}\n{}", rule.path, body),
        });
    }
    fragments
}

fn knowledge_excerpt(candidate: &WorkflowKnowledgeCandidate) -> Option<String> {
    let lines = candidate.content.lines().collect::<Vec<_>>();
    let normalized_terms = candidate
        .matched_terms
        .iter()
        .map(|term| term.to_lowercase())
        .collect::<Vec<_>>();
    let match_index = lines.iter().position(|line| {
        let normalized = line.to_lowercase();
        normalized_terms
            .iter()
            .any(|term| normalized.contains(term))
    });
    let start = match_index
        .map(|index| index.saturating_sub(3))
        .unwrap_or(0);
    let end = match_index
        .map(|index| (index + 7).min(lines.len()))
        .unwrap_or_else(|| lines.len().min(30));
    let excerpt = lines[start..end].join("\n");
    (!excerpt.trim().is_empty()).then(|| {
        truncate_chars(
            &format!(
                "CM knowledge reference (context only; not an execution task): {}\nTitle: {}\n{}",
                candidate.path, candidate.title, excerpt
            ),
            MAX_CONTEXT_FRAGMENT_CHARS,
        )
    })
}

fn knowledge_context_fragments(
    candidates: &[WorkflowKnowledgeCandidate],
    context_plan: &WorkflowContextPlan,
) -> (
    Vec<WorkflowContextFragment>,
    Vec<WorkflowRetrievalSelection>,
) {
    let selected_paths = context_plan
        .sources
        .iter()
        .filter(|source| source.phase == "dynamic" && source.selected)
        .map(|source| source.path.as_str())
        .collect::<HashSet<_>>();
    let mut total_chars = 0;
    let mut fragments = Vec::new();
    let mut selections = Vec::new();
    for candidate in candidates
        .iter()
        .filter(|candidate| selected_paths.contains(candidate.path.as_str()))
        .take(3)
    {
        if total_chars >= MAX_KNOWLEDGE_CONTEXT_CHARS {
            break;
        }
        let Some(excerpt) = knowledge_excerpt(candidate) else {
            continue;
        };
        let remaining = MAX_KNOWLEDGE_CONTEXT_CHARS - total_chars;
        let value = truncate_chars(&excerpt, remaining);
        total_chars += value.chars().count();
        fragments.push(WorkflowContextFragment {
            source_id: format!("cm.knowledge.{}", fragments.len()),
            kind: "application".to_string(),
            value,
        });
        selections.push(WorkflowRetrievalSelection {
            knowledge_id: candidate.knowledge_id.clone(),
            path: candidate.path.clone(),
            content_fingerprint: candidate.content_fingerprint.clone(),
            estimated_tokens: estimate_tokens(&fragments.last().expect("fragment").value),
            freshness: candidate.freshness.clone(),
        });
    }
    (fragments, selections)
}

fn build_retrieval_receipt(
    task: &str,
    ranking: &RankedKnowledge,
    context_plan: &WorkflowContextPlan,
    selected: Vec<WorkflowRetrievalSelection>,
) -> WorkflowRetrievalReceipt {
    let selected_paths = selected
        .iter()
        .map(|item| item.path.as_str())
        .collect::<HashSet<_>>();
    let planned_paths = context_plan
        .sources
        .iter()
        .filter(|source| source.phase == "dynamic" && source.selected)
        .map(|source| source.path.as_str())
        .collect::<HashSet<_>>();
    let mut omitted = ranking.omissions.clone();
    for candidate in &ranking.candidates {
        if selected_paths.contains(candidate.path.as_str()) {
            continue;
        }
        omitted.push(WorkflowRetrievalOmission {
            knowledge_id: candidate.knowledge_id.clone(),
            path: candidate.path.clone(),
            reason: if planned_paths.contains(candidate.path.as_str()) {
                "context_fragment_limit"
            } else {
                "context_budget"
            }
            .to_string(),
            detail: String::new(),
        });
    }
    WorkflowRetrievalReceipt {
        schema_version: 1,
        query_fingerprint: content_fingerprint(task),
        project_id: ranking.project_id.clone(),
        index_revision: ranking.index_revision.clone(),
        estimated_injected_tokens: selected.iter().map(|item| item.estimated_tokens).sum(),
        selected,
        omitted,
        cache_hit: ranking.cache_hit,
    }
}

fn retrieval_receipt_fragment(receipt: &WorkflowRetrievalReceipt) -> WorkflowContextFragment {
    let selected = receipt
        .selected
        .iter()
        .map(|item| {
            format!(
                "{}@{}",
                item.knowledge_id,
                item.content_fingerprint
                    .chars()
                    .take(12)
                    .collect::<String>()
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let omitted = receipt
        .omitted
        .iter()
        .take(8)
        .map(|item| format!("{}:{}", item.knowledge_id, item.reason))
        .collect::<Vec<_>>()
        .join(",");
    WorkflowContextFragment {
        source_id: "cm.knowledge.receipt".to_string(),
        kind: "application".to_string(),
        value: format!(
            "CM retrieval receipt (do not reread unchanged sources): query={} project={} index={} selected=[{}] omitted=[{}]",
            receipt.query_fingerprint,
            receipt.project_id,
            receipt.index_revision,
            selected,
            omitted
        ),
    }
}

fn build_preview(
    workspace_name: &str,
    workspace_path: &Path,
    task: &str,
    mode: String,
    provider_kind: String,
    model: Option<String>,
    knowledge_root: Option<&Path>,
) -> WorkflowHostPreflightPreview {
    let rules = discover_rules(workspace_path);
    let mut source_errors = Vec::new();
    let ranking = rank_knowledge(
        knowledge_root,
        workspace_name,
        workspace_path,
        task,
        &mut source_errors,
    );
    let impacts = analyze_impacts(task);
    let completion_plan = build_completion_plan(task, &impacts);
    let context_plan = build_context_plan(
        &rules,
        &ranking.candidates,
        &completion_plan,
        &mut source_errors,
    );
    let mut context_fragments = rule_context_fragments(&rules);
    let (knowledge_fragments, selected_knowledge) =
        knowledge_context_fragments(&ranking.candidates, &context_plan);
    let retrieval_receipt =
        build_retrieval_receipt(task, &ranking, &context_plan, selected_knowledge);
    if !retrieval_receipt.selected.is_empty() || !retrieval_receipt.omitted.is_empty() {
        context_fragments.push(retrieval_receipt_fragment(&retrieval_receipt));
    }
    context_fragments.extend(knowledge_fragments);
    if let Some(fragment) = completion_context_fragment(&completion_plan) {
        context_fragments.push(fragment);
    }
    let impact_summary = impacts
        .iter()
        .map(|impact| impact.area.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let mut validation_suggestions = Vec::new();
    for impact in &impacts {
        for validation in &impact.validation {
            if !validation_suggestions.contains(validation) {
                validation_suggestions.push(validation.clone());
            }
        }
    }
    WorkflowHostPreflightPreview {
        mode,
        provider_kind,
        model,
        task_length: task.chars().count(),
        rules,
        knowledge_candidates: ranking.candidates,
        impacts,
        impact_summary,
        validation_suggestions,
        source_errors,
        knowledge_cache_hit: ranking.cache_hit,
        retrieval_receipt,
        context_fragments,
        context_plan,
        completion_plan,
        workflow_gate: None,
    }
}

pub(crate) async fn workflow_preflight_preview_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    task: String,
    mode: Option<String>,
    provider_kind: String,
    model: Option<String>,
    workflow_id: Option<String>,
) -> Result<Value, String> {
    let (workspace_name, workspace_path) = {
        let workspaces = workspaces.lock().await;
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or_else(|| "workspace not found".to_string())?;
        (workspace.name.clone(), PathBuf::from(&workspace.path))
    };
    let root = knowledge_root();
    let mode = match mode.as_deref() {
        Some("shadow") => "shadow".to_string(),
        _ => "active".to_string(),
    };
    let preview_task = tokio::task::spawn_blocking(move || {
        build_preview(
            &workspace_name,
            &workspace_path,
            &task,
            mode,
            provider_kind,
            model,
            root.as_deref(),
        )
    });
    let workflow_gate = match workflow_id {
        Some(workflow_id) => Some(
            workflow_gate_adapter_core::workflow_gate_status_core(
                workspaces,
                workspace_id,
                workflow_id,
            )
            .await?,
        ),
        None => None,
    };
    let mut preview = preview_task
        .await
        .map_err(|error| format!("workflow preflight task failed: {error}"))?;
    preview.workflow_gate = workflow_gate;
    serde_json::to_value(preview).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("codex-monitor-preflight-{label}-{nonce}"))
    }

    #[test]
    fn discovers_rules_and_ranks_project_knowledge_without_returning_task() {
        let root = temp_root("knowledge");
        let workspace = root.join("ThreadFleet");
        let nested = workspace.join("src").join("feature");
        let knowledge = root
            .join("knowledge")
            .join("20-项目知识")
            .join("ThreadFleet")
            .join("BUG");
        fs::create_dir_all(&nested).expect("nested workspace");
        fs::create_dir_all(&knowledge).expect("knowledge dir");
        fs::write(workspace.join("AGENTS.md"), "rules").expect("workspace rules");
        fs::write(nested.join("RTK.md"), "nested rules").expect("nested rules");
        fs::write(
            knowledge.join("模型刷新.md"),
            "# 模型刷新故障\nProvider 模型列表刷新与配置切换。",
        )
        .expect("knowledge note");
        let task = "排查模型列表刷新失败";

        let preview = build_preview(
            "ThreadFleet",
            &workspace,
            task,
            "active".to_string(),
            "opencode".to_string(),
            Some("test-model".to_string()),
            Some(&root.join("knowledge")),
        );

        assert!(preview.rules.iter().any(|rule| rule.kind == "AGENTS.md"));
        assert!(preview.rules.iter().any(|rule| rule.scope == "nested"));
        assert_eq!(preview.knowledge_candidates[0].title, "模型刷新故障");
        assert!(!preview.knowledge_cache_hit);
        let cached = build_preview(
            "ThreadFleet",
            &workspace,
            task,
            "active".to_string(),
            "opencode".to_string(),
            Some("test-model".to_string()),
            Some(&root.join("knowledge")),
        );
        assert!(cached.knowledge_cache_hit);
        assert!(preview
            .context_fragments
            .iter()
            .any(|fragment| fragment.source_id.starts_with("cm.rule.")));
        assert!(preview
            .context_fragments
            .iter()
            .any(|fragment| fragment.source_id.starts_with("cm.knowledge.")));
        assert_eq!(
            cached.context_plan.context_fingerprint,
            preview.context_plan.context_fingerprint
        );
        assert_eq!(
            preview.context_plan.budget_tokens,
            DEFAULT_CONTEXT_BUDGET_TOKENS
        );
        assert!(preview
            .context_plan
            .sources
            .iter()
            .any(|source| source.kind == "knowledge"));
        assert_eq!(preview.retrieval_receipt.selected.len(), 1);
        assert!(preview.context_fragments.iter().any(|fragment| {
            fragment.source_id == "cm.knowledge.receipt"
                && fragment.value.contains("do not reread unchanged sources")
        }));
        let serialized = serde_json::to_string(&preview).expect("preview json");
        assert!(!serialized.contains(task));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn declared_unverifiable_source_revision_is_omitted() {
        let root = temp_root("knowledge-freshness");
        let workspace = root.join("ThreadFleet");
        let knowledge = root
            .join("knowledge")
            .join("20-项目知识")
            .join("ThreadFleet")
            .join("BUG");
        fs::create_dir_all(&workspace).expect("workspace");
        fs::create_dir_all(&knowledge).expect("knowledge dir");
        fs::write(
            knowledge.join("stale.md"),
            "---\nid: stale-knowledge\n项目: ThreadFleet\n状态: active\n实现状态: verified\nsource_project: ThreadFleet\nsource_revision: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsource_branch: main\nverified_at: 2026-07-22\n---\n# 检索控制面完整实现\n检索控制面完整实现。",
        )
        .expect("knowledge note");

        let preview = build_preview(
            "ThreadFleet",
            &workspace,
            "检索控制面完整实现",
            "active".to_string(),
            "openai".to_string(),
            None,
            Some(&root.join("knowledge")),
        );

        assert!(preview.knowledge_candidates.is_empty());
        assert!(preview.retrieval_receipt.omitted.iter().any(|item| {
            item.knowledge_id == "stale-knowledge" && item.reason == "source_revision_unverifiable"
        }));
        assert!(!preview.context_fragments.iter().any(|fragment| {
            fragment.source_id.starts_with("cm.knowledge.")
                && fragment.source_id != "cm.knowledge.receipt"
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_revision_ancestor_remains_current_across_branches() {
        let repository = Repository::discover(env!("CARGO_MANIFEST_DIR")).expect("repository");
        let head = repository.head().expect("head");
        let revision = head.target().expect("head oid").to_string();
        let branch = head.shorthand().unwrap_or_default().to_string();
        let mut document = KnowledgeDocument {
            knowledge_id: "current-knowledge".to_string(),
            project_id: "codex-monitor".to_string(),
            path: "knowledge.md".to_string(),
            title: "Knowledge".to_string(),
            normalized_path: "knowledge.md".to_string(),
            normalized_title: "knowledge".to_string(),
            normalized_content: "knowledge".to_string(),
            content_fingerprint: content_fingerprint("knowledge"),
            estimated_tokens: 3,
            lifecycle_status: "active".to_string(),
            implementation_status: "verified".to_string(),
            source_project: "codex-monitor".to_string(),
            source_revision: revision,
            source_branch: branch,
            verified_at: "2026-07-22".to_string(),
            content: "knowledge".to_string(),
        };

        let current = knowledge_freshness(&document, Some(&repository));
        assert_eq!(current.state, "current");
        assert_eq!(current.reason, "source_revision_is_ancestor");

        document.source_branch = "different-branch".to_string();
        let current_on_branch = knowledge_freshness(&document, Some(&repository));
        assert_eq!(current_on_branch.state, "current");
        assert_eq!(current_on_branch.reason, "source_revision_is_ancestor");
    }

    #[test]
    fn ignores_generic_fix_requests_but_keeps_specific_knowledge_matches() {
        let root = temp_root("knowledge-confidence");
        let workspace = root.join("ThreadFleet");
        let knowledge = root
            .join("knowledge")
            .join("20-项目知识")
            .join("ThreadFleet")
            .join("BUG");
        fs::create_dir_all(&workspace).expect("workspace");
        fs::create_dir_all(&knowledge).expect("knowledge dir");
        for (name, title) in [
            ("session-layout.md", "会话管理切换首次加载与布局修复"),
            ("session-shadow.md", "本机历史会话阴影修复被覆盖"),
            ("session-scroll.md", "会话滚动 UI 字号与附件体验修复"),
        ] {
            fs::write(
                knowledge.join(name),
                format!("# {title}\n该条目记录一个已验证的修复。"),
            )
            .expect("knowledge note");
        }

        let generic = build_preview(
            "ThreadFleet",
            &workspace,
            "开始修复",
            "active".to_string(),
            "opencode".to_string(),
            None,
            Some(&root.join("knowledge")),
        );
        assert!(generic.knowledge_candidates.is_empty());
        assert!(!generic
            .context_fragments
            .iter()
            .any(|fragment| fragment.source_id.starts_with("cm.knowledge.")));

        let broad_domain = build_preview(
            "ThreadFleet",
            &workspace,
            "会话管理",
            "active".to_string(),
            "opencode".to_string(),
            None,
            Some(&root.join("knowledge")),
        );
        assert!(broad_domain.knowledge_candidates.is_empty());

        let specific = build_preview(
            "ThreadFleet",
            &workspace,
            "排查会话管理切换首次加载与布局修复",
            "active".to_string(),
            "opencode".to_string(),
            None,
            Some(&root.join("knowledge")),
        );
        assert_eq!(
            specific.knowledge_candidates[0].title,
            "会话管理切换首次加载与布局修复"
        );
        assert!(specific.context_fragments.iter().any(|fragment| {
            fragment.source_id.starts_with("cm.knowledge.")
                && fragment.value.contains("not an execution task")
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn context_plan_keeps_rules_and_deterministically_budgets_dynamic_sources() {
        let root = temp_root("context-plan");
        fs::create_dir_all(&root).expect("context plan root");
        let rule_path = root.join("AGENTS.md");
        fs::write(&rule_path, "stable rules").expect("rule file");
        let rules = vec![WorkflowRuleCandidate {
            path: normalized_path(&rule_path),
            kind: "AGENTS.md".to_string(),
            scope: "workspace".to_string(),
        }];
        let knowledge = vec![
            WorkflowKnowledgeCandidate {
                knowledge_id: "small-id".to_string(),
                path: "D:/knowledge/small.md".to_string(),
                title: "Small".to_string(),
                score: 10,
                matched_terms: vec!["small".to_string()],
                content_fingerprint: content_fingerprint("small"),
                estimated_tokens: 10,
                freshness: WorkflowKnowledgeFreshness {
                    state: "unknown".to_string(),
                    reason: "source_revision_missing".to_string(),
                    source_project: String::new(),
                    source_revision: String::new(),
                    source_branch: String::new(),
                    verified_at: String::new(),
                    implementation_status: String::new(),
                },
                content: "small".to_string(),
            },
            WorkflowKnowledgeCandidate {
                knowledge_id: "large-id".to_string(),
                path: "D:/knowledge/large.md".to_string(),
                title: "Large".to_string(),
                score: 5,
                matched_terms: vec!["large".to_string()],
                content_fingerprint: content_fingerprint("large"),
                estimated_tokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
                freshness: WorkflowKnowledgeFreshness {
                    state: "unknown".to_string(),
                    reason: "source_revision_missing".to_string(),
                    source_project: String::new(),
                    source_revision: String::new(),
                    source_branch: String::new(),
                    verified_at: String::new(),
                    implementation_status: String::new(),
                },
                content: "large".to_string(),
            },
        ];
        let mut errors = Vec::new();

        let completion = build_completion_plan("implement workflow", &[]);
        let first = build_context_plan(&rules, &knowledge, &completion, &mut errors);
        let second = build_context_plan(&rules, &knowledge, &completion, &mut errors);

        assert!(errors.is_empty());
        assert!(first.sources[0].selected);
        assert!(first.sources[1].selected);
        assert!(
            !first
                .sources
                .iter()
                .find(|source| source.path == "D:/knowledge/large.md")
                .expect("large knowledge source")
                .selected
        );
        assert!(first.truncated);
        assert_eq!(first.context_fingerprint, second.context_fingerprint);
        assert_eq!(
            first.stable_prefix_fingerprint,
            second.stable_prefix_fingerprint
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn impact_analysis_covers_cross_runtime_workflow_changes() {
        let impacts = analyze_impacts("修改 opencode skill 工作流和 daemon IPC 测试");
        let areas = impacts
            .iter()
            .map(|impact| impact.area.as_str())
            .collect::<Vec<_>>();
        assert!(areas.contains(&"provider-model"));
        assert!(areas.contains(&"capability-runtime"));
        assert!(areas.contains(&"backend-daemon-ipc"));
        assert!(areas.contains(&"test-build-release"));
    }

    #[test]
    fn completion_plan_requires_validation_review_and_safe_knowledge_evaluation() {
        let task = "修复 provider workflow 并运行测试";
        let impacts = analyze_impacts(task);
        let completion = build_completion_plan(task, &impacts);

        assert!(completion.required);
        assert_eq!(completion.phase, "focused_validation");
        assert_eq!(completion.changed_diff_review.status, "pending");
        assert_eq!(completion.knowledge_capture.status, "evaluate");
        assert_eq!(
            completion.knowledge_capture.submission_mode,
            "candidate-only-concurrency-safe"
        );
        assert!(completion
            .validations
            .iter()
            .any(|gate| gate.instruction == "npm run typecheck"));
        assert!(completion
            .validations
            .iter()
            .any(|gate| gate.instruction == "cd src-tauri && cargo test workflow_ --lib"));
        let fragment = completion_context_fragment(&completion).expect("completion fragment");
        assert!(fragment.value.contains("task-owned changed diff"));
        assert!(fragment.value.contains("Never overwrite a hash conflict"));
    }

    #[test]
    fn completion_plan_uses_bounded_change_intent_matching() {
        let completion =
            build_completion_plan("preview 当前模型", &analyze_impacts("preview 当前模型"));

        assert!(!completion.required);
        assert_eq!(completion.phase, "not_required");
        assert!(completion.validations.is_empty());
        assert_eq!(completion.changed_diff_review.status, "not_required");
        assert_eq!(completion.knowledge_capture.status, "not_required");
        assert!(completion_context_fragment(&completion).is_none());

        let change = build_completion_plan("增加诊断入口", &analyze_impacts("增加诊断入口"));
        assert!(change.required);
    }
}
