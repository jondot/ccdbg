//! Pricing table loader + cost calculation.
//!
//! Default table is baked into the binary via `include_str!`. User can
//! override by creating `~/.config/ccdbg/pricing.toml`.

use crate::model::TokenTotals;
use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

const DEFAULT_PRICING: &str = include_str!("../pricing.toml");

#[derive(Debug, Clone, Deserialize)]
pub struct ModelPricing {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_creation_5m: f64,
    pub cache_creation_1h: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Pricing {
    pub models: HashMap<String, ModelPricing>,
}

impl Pricing {
    /// Load default pricing, overlaying a user config file if present.
    pub fn load() -> Result<Self> {
        let mut pricing = Self::parse(DEFAULT_PRICING).context("parsing built-in pricing")?;
        if let Some(user_path) = Self::user_config_path() {
            if user_path.exists() {
                let user_toml =
                    std::fs::read_to_string(&user_path).context("reading user pricing.toml")?;
                let user_pricing = Self::parse(&user_toml).context("parsing user pricing.toml")?;
                pricing.models.extend(user_pricing.models);
            }
        }
        Ok(pricing)
    }

    fn user_config_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("ccdbg").join("pricing.toml"))
    }

    fn parse(s: &str) -> Result<Self> {
        let models: HashMap<String, ModelPricing> = toml::from_str(s)?;
        Ok(Self { models })
    }

    /// Compute USD cost for a single message's token totals on a given model.
    /// Returns 0.0 if the model is unknown.
    pub fn cost(&self, model: &str, tokens: &TokenTotals) -> f64 {
        let Some(p) = self.models.get(model) else {
            return 0.0;
        };
        let m = 1_000_000.0;
        (tokens.input as f64) * p.input / m
            + (tokens.output as f64) * p.output / m
            + (tokens.cache_read as f64) * p.cache_read / m
            + (tokens.cache_creation_5m as f64) * p.cache_creation_5m / m
            + (tokens.cache_creation_1h as f64) * p.cache_creation_1h / m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_pricing_parses() {
        let p = Pricing::parse(DEFAULT_PRICING).unwrap();
        assert!(p.models.contains_key("claude-sonnet-4-6"));
        assert!(p.models.contains_key("claude-opus-4-7"));
        assert!(p.models.contains_key("claude-haiku-4-5"));
    }

    #[test]
    fn cost_of_one_million_input_tokens_equals_input_rate() {
        let p = Pricing::parse(DEFAULT_PRICING).unwrap();
        let t = TokenTotals {
            input: 1_000_000,
            ..Default::default()
        };
        let c = p.cost("claude-sonnet-4-6", &t);
        assert!((c - 3.00).abs() < 1e-9, "got {}", c);
    }

    #[test]
    fn unknown_model_returns_zero_cost() {
        let p = Pricing::parse(DEFAULT_PRICING).unwrap();
        let t = TokenTotals {
            input: 1_000_000,
            ..Default::default()
        };
        assert_eq!(p.cost("no-such-model", &t), 0.0);
    }
}
