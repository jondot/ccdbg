//! Streaming JSONL parsing + session construction.
//!
//! The JSONL format emitted by Claude Code has heterogeneous record types
//! ("user", "assistant", "progress", "file-history-snapshot", ...). Only
//! "user" and "assistant" records are relevant for analysis. We deserialize
//! into a permissive `RawRecord` struct and filter/dispatch downstream.

use crate::model::{Session, ToolCall, TokenTotals, Turn, TurnRole};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct RawRecord {
    #[serde(rename = "type")]
    pub rtype: Option<String>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub timestamp: Option<DateTime<Utc>>,
    pub uuid: Option<String>,
    #[serde(rename = "parentUuid")]
    pub parent_uuid: Option<String>,
    #[serde(rename = "isSidechain")]
    pub is_sidechain: bool,
    #[serde(rename = "isApiErrorMessage")]
    pub is_api_error_message: bool,
    pub message: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct RawUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_creation: Option<RawCacheCreation>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct RawCacheCreation {
    pub ephemeral_5m_input_tokens: u64,
    pub ephemeral_1h_input_tokens: u64,
}

impl RawUsage {
    pub fn to_token_totals(&self) -> TokenTotals {
        let (c5, c1) = match &self.cache_creation {
            Some(cc) => (cc.ephemeral_5m_input_tokens, cc.ephemeral_1h_input_tokens),
            // Fall back to flat cache_creation_input_tokens, charged as 5m
            None => (self.cache_creation_input_tokens, 0),
        };
        TokenTotals {
            input: self.input_tokens,
            output: self.output_tokens,
            cache_read: self.cache_read_input_tokens,
            cache_creation_5m: c5,
            cache_creation_1h: c1,
        }
    }
}

/// Parse a JSONL file line-by-line. Bad lines are skipped silently.
pub fn parse_jsonl(path: &Path) -> Result<Vec<RawRecord>> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<RawRecord>(&line) {
            Ok(r) => out.push(r),
            Err(_) => continue, // tolerate malformed lines
        }
    }
    Ok(out)
}

/// Normalize a Claude Code `cwd` value into a canonical project path.
///
/// Rules (preserving predecessor behavior):
///   - `/<repo>/.claude/worktrees/<name>` → `/<repo>` (in-project worktrees)
///   - `<home>/.claude-squad/worktrees/<1-or-2-segments>` → `home-directory`
///   - otherwise: unchanged
pub fn normalize_project(cwd: &str) -> String {
    // Strip `/.claude/worktrees/<name>` suffix
    if let Some(idx) = cwd.rfind("/.claude/worktrees/") {
        return cwd[..idx].to_string();
    }
    // Claude-squad worktrees: <home>/.claude-squad/worktrees/<dir>[/<sub>]
    if cwd.contains("/.claude-squad/worktrees/") {
        return "home-directory".to_string();
    }
    cwd.to_string()
}

/// A deduplicated assistant API call — one entry per unique message.id.
/// Collects content blocks across all source records, preserves the first
/// seen timestamp + cwd + sessionId + isSidechain.
#[derive(Debug, Clone)]
pub struct AssistantMessage {
    pub message_id: String,
    pub session_id: String,
    pub cwd: String,
    pub timestamp: DateTime<Utc>,
    pub model: String,
    pub usage: TokenTotals,
    pub is_sidechain: bool,
    pub content_blocks: Vec<serde_json::Value>,
    pub is_synthetic: bool,
    pub is_api_error: bool,
}

/// A user turn, keyed by uuid. Carries any tool_result blocks so we can
/// correlate errors back to the assistant's tool_use.
#[derive(Debug, Clone)]
pub struct UserMessage {
    pub uuid: String,
    pub session_id: String,
    pub cwd: String,
    pub timestamp: DateTime<Utc>,
    pub is_sidechain: bool,
    pub tool_results: Vec<ToolResult>,
    pub text: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub tool_use_id: String,
    pub is_error: bool,
}

