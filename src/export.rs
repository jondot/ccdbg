//! JSON bundle producer — consumed by both TUI (loads into memory on
//! startup) and web frontend (served via /api routes).

use crate::model::*;
use crate::pricing::Pricing;
use serde::Serialize;
use std::collections::HashMap;

/// Simplified per-model rates included in the bundle so the frontend can
/// compute cost alternatives without a separate API call.
#[derive(Debug, Serialize)]
pub struct ModelRates {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

#[derive(Debug, Serialize)]
pub struct Bundle<'a> {
    pub generated_at: chrono::DateTime<chrono::Utc>,
    pub schema_version: u32,
    pub sessions: &'a [Session],
    pub insights: &'a [Insight],
    pub model_rates: HashMap<String, ModelRates>,
}

pub fn build<'a>(sessions: &'a [Session], insights: &'a [Insight], pricing: &Pricing) -> Bundle<'a> {
    let model_rates = pricing
        .models
        .iter()
        .map(|(name, p)| {
            (
                name.clone(),
                ModelRates {
                    input: p.input,
                    output: p.output,
                    cache_read: p.cache_read,
                },
            )
        })
        .collect();

    Bundle {
        generated_at: chrono::Utc::now(),
        schema_version: 1,
        sessions,
        insights,
        model_rates,
    }
}

pub fn write_json<P: AsRef<std::path::Path>>(
    path: P,
    sessions: &[Session],
    insights: &[Insight],
    pricing: &Pricing,
) -> anyhow::Result<()> {
    let bundle = build(sessions, insights, pricing);
    let j = serde_json::to_vec_pretty(&bundle)?;
    std::fs::write(path, j)?;
    Ok(())
}
