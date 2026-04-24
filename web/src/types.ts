export interface TokenTotals {
  input: number
  output: number
  cache_read: number
  cache_creation_5m: number
  cache_creation_1h: number
}

export interface ToolCall {
  tool: string
  input_summary: string
  success: boolean
  turn_index: number
}

export interface Turn {
  index: number
  timestamp: string
  model: string
  role: 'user' | 'assistant'
  usage: TokenTotals
  context_window_tokens: number
  tool_calls: ToolCall[]
  is_sidechain: boolean
}

export interface Session {
  id: string
  project: string
  project_raw: string
  start_ts: string
  end_ts: string
  models_used: string[]
  primary_model: string
  turns: Turn[]
  token_totals: TokenTotals
  tool_calls: ToolCall[]
  estimated_cost_usd: number
  loop_count: number
  peak_context_tokens: number
  has_errors: boolean
  has_sidechain: boolean
  user_prompt: string | null
}

export type InsightKind =
  | 'model_what_if'
  | 'cache_waste'
  | 'tool_error_cost'
  | 'subagent_overhead'
  | 'context_decay'
  | 'idle_gap_cost'
  | 'model_drift'

export type Severity = 'info' | 'warn' | 'high'

export interface Mitigation {
  advice: string
  example_from_your_data: string | null
}

export interface Insight {
  kind: InsightKind
  severity: Severity
  headline: string
  metric_value: number
  metric_unit: string
  mitigation: Mitigation | null
  evidence_session_ids: string[]
}

export interface ModelRates {
  input: number
  output: number
  cache_read: number
}

export interface Bundle {
  generated_at: string
  schema_version: number
  sessions: Session[]
  insights: Insight[]
  model_rates: Record<string, ModelRates>
}
