//! Insight computations. Each pub fn takes &[Session] + &Pricing and returns
//! one or more Insight records with concrete mitigations.

use crate::model::*;
use crate::pricing::Pricing;

/// Model What-If: replay every session's tokens at every other model's prices,
/// find the largest fleet-wide potential savings.
pub fn model_what_if(sessions: &[Session], pricing: &Pricing) -> Vec<Insight> {
    if sessions.is_empty() {
        return vec![];
    }
    let actual_total: f64 = sessions.iter().map(|s| s.estimated_cost_usd).sum();

    // For each candidate target model, compute what the total would have been.
    let mut best: Option<(String, f64, Vec<String>)> = None;
    for candidate in pricing.models.keys() {
        let mut alt_total = 0.0;
        let mut wins: Vec<(String, f64)> = Vec::new(); // per-session savings
        for s in sessions {
            // Sum per-turn cost at the candidate rate.
            let mut c = 0.0;
            for t in &s.turns {
                c += pricing.cost(candidate, &t.usage);
            }
            alt_total += c;
            let savings = s.estimated_cost_usd - c;
            if savings > 0.0 {
                wins.push((s.id.clone(), savings));
            }
        }
        if alt_total < actual_total {
            let savings = actual_total - alt_total;
            match &best {
                Some((_, s, _)) if *s >= savings => {}
                _ => {
                    wins.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
                    let top_ids = wins.into_iter().take(3).map(|(i, _)| i).collect();
                    best = Some((candidate.clone(), savings, top_ids));
                }
            }
        }
    }

    let Some((cheap_model, savings, evidence)) = best else {
        return vec![Insight {
            kind: InsightKind::ModelWhatIf,
            severity: Severity::Info,
            headline: "You're already on the cheapest available model.".into(),
            metric_value: 0.0,
            metric_unit: "USD".into(),
            mitigation: None,
            evidence_session_ids: vec![],
        }];
    };

    let pct = if actual_total > 0.0 {
        savings / actual_total * 100.0
    } else {
        0.0
    };
    let severity = if pct >= 30.0 {
        Severity::Warn
    } else {
        Severity::Info
    };
    let mitigation = if pct >= 30.0 {
        Some(Mitigation {
            advice: format!(
                "Try `/model {}` for sessions like these. Your token mix would have cost {:.0}% less on that model.",
                strip_claude_prefix(&cheap_model),
                pct
            ),
            example_from_your_data: evidence.first().cloned(),
        })
    } else {
        None
    };

    vec![Insight {
        kind: InsightKind::ModelWhatIf,
        severity,
        headline: format!(
            "Running on {} would have saved ~${:.2} ({:.0}%)",
            strip_claude_prefix(&cheap_model),
            savings,
            pct
        ),
        metric_value: savings,
        metric_unit: "USD".into(),
        mitigation,
        evidence_session_ids: evidence,
    }]
}

fn strip_claude_prefix(model: &str) -> String {
    model.strip_prefix("claude-").unwrap_or(model).to_string()
}