#[derive(Debug, Deserialize)]
struct MsgAssistant {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    content: Vec<serde_json::Value>,
    #[serde(default)]
    usage: Option<RawUsage>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum MsgUser {
    Structured { content: Vec<serde_json::Value> },
    Plain(String),
}

/// Turn a list of raw records into deduped assistant messages + user messages.
/// Non-user/assistant records are dropped.
pub fn group_messages(recs: Vec<RawRecord>) -> (Vec<AssistantMessage>, Vec<UserMessage>) {
    use std::collections::HashMap;
    let mut assist: HashMap<String, AssistantMessage> = HashMap::new();
    let mut user_msgs: Vec<UserMessage> = Vec::new();

    for r in recs {
        let Some(rtype) = r.rtype.as_deref() else {
            continue;
        };
        let Some(ts) = r.timestamp else { continue };
        let sid = r.session_id.clone().unwrap_or_default();
        let cwd = r.cwd.clone().unwrap_or_default();

        match rtype {
            "assistant" => {
                let Some(msg_json) = r.message else { continue };
                let Ok(m) = serde_json::from_value::<MsgAssistant>(msg_json) else {
                    continue;
                };
                let Some(msg_id) = m.id else { continue };
                let model = m.model.unwrap_or_else(|| "unknown".into());
                let usage = m.usage.map(|u| u.to_token_totals()).unwrap_or_default();
                let is_synthetic = model == "<synthetic>";

                assist
                    .entry(msg_id.clone())
                    .and_modify(|existing| {
                        existing.content_blocks.extend(m.content.clone());
                    })
                    .or_insert(AssistantMessage {
                        message_id: msg_id,
                        session_id: sid,
                        cwd,
                        timestamp: ts,
                        model,
                        usage,
                        is_sidechain: r.is_sidechain,
                        content_blocks: m.content,
                        is_synthetic,
                        is_api_error: r.is_api_error_message,
                    });
            }
            "user" => {
                let Some(uuid) = r.uuid.clone() else { continue };
                let (content, text) = match r.message {
                    Some(v) => match serde_json::from_value::<MsgUser>(v) {
                        Ok(MsgUser::Structured { content }) => {
                            // Extract the first text-type content block as the user prompt
                            let text = content
                                .iter()
                                .find(|b| {
                                    b.get("type").and_then(|t| t.as_str()) == Some("text")
                                })
                                .and_then(|b| b.get("text").and_then(|t| t.as_str()))
                                .map(|s| s.to_string());
                            (content, text)
                        }
                        Ok(MsgUser::Plain(s)) => (vec![], Some(s)),
                        Err(_) => (vec![], None),
                    },
                    None => (vec![], None),
                };

                let mut tool_results = Vec::new();
                for blk in &content {
                    if blk.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let tool_use_id = blk
                            .get("tool_use_id")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        let is_error = blk
                            .get("is_error")
                            .and_then(|b| b.as_bool())
                            .unwrap_or(false);
                        tool_results.push(ToolResult {
                            tool_use_id,
                            is_error,
                        });
                    }
                }

                user_msgs.push(UserMessage {
                    uuid,
                    session_id: sid,
                    cwd,
                    timestamp: ts,
                    is_sidechain: r.is_sidechain,
                    tool_results,
                    text,
                });
            }
            _ => {}
        }
    }

    let mut assist_vec: Vec<AssistantMessage> = assist.into_values().collect();
    assist_vec.sort_by_key(|a| a.timestamp);
    user_msgs.sort_by_key(|u| u.timestamp);
    (assist_vec, user_msgs)
}

/// Extract tool_use content blocks from an assistant message into `ToolCall`s.
fn extract_tool_calls_for_message(
    blocks: &[serde_json::Value],
    turn_index: usize,
    tool_results_by_id: &std::collections::HashMap<String, bool>, // id -> is_error
) -> Vec<ToolCall> {
    let mut out = Vec::new();
    for b in blocks {
        if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
            continue;
        }
        let tool = b
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("unknown")
            .to_string();
        let id = b
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or("")
            .to_string();
        let input_summary = summarize_tool_input(b.get("input"));
        // If we don't have a result, assume success (interrupted turn).
        let is_error = tool_results_by_id.get(&id).copied().unwrap_or(false);
        out.push(ToolCall {
            tool,
            input_summary,
            success: !is_error,
            turn_index,
        });
    }
    out
}

/// Tiny, predictable summary of a tool input: the first known string field
/// value (truncated to 120 chars), used for display and loop detection.
fn summarize_tool_input(input: Option<&serde_json::Value>) -> String {
    const KEYS: &[&str] = &["file_path", "path", "command", "pattern", "url"];
    let Some(obj) = input.and_then(|v| v.as_object()) else {
        return String::new();
    };
    for k in KEYS {
        if let Some(v) = obj.get(*k).and_then(|v| v.as_str()) {
            let mut s = v.to_string();
            if s.len() > 120 {
                let new_len = s.char_indices().nth(120).map_or(s.len(), |(i, _)| i);
                s.truncate(new_len);
            }
            return s;
        }
    }
    // Fallback: first string-valued field
    for (_, v) in obj {
        if let Some(s) = v.as_str() {
            let mut out = s.to_string();
            if out.len() > 120 {
                let new_len = out.char_indices().nth(120).map_or(out.len(), |(i, _)| i);
                out.truncate(new_len);
            }
            return out;
        }
    }
    String::new()
}

