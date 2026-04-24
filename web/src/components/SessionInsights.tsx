import type { Session } from '@/types'
import { useBundle } from '@/BundleContext'
import { SeverityBadge } from './SeverityBadge'

interface MicroInsight {
  label: string
  detail: string
  severity: 'high' | 'warn' | 'info'
}

function computeMicroInsights(session: Session): MicroInsight[] {
  const out: MicroInsight[] = []

  // Model drift
  const models = [...new Set(session.turns.map((t) => t.model).filter(Boolean))]
  if (models.length > 1) {
    out.push({
      label: 'Model switched mid-session',
      detail: models.map((m) => m.replace('claude-', '')).join(' → '),
      severity: 'info',
    })
  }

  // Context growth
  const turns = session.turns
  if (turns.length >= 2) {
    const first = turns[0].context_window_tokens
    const last = turns[turns.length - 1].context_window_tokens
    if (first > 0 && last > first * 3) {
      const ratio = (last / first).toFixed(1)
      out.push({
        label: `Context grew ${ratio}×`,
        detail: `${Math.round(first / 1000)}K → ${Math.round(last / 1000)}K tokens`,
        severity: last > 150_000 ? 'high' : 'warn',
      })
    }
  }

  // Tool errors
  const errors = session.tool_calls.filter((tc) => !tc.success)
  if (errors.length > 0) {
    const tools = [...new Set(errors.map((e) => e.tool))].slice(0, 3).join(', ')
    out.push({
      label: `${errors.length} tool error${errors.length > 1 ? 's' : ''}`,
      detail: tools,
      severity: errors.length >= 5 ? 'high' : 'warn',
    })
  }

  // Loops
  if (session.loop_count > 0) {
    out.push({
      label: `${session.loop_count} tool loop${session.loop_count > 1 ? 's' : ''} detected`,
      detail: 'Repeated identical tool calls (3+ in a row)',
      severity: 'warn',
    })
  }

  // Subagents
  if (session.has_sidechain) {
    out.push({
      label: 'Spawned subagents',
      detail: 'Parallel tool calls via sidechain turns',
      severity: 'info',
    })
  }

  // Large peak context
  if (session.peak_context_tokens > 150_000 && out.every((i) => !i.label.startsWith('Context grew'))) {
    out.push({
      label: 'Large context window',
      detail: `Peak ${Math.round(session.peak_context_tokens / 1000)}K tokens`,
      severity: 'warn',
    })
  }

  return out
}

export function SessionInsights({ session }: { session: Session }) {
  const { insights } = useBundle()
  const micro = computeMicroInsights(session)
  const global = insights.filter((i) => i.evidence_session_ids.includes(session.id))

  if (micro.length === 0 && global.length === 0) return null

  return (
    <div className="mb-6">
      <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
        session signals
      </p>
      <div className="space-y-1.5">
        {micro.map((m, i) => (
          <div key={i} className="flex items-start gap-2 text-sm border rounded-md px-3 py-2">
            <SeverityBadge severity={m.severity} />
            <div>
              <span className="font-medium">{m.label}</span>
              {m.detail && (
                <span className="text-muted-foreground font-mono text-xs ml-2">{m.detail}</span>
              )}
            </div>
          </div>
        ))}
        {global.map((g, i) => (
          <div key={`g-${i}`} className="flex items-start gap-2 text-sm border rounded-md px-3 py-2">
            <SeverityBadge severity={g.severity} />
            <div>
              <span className="font-medium">{g.headline}</span>
              {g.mitigation && (
                <p className="text-xs text-muted-foreground mt-0.5">{g.mitigation.advice}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