/// Cache Waste: flag sessions where large cache_creation turns are followed
/// within the TTL window by insufficient cache_read. Waste $ = cost of the
/// wasted cache_creation tokens.
pub fn cache_waste(sessions: &[Session], pricing: &Pricing) -> Vec<Insight> {
    const CREATION_THRESHOLD: u64 = 50_000;

    let mut total_waste_usd = 0.0;
    let mut wasted_session_ids: Vec<(String, f64)> = Vec::new();

    for s in sessions {
        let mut session_waste = 0.0;
        for (i, t) in s.turns.iter().enumerate() {
            let c5 = t.usage.cache_creation_5m;
            let c1 = t.usage.cache_creation_1h;
            if c5 + c1 < CREATION_THRESHOLD {
                continue;
            }
            let ttl_5m = chrono::Duration::minutes(5);
            let ttl_1h = chrono::Duration::minutes(60);

            let mut read_5m: u64 = 0;
            let mut read_1h: u64 = 0;
            for f in s.turns.iter().skip(i + 1) {
                let dt = f.timestamp - t.timestamp;
                if dt <= ttl_5m {
                    read_5m += f.usage.cache_read;
                }
                if dt <= ttl_1h {
                    read_1h += f.usage.cache_read;
                }
            }

            // Criterion: reads < 20% of creation size → flag as waste.
            let wasted_5m = if c5 > 0 && (read_5m as f64) < (c5 as f64) * 0.2 {
                c5 - (read_5m.min(c5))
            } else {
                0
            };
            let wasted_1h = if c1 > 0 && (read_1h as f64) < (c1 as f64) * 0.2 {
                c1 - (read_1h.min(c1))
            } else {
                0
            };
            if wasted_5m + wasted_1h == 0 {
                continue;
            }
            let waste_tokens = TokenTotals {
                cache_creation_5m: wasted_5m,
                cache_creation_1h: wasted_1h,
                ..Default::default()
            };
            session_waste += pricing.cost(&t.model, &waste_tokens);
        }
        if session_waste > 0.0 {
            total_waste_usd += session_waste;
            wasted_session_ids.push((s.id.clone(), session_waste));
        }
    }

    if total_waste_usd == 0.0 {
        return vec![Insight {
            kind: InsightKind::CacheWaste,
            severity: Severity::Info,
            headline: "No significant cache waste detected.".into(),
            metric_value: 0.0,
            metric_unit: "USD".into(),
            mitigation: None,
            evidence_session_ids: vec![],
        }];
    }

    wasted_session_ids.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let evidence = wasted_session_ids
        .iter()
        .take(5)
        .map(|(i, _)| i.clone())
        .collect();

    let severity = if total_waste_usd >= 10.0 {
        Severity::High
    } else if total_waste_usd >= 3.0 {
        Severity::Warn
    } else {
        Severity::Info
    };

    vec![Insight {
        kind: InsightKind::CacheWaste,
        severity,
        headline: format!("~${:.2} spent on cache you didn't reuse", total_waste_usd),
        metric_value: total_waste_usd,
        metric_unit: "USD".into(),
        mitigation: Some(Mitigation {
            advice:
                "Avoid >5-minute breaks mid-session. `/clear` before stepping away — holding context you won't reuse costs cache rebuild."
                    .into(),
            example_from_your_data: wasted_session_ids
                .first()
                .map(|(id, w)| format!("session {} lost ~${:.2}", id, w)),
        }),
        evidence_session_ids: evidence,
    }]
}

/// Tool-Error Recovery Cost: for each failed tool_use, attribute the cost of
/// the following assistant turn as "recovery cost". Aggregate by tool name.
pub fn tool_error_cost(sessions: &[Session], pricing: &Pricing) -> Vec<Insight> {
    use std::collections::HashMap;

    // tool → (recovery_cost_usd, failure_count)
    let mut agg: HashMap<String, (f64, u64)> = HashMap::new();

    for s in sessions {
        // Walk turns; when a turn's tool_calls contains a failure, the NEXT
        // turn's cost is recovery cost for that tool.
        for i in 0..s.turns.len() {
            let fails: Vec<&str> = s.turns[i]
                .tool_calls
                .iter()
                .filter(|tc| !tc.success)
                .map(|tc| tc.tool.as_str())
                .collect();
            if fails.is_empty() {
                continue;
            }
            let next_cost = s
                .turns
                .get(i + 1)
                .map(|n| pricing.cost(&n.model, &n.usage))
                .unwrap_or(0.0);
            // Split recovery cost evenly across failed tools in the turn.
            let share = next_cost / (fails.len() as f64);
            for tool in fails {
                let e = agg.entry(tool.to_string()).or_insert((0.0, 0));
                e.0 += share;
                e.1 += 1;
            }
        }
    }

    if agg.is_empty() {
        return vec![Insight {
            kind: InsightKind::ToolErrorCost,
            severity: Severity::Info,
            headline: "No significant tool-error recovery cost detected.".into(),
            metric_value: 0.0,
            metric_unit: "USD".into(),
            mitigation: None,
            evidence_session_ids: vec![],
        }];
    }

    let total: f64 = agg.values().map(|(c, _)| c).sum();
    let mut ranked: Vec<(String, f64, u64)> =
        agg.into_iter().map(|(k, (c, n))| (k, c, n)).collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let top = &ranked[0];

    let severity = if total >= 5.0 {
        Severity::High
    } else if total >= 1.0 {
        Severity::Warn
    } else {
        Severity::Info
    };

    vec![Insight {
        kind: InsightKind::ToolErrorCost,
        severity,
        headline: format!(
            "~${:.2} spent recovering from tool errors ({} is costliest)",
            total, top.0
        ),
        metric_value: total,
        metric_unit: "USD".into(),
        mitigation: Some(Mitigation {
            advice: advice_for_tool(&top.0),
            example_from_your_data: Some(format!(
                "{} errored {} times, ~${:.2} in recovery",
                top.0, top.2, top.1
            )),
        }),
        evidence_session_ids: vec![],
    }]
}