/// Count loops: 3+ consecutive tool calls with identical (tool, input_summary).
/// Each run of length >=3 counts as one loop (not length).
pub fn count_loops(tool_calls: &[ToolCall]) -> usize {
    let mut loops = 0;
    let mut run = 1usize;
    for w in tool_calls.windows(2) {
        if w[0].tool == w[1].tool && w[0].input_summary == w[1].input_summary {
            run += 1;
            if run == 3 {
                loops += 1; // count the run once when it reaches length 3
            }
        } else {
            run = 1;
        }
    }
    loops
}

/// Build Session records from deduped assistant messages + user messages.
pub fn build_sessions(
    assist: Vec<AssistantMessage>,
    users: Vec<UserMessage>,
    pricing: &crate::pricing::Pricing,
) -> Vec<Session> {
    use std::collections::HashMap;
    // Index tool_results by tool_use_id for O(1) lookup
    let mut tool_results_by_id: HashMap<String, bool> = HashMap::new();
    for u in &users {
        for tr in &u.tool_results {
            tool_results_by_id.insert(tr.tool_use_id.clone(), tr.is_error);
        }
    }

    // Group assistant messages by session_id
    let mut by_session: HashMap<String, Vec<AssistantMessage>> = HashMap::new();
    for a in assist {
        by_session.entry(a.session_id.clone()).or_default().push(a);
    }

    let mut sessions = Vec::new();
    for (sid, mut msgs) in by_session {
        msgs.sort_by_key(|m| m.timestamp);
        if msgs.is_empty() {
            continue;
        }

        let project_raw = msgs[0].cwd.clone();
        let project = normalize_project(&project_raw);
        let start_ts = msgs.first().unwrap().timestamp;
        let end_ts = msgs.last().unwrap().timestamp;

        let mut turns = Vec::with_capacity(msgs.len());
        let mut totals = TokenTotals::default();
        let mut cost = 0.0;
        let mut models_used: Vec<String> = Vec::new();
        let mut model_output: HashMap<String, u64> = HashMap::new();
        let mut has_errors = false;
        let mut has_sidechain = false;
        let mut peak_ctx: u64 = 0;
        let mut flat_calls: Vec<ToolCall> = Vec::new();

        for (i, m) in msgs.iter().enumerate() {
            if m.is_synthetic || m.is_api_error {
                has_errors = has_errors || m.is_api_error;
                continue;
            }
            if m.is_sidechain {
                has_sidechain = true;
            }

            let ctx = m.usage.context_window();
            if ctx > peak_ctx {
                peak_ctx = ctx;
            }
            totals.input += m.usage.input;
            totals.output += m.usage.output;
            totals.cache_read += m.usage.cache_read;
            totals.cache_creation_5m += m.usage.cache_creation_5m;
            totals.cache_creation_1h += m.usage.cache_creation_1h;
            cost += pricing.cost(&m.model, &m.usage);

            if !models_used.contains(&m.model) {
                models_used.push(m.model.clone());
            }
            *model_output.entry(m.model.clone()).or_insert(0) += m.usage.output;

            let calls =
                extract_tool_calls_for_message(&m.content_blocks, i, &tool_results_by_id);
            flat_calls.extend(calls.iter().cloned());

            turns.push(Turn {
                index: i,
                timestamp: m.timestamp,
                model: m.model.clone(),
                role: TurnRole::Assistant,
                usage: m.usage.clone(),
                context_window_tokens: ctx,
                tool_calls: calls,
                is_sidechain: m.is_sidechain,
            });
        }

        let primary_model = model_output
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(k, _)| k)
            .unwrap_or_else(|| "unknown".into());

        let loop_count = count_loops(&flat_calls);

        let user_prompt = users
            .iter()
            .find(|u| u.session_id == sid && u.text.is_some())
            .and_then(|u| u.text.clone());

        sessions.push(Session {
            id: sid,
            project,
            project_raw,
            start_ts,
            end_ts,
            models_used,
            primary_model,
            turns,
            token_totals: totals,
            tool_calls: flat_calls,
            estimated_cost_usd: cost,
            loop_count,
            peak_context_tokens: peak_ctx,
            has_errors,
            has_sidechain,
            user_prompt,
        });
    }
    sessions
}

