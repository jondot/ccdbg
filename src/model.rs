//! Core data structures for ingested sessions and generated insights.
//!
//! All types derive serde for JSON caching and for the export bundle.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation_5m: u64,
    pub cache_creation_1h: u64,
}

impl TokenTotals {
    pub fn total_cache_creation(&self) -> u64 {
        self.cache_creation_5m + self.cache_creation_1h
    }

    pub fn context_window(&self) -> u64 {
        self.input + self.cache_read + self.total_cache_creation()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TurnRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool: String,
    pub input_summary: String,
    pub success: bool,
    pub turn_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub index: usize,
    pub timestamp: DateTime<Utc>,
    pub model: String,
    pub role: TurnRole,
    pub usage: TokenTotals,
    pub context_window_tokens: u64,
    pub tool_calls: Vec<ToolCall>,
    pub is_sidechain: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub project: String,
    pub project_raw: String,
    pub start_ts: DateTime<Utc>,
    pub end_ts: DateTime<Utc>,
    pub models_used: Vec<String>,
    pub primary_model: String,
    pub turns: Vec<Turn>,
    pub token_totals: TokenTotals,
    pub tool_calls: Vec<ToolCall>,
    pub estimated_cost_usd: f64,
    pub loop_count: usize,
    pub peak_context_tokens: u64,
    pub has_errors: bool,
    pub has_sidechain: bool,
    pub user_prompt: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warn,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mitigation {
    pub advice: String,
    pub example_from_your_data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsightKind {
    ModelWhatIf,
    CacheWaste,
    ToolErrorCost,
    SubagentOverhead,
    ContextDecay,
    IdleGapCost,
    ModelDrift,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Insight {
    pub kind: InsightKind,
    pub severity: Severity,
    pub headline: String,
    pub metric_value: f64,
    pub metric_unit: String,
    pub mitigation: Option<Mitigation>,
    pub evidence_session_ids: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_totals_context_window_sums_all_input_categories() {
        let t = TokenTotals {
            input: 100,
            output: 50,
            cache_read: 200,
            cache_creation_5m: 300,
            cache_creation_1h: 400,
        };
        assert_eq!(t.context_window(), 100 + 200 + 300 + 400);
        assert_eq!(t.total_cache_creation(), 700);
    }

    #[test]
    fn session_round_trips_through_serde_json() {
        let s = Session {
            id: "abc".into(),
            project: "proj".into(),
            project_raw: "/path/to/proj".into(),
            start_ts: Utc::now(),
            end_ts: Utc::now(),
            models_used: vec!["claude-sonnet-4-6".into()],
            primary_model: "claude-sonnet-4-6".into(),
            turns: vec![],
            token_totals: TokenTotals::default(),
            tool_calls: vec![],
            estimated_cost_usd: 0.0,
            loop_count: 0,
            peak_context_tokens: 0,
            has_errors: false,
            has_sidechain: false,
            user_prompt: None,
        };
        let j = serde_json::to_string(&s).unwrap();
        let back: Session = serde_json::from_str(&j).unwrap();
        assert_eq!(back.id, "abc");
    }
}