fn advice_for_tool(tool: &str) -> String {
    match tool {
        "Edit" => "Use `Read` first before `Edit` — most Edit failures are stale or whitespace-mismatched `old_string`s.".into(),
        "Write" => "Read before Write — `Write` fails on existing files without a prior `Read`.".into(),
        "Bash" => "Prefer `Grep`/`Glob` over shell `grep`/`find` — more reliable across .gitignore and shells.".into(),
        "NotebookEdit" => "Read the notebook first to confirm cell IDs before editing.".into(),
        _ => format!(
            "Inspect the first argument to `{}` in the failing calls — most failures are in the input.",
            tool
        ),
    }
}

/// Subagent Overhead: compare per-turn cost of sidechain-heavy vs main-only
/// sessions. Flag if subagent-heavy sessions cost more per turn without fewer turns.
pub fn subagent_overhead(sessions: &[Session], _pricing: &Pricing) -> Vec<Insight> {
    if sessions.is_empty() {
        return vec![];
    }
    let mut heavy: Vec<&Session> = Vec::new();
    let mut main_only: Vec<&Session> = Vec::new();
    for s in sessions {
        if s.turns.is_empty() {
            continue;
        }
        let sc = s.turns.iter().filter(|t| t.is_sidechain).count();
        let share = sc as f64 / s.turns.len() as f64;
        if share > 0.5 {
            heavy.push(s);
        } else if share == 0.0 {
            main_only.push(s);
        }
    }
    if heavy.is_empty() || main_only.is_empty() {
        return vec![Insight {
            kind: InsightKind::SubagentOverhead,
            severity: Severity::Info,
            headline: format!(
                "Not enough data: {} subagent-heavy sessions, {} main-only",
                heavy.len(),
                main_only.len()
            ),
            metric_value: 0.0,
            metric_unit: "ratio".into(),
            mitigation: None,
            evidence_session_ids: vec![],
        }];
    }
    fn mean(xs: impl Iterator<Item = f64>) -> f64 {
        let v: Vec<f64> = xs.collect();
        if v.is_empty() {
            0.0
        } else {
            v.iter().sum::<f64>() / v.len() as f64
        }
    }
    let cost_per_turn = |s: &&Session| s.estimated_cost_usd / s.turns.len() as f64;
    let heavy_cpt = mean(heavy.iter().map(cost_per_turn));
    let main_cpt = mean(main_only.iter().map(cost_per_turn));
    let heavy_turns = mean(heavy.iter().map(|s| s.turns.len() as f64));
    let main_turns = mean(main_only.iter().map(|s| s.turns.len() as f64));

    let ratio = if main_cpt > 0.0 {
        heavy_cpt / main_cpt
    } else {
        1.0
    };

    let flag = ratio > 1.3 && heavy_turns >= main_turns;
    let severity = if flag { Severity::Warn } else { Severity::Info };
    let mitigation = if flag {
        Some(Mitigation {
            advice: "Consider inline exploration for simple tasks; reserve subagents for genuinely parallel work.".into(),
            example_from_your_data: heavy.first().map(|s| s.id.clone()),
        })
    } else {
        None
    };

    vec![Insight {
        kind: InsightKind::SubagentOverhead,
        severity,
        headline: format!(
            "Subagent-heavy sessions cost {:.1}× per turn ({} vs {} turns avg)",
            ratio, heavy_turns as i64, main_turns as i64
        ),
        metric_value: ratio,
        metric_unit: "ratio".into(),
        mitigation,
        evidence_session_ids: heavy.iter().take(3).map(|s| s.id.clone()).collect(),
    }]
}