use rayon::prelude::*;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

/// Read `history.jsonl` and return a map of sessionId → best user-typed prompt.
/// `display` is what the user actually typed; for slash commands with pasted
/// content we use the first pasted block's text instead.
pub fn load_history_prompts(claude_home: &Path) -> HashMap<String, String> {
    let path = claude_home.join("history.jsonl");
    let mut map: HashMap<String, String> = HashMap::new();
    let Ok(content) = std::fs::read_to_string(&path) else {
        return map;
    };
    for line in content.lines() {
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(sid) = val["sessionId"].as_str() else { continue };
        // First entry (earliest prompt) per session wins
        if map.contains_key(sid) {
            continue;
        }
        let display = val["display"].as_str().unwrap_or("").trim();
        if display.is_empty() {
            continue;
        }
        // Strip trailing "[Pasted text N +N lines]" annotation
        let clean = if let Some(idx) = display.find(" [Pasted text") {
            display[..idx].trim()
        } else {
            display
        };
        // For short slash commands, prefer the first pasted content block
        let prompt = if clean.starts_with('/') && clean.len() < 30 {
            val["pastedContents"]
                .as_object()
                .and_then(|m| m.values().next())
                .and_then(|v| v["content"].as_str())
                .map(|s| s.trim().chars().take(300).collect::<String>())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| clean.to_string())
        } else {
            clean.to_string()
        };
        map.insert(sid.to_string(), prompt);
    }
    map
}

/// Find all session JSONL files under a CLAUDE_HOME directory.
pub fn find_jsonl_files(claude_home: &Path) -> Vec<PathBuf> {
    let projects = claude_home.join("projects");
    if !projects.exists() {
        return vec![];
    }
    walkdir::WalkDir::new(projects)
        .max_depth(2) // projects/<project-key>/<session>.jsonl
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.path().extension().and_then(|x| x.to_str()) == Some("jsonl")
        })
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// Ingest a single file end-to-end: parse + group + build. Errors return empty.
pub fn ingest_file(path: &Path, pricing: &crate::pricing::Pricing) -> Vec<Session> {
    let Ok(recs) = parse_jsonl(path) else {
        return vec![];
    };
    let (a, u) = group_messages(recs);
    build_sessions(a, u, pricing)
}

/// Ingest every JSONL file under CLAUDE_HOME in parallel. Returns flat session list.
pub fn scan_claude_home(claude_home: &Path, pricing: &crate::pricing::Pricing) -> Vec<Session> {
    let files = find_jsonl_files(claude_home);
    files
        .par_iter()
        .flat_map(|p| ingest_file(p, pricing))
        .collect()
}

/// Resolve the effective CLAUDE_HOME: env var if set, else ~/.claude.
pub fn resolve_claude_home() -> PathBuf {
    if let Ok(v) = std::env::var("CLAUDE_HOME") {
        return PathBuf::from(v);
    }
    dirs::home_dir()
        .map(|h| h.join(".claude"))
        .unwrap_or_else(|| PathBuf::from(".claude"))
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ManifestEntry {
    pub mtime: i64,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Manifest {
    /// Keyed by JSONL file path (absolute)
    pub files: BTreeMap<String, ManifestEntry>,
}

pub struct Cache {
    pub root: PathBuf,
}

impl Cache {
    pub fn resolve() -> PathBuf {
        if let Some(x) = std::env::var_os("XDG_CACHE_HOME") {
            return PathBuf::from(x).join("ccdbg");
        }
        dirs::cache_dir()
            .map(|d| d.join("ccdbg"))
            .unwrap_or_else(|| PathBuf::from(".ccdbg-cache"))
    }

    pub fn new(root: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(root.join("sessions"))?;
        Ok(Self { root })
    }

    pub fn manifest_path(&self) -> PathBuf {
        self.root.join("manifest.json")
    }

    pub fn load_manifest(&self) -> Manifest {
        let p = self.manifest_path();
        if !p.exists() {
            return Manifest::default();
        }
        std::fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_manifest(&self, m: &Manifest) -> anyhow::Result<()> {
        let j = serde_json::to_string_pretty(m)?;
        std::fs::write(self.manifest_path(), j)?;
        Ok(())
    }

    pub fn session_path(&self, id: &str) -> PathBuf {
        self.root.join("sessions").join(format!("{id}.json"))
    }

    pub fn save_session(&self, s: &Session) -> anyhow::Result<()> {
        let j = serde_json::to_string(s)?;
        std::fs::write(self.session_path(&s.id), j)?;
        Ok(())
    }

    pub fn load_all_sessions(&self) -> Vec<Session> {
        let dir = self.root.join("sessions");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return vec![];
        };
        entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path().extension().and_then(|x| x.to_str()) == Some("json")
            })
            .filter_map(|e| {
                let s = std::fs::read_to_string(e.path()).ok()?;
                serde_json::from_str(&s).ok()
            })
            .collect()
    }

    pub fn invalidate(&self, session_id: &str) {
        let _ = std::fs::remove_file(self.session_path(session_id));
    }
}