/// Context-Decay: bucket tool-call success rate by context window size.
/// Inflection point = first bucket where success drops >15pts from previous.
pub fn context_decay(sessions: &[Session], _pricing: &Pricing) -> Vec<Insight> {
    const BUCKETS: &[(u64, u64, &str)] = &[
        (0, 50_000, "0-50K"),
        (50_000, 100_000, "50-100K"),
        (100_000, 150_000, "100-150K"),
        (150_000, 200_000, "150-200K"),
        (200_000, u64::MAX, "200K+"),
    ];
    let mut totals = [0u64; 5];
    let mut failures = [0u64; 5];

    for s in sessions {
        for t in &s.turns {
            let ctx = t.context_window_tokens;
            let bi = BUCKETS
                .iter()
                .position(|(lo, hi, _)| ctx >= *lo && ctx < *hi);
            let Some(bi) = bi else { continue };
            for tc in &t.tool_calls {
                totals[bi] += 1;
                if !tc.success {
                    failures[bi] += 1;
                }
            }
        }
    }

    let mut rates = [0.0_f64; 5];
    for i in 0..5 {
        if totals[i] > 0 {
            rates[i] = 1.0 - (failures[i] as f64 / totals[i] as f64);
        }
    }

    // Find inflection: first bucket where rate drops >15pts from the max-so-far.
    let mut inflection: Option<usize> = None;
    let mut max_rate_so_far: f64 = 0.0;
    for i in 0..5 {
        if totals[i] == 0 {
            continue;
        }
        if i == 0 {
            max_rate_so_far = rates[i];
            continue;
        }
        if max_rate_so_far - rates[i] > 0.15 {
            inflection = Some(i);
            break;
        }
        if rates[i] > max_rate_so_far {
            max_rate_so_far = rates[i];
        }
    }

    let (severity, headline, mitigation) = match inflection {
        Some(i) => {
            let before_rate = max_rate_so_far;
            let after_rate = rates[i];
            let bucket = BUCKETS[i].2;
            (
                Severity::Warn,
                format!(
                    "Tool success drops from {:.0}% to {:.0}% past {}",
                    before_rate * 100.0,
                    after_rate * 100.0,
                    bucket
                ),
                Some(Mitigation {
                    advice: format!(
                        "`/clear` before entering the {} zone if the thread is exploratory — tool reliability drops after this point.",
                        bucket
                    ),
                    example_from_your_data: None,
                }),
            )
        }
        None => (
            Severity::Info,
            "No meaningful context-size degradation detected.".into(),
            None,
        ),
    };

    vec![Insight {
        kind: InsightKind::ContextDecay,
        severity,
        headline,
        metric_value: inflection.map(|i| rates[i] * 100.0).unwrap_or(100.0),
        metric_unit: "percent".into(),
        mitigation,
        evidence_session_ids: vec![],
    }]
}

/// Idle-Gap Cost: find turns with >5min gap since prior turn, sum the
/// cache_creation cost of the resume turn.
pub fn idle_gap_cost(sessions: &[Session], pricing: &Pricing) -> Vec<Insight> {
    let threshold = chrono::Duration::minutes(5);
    let mut total = 0.0;
    let mut per_session: Vec<(String, f64)> = Vec::new();

    for s in sessions {
        let mut session_total = 0.0;
        for w in s.turns.windows(2) {
            let (prev, cur) = (&w[0], &w[1]);
            if cur.timestamp - prev.timestamp <= threshold {
                continue;
            }
            let creation_only = TokenTotals {
                cache_creation_5m: cur.usage.cache_creation_5m,
                cache_creation_1h: cur.usage.cache_creation_1h,
                ..Default::default()
            };
            session_total += pricing.cost(&cur.model, &creation_only);
        }
        if session_total > 0.0 {
            total += session_total;
            per_session.push((s.id.clone(), session_total));
        }
    }

    if total == 0.0 {
        return vec![Insight {
            kind: InsightKind::IdleGapCost,
            severity: Severity::Info,
            headline: "No significant idle-gap rebuild cost.".into(),
            metric_value: 0.0,
            metric_unit: "USD".into(),
            mitigation: None,
            evidence_session_ids: vec![],
        }];
    }

    per_session.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let severity = if total >= 5.0 {
        Severity::Warn
    } else {
        Severity::Info
    };
    vec![Insight {
        kind: InsightKind::IdleGapCost,
        severity,
        headline: format!("~${:.2} spent rebuilding cache after idle gaps", total),
        metric_value: total,
        metric_unit: "USD".into(),
        mitigation: Some(Mitigation {
            advice: "`/clear` before lunch or long breaks, or start a new session when resuming."
                .into(),
            example_from_your_data: per_session
                .first()
                .map(|(id, v)| format!("{}: ${:.2}", id, v)),
        }),
        evidence_session_ids: per_session.into_iter().take(3).map(|(id, _)| id).collect(),
    }]
}

/// Model Drift: count sessions where `model` changes between consecutive
/// assistant turns. Diagnostic-only — no mitigation.
pub fn model_drift(sessions: &[Session], _pricing: &Pricing) -> Vec<Insight> {
    let mut drifted: Vec<String> = Vec::new();
    for s in sessions {
        let mut last: Option<&str> = None;
        let mut drift_in_session = false;
        for t in &s.turns {
            if t.role != TurnRole::Assistant {
                continue;
            }
            if let Some(prev) = last {
                if prev != t.model {
                    drift_in_session = true;
                    break;
                }
            }
            last = Some(&t.model);
        }
        if drift_in_session {
            drifted.push(s.id.clone());
        }
    }

    if drifted.is_empty() {
        return vec![Insight {
            kind: InsightKind::ModelDrift,
            severity: Severity::Info,
            headline: "No mid-session model changes detected.".into(),
            metric_value: 0.0,
            metric_unit: "sessions".into(),
            mitigation: None,
            evidence_session_ids: vec![],
        }];
    }

    vec![Insight {
        kind: InsightKind::ModelDrift,
        severity: Severity::Info,
        headline: format!("{} sessions switched model mid-session", drifted.len()),
        metric_value: drifted.len() as f64,
        metric_unit: "sessions".into(),
        mitigation: None, // diagnostic-only
        evidence_session_ids: drifted.into_iter().take(5).collect(),
    }]
}