/// Incremental scan: only re-ingest files whose (mtime, size) changed.
/// Reuses cached sessions for unchanged files. Returns (all_sessions, n_files_reingested).
pub fn scan_incremental(
    claude_home: &Path,
    cache: &Cache,
    pricing: &crate::pricing::Pricing,
    force: bool,
) -> anyhow::Result<(Vec<Session>, usize)> {
    let files = find_jsonl_files(claude_home);
    let mut manifest = if force {
        Manifest::default()
    } else {
        cache.load_manifest()
    };

    let mut to_reingest: Vec<PathBuf> = Vec::new();
    for f in &files {
        let key = f.to_string_lossy().into_owned();
        let meta = std::fs::metadata(f)?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let size = meta.len();
        let old = manifest.files.get(&key);
        let changed = match old {
            Some(e) => e.mtime != mtime || e.size != size,
            None => true,
        };
        if changed {
            to_reingest.push(f.clone());
            manifest.files.insert(key, ManifestEntry { mtime, size });
        }
    }

    // Re-ingest changed files in parallel; save each session as JSON.
    let reingested: Vec<Vec<Session>> = to_reingest
        .par_iter()
        .map(|p| ingest_file(p, pricing))
        .collect();

    for bucket in &reingested {
        for s in bucket {
            cache.save_session(s)?;
        }
    }

    cache.save_manifest(&manifest)?;

    // Gather final session list: everything on disk.
    let mut all = cache.load_all_sessions();

    // Overlay user prompts from history.jsonl — these are the actual commands
    // the user typed, which are more useful than whatever ends up in the JSONL.
    let history = load_history_prompts(claude_home);
    for s in &mut all {
        if let Some(prompt) = history.get(&s.id) {
            s.user_prompt = Some(prompt.clone());
        }
    }

    Ok((all, to_reingest.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    #[test]
    fn parses_minimal_session_file() {
        let recs = parse_jsonl(&fixture("minimal_session.jsonl")).unwrap();
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].rtype.as_deref(), Some("user"));
        assert_eq!(recs[1].rtype.as_deref(), Some("assistant"));
        assert_eq!(recs[1].session_id.as_deref(), Some("sess-minimal"));
    }

    #[test]
    fn raw_usage_prefers_subfields_over_flat_cache_creation() {
        let u: RawUsage = serde_json::from_str(
            r#"{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,
                "cache_creation_input_tokens":99,
                "cache_creation":{"ephemeral_5m_input_tokens":7,"ephemeral_1h_input_tokens":8}}"#,
        )
        .unwrap();
        let t = u.to_token_totals();
        assert_eq!(t.cache_creation_5m, 7);
        assert_eq!(t.cache_creation_1h, 8);
    }

    #[test]
    fn raw_usage_falls_back_to_flat_cache_creation_when_subfields_missing() {
        let u: RawUsage = serde_json::from_str(
            r#"{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,
                "cache_creation_input_tokens":42}"#,
        )
        .unwrap();
        let t = u.to_token_totals();
        assert_eq!(t.cache_creation_5m, 42);
        assert_eq!(t.cache_creation_1h, 0);
    }

    #[test]
    fn duplicate_message_ids_are_merged_into_one_assistant_message() {
        let recs = parse_jsonl(&fixture("dup_message.jsonl")).unwrap();
        let (assist, users) = group_messages(recs);
        assert_eq!(assist.len(), 1, "two records with same msg_id should merge");
        assert_eq!(assist[0].message_id, "msg_dup");
        assert_eq!(assist[0].usage.input, 10);
        // both content blocks collected
        assert_eq!(assist[0].content_blocks.len(), 2);
        // the tool_result user message was captured
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].tool_results.len(), 1);
        assert_eq!(users[0].tool_results[0].tool_use_id, "tu_1");
        assert!(!users[0].tool_results[0].is_error);
    }

    #[test]
    fn normalize_strips_in_project_worktree_suffix() {
        assert_eq!(
            normalize_project("/Users/dev/repo/.claude/worktrees/feature-x"),
            "/Users/dev/repo"
        );
    }

    #[test]
    fn normalize_buckets_claude_squad_worktrees_to_home_directory() {
        assert_eq!(
            normalize_project("/Users/dev/.claude-squad/worktrees/run-42/proj"),
            "home-directory"
        );
        assert_eq!(
            normalize_project("/Users/dev/.claude-squad/worktrees/run-42"),
            "home-directory"
        );
    }

    #[test]
    fn normalize_passes_through_plain_paths_unchanged() {
        assert_eq!(
            normalize_project("/Users/dev/projects/demo"),
            "/Users/dev/projects/demo"
        );
    }

    #[test]
    fn build_sessions_produces_one_session_from_minimal_fixture() {
        let recs = parse_jsonl(&fixture("minimal_session.jsonl")).unwrap();
        let (a, u) = group_messages(recs);
        let pricing = crate::pricing::Pricing::load().unwrap();
        let sessions = build_sessions(a, u, &pricing);
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];
        assert_eq!(s.id, "sess-minimal");
        assert_eq!(s.project_raw, "/Users/dev/demo");
        assert_eq!(s.primary_model, "claude-sonnet-4-6");
        assert_eq!(s.turns.len(), 1);
        assert_eq!(s.token_totals.input, 10);
        assert_eq!(s.token_totals.output, 5);
        assert!(s.estimated_cost_usd > 0.0);
    }

    #[test]
    fn build_sessions_detects_a_loop_of_three_reads() {
        let recs = parse_jsonl(&fixture("loop_session.jsonl")).unwrap();
        let (a, u) = group_messages(recs);
        let pricing = crate::pricing::Pricing::load().unwrap();
        let sessions = build_sessions(a, u, &pricing);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].loop_count, 1, "three Reads = one loop");
    }

    #[test]
    fn count_loops_returns_zero_for_no_repeats() {
        let calls = vec![
            ToolCall { tool: "A".into(), input_summary: "x".into(), success: true, turn_index: 0 },
            ToolCall { tool: "B".into(), input_summary: "y".into(), success: true, turn_index: 1 },
        ];
        assert_eq!(count_loops(&calls), 0);
    }

    #[test]
    fn find_jsonl_discovers_files_under_projects_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("projects").join("-Users-dev-demo");
        std::fs::create_dir_all(&proj).unwrap();
        let f = proj.join("sess.jsonl");
        std::fs::write(&f, "{}\n").unwrap();
        let files = find_jsonl_files(tmp.path());
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("sess.jsonl"));
    }

    #[test]
    fn second_incremental_scan_reingests_zero_files_when_nothing_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let ch = tmp.path().join("claude");
        let proj = ch.join("projects").join("-Users-dev-demo");
        std::fs::create_dir_all(&proj).unwrap();
        let fixture_bytes =
            std::fs::read(&fixture("minimal_session.jsonl")).unwrap();
        std::fs::write(proj.join("sess.jsonl"), &fixture_bytes).unwrap();

        let cache_root = tmp.path().join("cache");
        let cache = Cache::new(cache_root).unwrap();
        let pricing = crate::pricing::Pricing::load().unwrap();

        let (first, n1) = scan_incremental(&ch, &cache, &pricing, false).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(n1, 1);

        let (_second, n2) = scan_incremental(&ch, &cache, &pricing, false).unwrap();
        assert_eq!(n2, 0, "unchanged files should not be reingested");
    }

    #[test]
    fn summarize_tool_input_does_not_panic_on_multibyte_utf8() {
        // A string where byte index 120 falls inside a multi-byte character.
        // Emoji characters are 4 bytes each.
        let mut long = String::new();
        for _ in 0..40 {
            long.push_str("abc🦀"); // "abc" + 4-byte emoji = 7 bytes per iter
        }
        // long is 280 bytes total, byte 120 is inside an emoji
        let input = serde_json::json!({ "file_path": long });
        let summary = summarize_tool_input(Some(&input));
        // Must not panic and must be valid UTF-8 (automatic for String)
        // The summary truncates to 120 characters, which may be more than 120 bytes
        // due to multi-byte UTF-8 characters.
        assert!(summary.chars().count() <= 120);
        assert!(!summary.is_empty());
    }
}