/// Run every analysis and concatenate the resulting insights.
pub fn run_all(sessions: &[Session], pricing: &Pricing) -> Vec<Insight> {
    let mut out = Vec::new();
    out.extend(model_what_if(sessions, pricing));
    out.extend(cache_waste(sessions, pricing));
    out.extend(tool_error_cost(sessions, pricing));
    out.extend(subagent_overhead(sessions, pricing));
    out.extend(context_decay(sessions, pricing));
    out.extend(idle_gap_cost(sessions, pricing));
    out.extend(model_drift(sessions, pricing));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    pub(super) fn mk_session(id: &str, model: &str, input: u64, output: u64) -> Session {
        let t = Turn {
            index: 0,
            timestamp: Utc::now(),
            model: model.into(),
            role: TurnRole::Assistant,
            usage: TokenTotals {
                input,
                output,
                ..Default::default()
            },
            context_window_tokens: input,
            tool_calls: vec![],
            is_sidechain: false,
        };
        let p = Pricing::load().unwrap();
        let cost = p.cost(model, &t.usage);
        Session {
            id: id.into(),
            project: "p".into(),
            project_raw: "p".into(),
            start_ts: t.timestamp,
            end_ts: t.timestamp,
            models_used: vec![model.into()],
            primary_model: model.into(),
            turns: vec![t.clone()],
            token_totals: t.usage.clone(),
            tool_calls: vec![],
            estimated_cost_usd: cost,
            loop_count: 0,
            peak_context_tokens: 0,
            has_errors: false,
            has_sidechain: false,
            user_prompt: None,
        }
    }

    #[test]
    fn opus_session_flagged_would_save_on_sonnet() {
        let p = Pricing::load().unwrap();
        let s = mk_session("s1", "claude-opus-4-7", 1_000_000, 1_000_000);
        let out = model_what_if(&[s], &p);
        assert_eq!(out.len(), 1);
        assert!(out[0].metric_value > 0.0, "should find savings");
        // Could be sonnet or haiku — both cheaper than opus
        assert!(
            out[0].headline.contains("sonnet") || out[0].headline.contains("haiku"),
            "got: {}",
            out[0].headline
        );
    }

    #[test]
    fn cache_waste_flags_created_cache_unused_inside_ttl() {
        use std::path::PathBuf;
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/cache_waste_session.jsonl");
        let recs = crate::ingest::parse_jsonl(&fixture).unwrap();
        let (a, u) = crate::ingest::group_messages(recs);
        let p = Pricing::load().unwrap();
        let sessions = crate::ingest::build_sessions(a, u, &p);
        let out = cache_waste(&sessions, &p);
        assert_eq!(out.len(), 1);
        assert!(
            out[0].metric_value > 0.0,
            "cache_waste should detect unused creation"
        );
    }

    #[test]
    fn tool_error_cost_attributes_next_turn_to_failed_tool() {
        use std::path::PathBuf;
        let fx = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/tool_error_session.jsonl");
        let recs = crate::ingest::parse_jsonl(&fx).unwrap();
        let (a, u) = crate::ingest::group_messages(recs);
        let p = Pricing::load().unwrap();
        let sessions = crate::ingest::build_sessions(a, u, &p);
        let out = tool_error_cost(&sessions, &p);
        assert_eq!(out.len(), 1);
        assert!(out[0].metric_value > 0.0);
        assert!(out[0].headline.contains("Edit"));
    }

    #[test]
    fn subagent_overhead_flags_heavy_sessions_with_higher_cost_per_turn() {
        // 2 main-only sessions with low cost; 1 heavy session with high cost.
        let p = Pricing::load().unwrap();
        let a = mk_session("main1", "claude-sonnet-4-6", 100, 100);
        let b = mk_session("main2", "claude-sonnet-4-6", 100, 100);
        let mut c = mk_session("heavy", "claude-opus-4-7", 1_000_000, 1_000_000);
        c.turns[0].is_sidechain = true;
        // Add another sidechain turn so share > 0.5
        let mut extra = c.turns[0].clone();
        extra.index = 1;
        extra.is_sidechain = true;
        c.turns.push(extra);

        let out = subagent_overhead(&[a, b, c], &p);
        assert_eq!(out.len(), 1);
        assert!(out[0].metric_value > 1.0);
    }

    #[test]
    fn context_decay_detects_success_drop_between_buckets() {
        let p = Pricing::load().unwrap();
        let mut s = mk_session("s1", "claude-sonnet-4-6", 10, 10);
        s.turns.clear();
        // bucket 0-50K: 10 successful calls
        for i in 0..10 {
            s.turns.push(Turn {
                index: i,
                timestamp: chrono::Utc::now(),
                model: "claude-sonnet-4-6".into(),
                role: TurnRole::Assistant,
                usage: TokenTotals::default(),
                context_window_tokens: 10_000,
                tool_calls: vec![ToolCall {
                    tool: "Read".into(),
                    input_summary: "/a".into(),
                    success: true,
                    turn_index: i,
                }],
                is_sidechain: false,
            });
        }
        // bucket 150-200K: 10 calls, 8 failed
        for i in 10..20 {
            s.turns.push(Turn {
                index: i,
                timestamp: chrono::Utc::now(),
                model: "claude-sonnet-4-6".into(),
                role: TurnRole::Assistant,
                usage: TokenTotals::default(),
                context_window_tokens: 180_000,
                tool_calls: vec![ToolCall {
                    tool: "Read".into(),
                    input_summary: "/a".into(),
                    success: i >= 18,
                    turn_index: i,
                }],
                is_sidechain: false,
            });
        }
        let out = context_decay(&[s], &p);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, Severity::Warn);
        assert!(out[0].mitigation.is_some());
    }

    #[test]
    fn idle_gap_cost_accumulates_creation_on_post_gap_turn() {
        let p = Pricing::load().unwrap();
        let mut s = mk_session("s1", "claude-sonnet-4-6", 10, 10);
        s.turns.clear();
        let t0 = chrono::Utc::now();
        s.turns.push(Turn {
            index: 0,
            timestamp: t0,
            model: "claude-sonnet-4-6".into(),
            role: TurnRole::Assistant,
            usage: TokenTotals::default(),
            context_window_tokens: 0,
            tool_calls: vec![],
            is_sidechain: false,
        });
        s.turns.push(Turn {
            index: 1,
            timestamp: t0 + chrono::Duration::minutes(15),
            model: "claude-sonnet-4-6".into(),
            role: TurnRole::Assistant,
            usage: TokenTotals {
                cache_creation_5m: 200_000,
                ..Default::default()
            },
            context_window_tokens: 200_000,
            tool_calls: vec![],
            is_sidechain: false,
        });
        let out = idle_gap_cost(&[s], &p);
        assert_eq!(out.len(), 1);
        assert!(out[0].metric_value > 0.0);
    }

    #[test]
    fn model_drift_flags_session_with_model_change_between_turns() {
        let p = Pricing::load().unwrap();
        let mut s = mk_session("s1", "claude-opus-4-7", 10, 10);
        s.turns.push(Turn {
            index: 1,
            timestamp: chrono::Utc::now(),
            model: "claude-sonnet-4-6".into(),
            role: TurnRole::Assistant,
            usage: TokenTotals::default(),
            context_window_tokens: 0,
            tool_calls: vec![],
            is_sidechain: false,
        });
        let out = model_drift(&[s], &p);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].metric_value, 1.0);
    }
}
