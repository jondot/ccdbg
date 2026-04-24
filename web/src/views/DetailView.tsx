import { useState } from 'react'
import { useSelectedSession } from '@/BundleContext'
import { MetricCard } from '@/components/MetricCard'
import { SessionInsights } from '@/components/SessionInsights'
import { CostAlternatives } from '@/components/CostAlternatives'
import { ToolCallsTable } from '@/components/ToolCallsTable'
import { Badge } from '@/components/ui/badge'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts'
import { CHART_PRIMARY } from '@/lib/colors'

function fmtCost(n: number) {
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(3)}`
}

function fmtK(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(Math.round(n))
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

function projectShort(p: string) {
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join(' / ') || p
}

export function DetailView() {
  const { session } = useSelectedSession()
  const [selectedTurn, setSelectedTurn] = useState<number | null>(null)

  if (!session) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
        Select a session from the list to view details.
      </div>
    )
  }

  const start = new Date(session.start_ts)
  const end = new Date(session.end_ts)
  const durationMs = end.getTime() - start.getTime()
  const dateStr = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const startTime = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const endTime = end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  const turnData = session.turns.map((t) => ({
    idx: t.index,
    ctx: t.context_window_tokens,
  }))

  const toolCounts: Record<string, number> = {}
  for (const tc of session.tool_calls) {
    toolCounts[tc.tool] = (toolCounts[tc.tool] ?? 0) + 1
  }
  const toolData = Object.entries(toolCounts)
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)

  return (
    <div>
      {/* Session header */}
      <div className="mb-6 pb-5 border-b">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight leading-tight">
              {projectShort(session.project)}
            </h2>
            {session.user_prompt && (
              <p className="text-sm text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">
                {session.user_prompt}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
            {session.has_errors && <Badge variant="destructive">errors</Badge>}
            {session.has_sidechain && <Badge variant="secondary">subagent</Badge>}
          </div>
        </div>

        {/* Properties bar */}
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-3">
          <div className="flex items-center gap-1">
            {session.models_used.map((m) => (
              <Badge key={m} variant="outline" className="font-mono text-[10px] px-1.5">
                {m.replace('claude-', '').replace(/-20\d{6}$/, '')}
              </Badge>
            ))}
          </div>
          <span className="text-muted-foreground/30 select-none">·</span>
          <span className="text-xs text-muted-foreground font-mono">
            {dateStr} &nbsp;{startTime} → {endTime}
          </span>
          <span className="text-muted-foreground/30 select-none">·</span>
          <span className="text-xs text-muted-foreground font-mono">{fmtDuration(durationMs)}</span>
          <span className="text-muted-foreground/30 select-none">·</span>
          <span className="text-[10px] text-muted-foreground/40 font-mono tabular-nums">
            {session.id.slice(0, 8)}
          </span>
        </div>
      </div>

      {/* Session-specific signals */}
      <SessionInsights session={session} />

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <MetricCard label="turns" value={String(session.turns.length)} />
        <div className="relative">
          <MetricCard label="cost" value={fmtCost(session.estimated_cost_usd)} />
          <div className="absolute top-4 right-3">
            <CostAlternatives session={session} />
          </div>
        </div>
        <MetricCard label="peak ctx" value={`${fmtK(session.peak_context_tokens)} tok`} />
        <MetricCard label="loops" value={String(session.loop_count)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div className="border rounded-md p-4">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
            context window per turn
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={turnData} className="cursor-pointer">
              <XAxis dataKey="idx" fontSize={10} />
              <YAxis fontSize={10} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} />
              <Tooltip
                formatter={(v: unknown) => [`${(Number(v) / 1000).toFixed(1)}K tok`, 'ctx']}
                labelFormatter={(label) => `turn ${label}`}
              />
              <Line
                type="monotone"
                dataKey="ctx"
                stroke={CHART_PRIMARY}
                dot={false}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                activeDot={(props: any) => {
                  const { cx, cy, payload } = props
                  return (
                    <circle
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill={CHART_PRIMARY}
                      stroke="none"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSelectedTurn(payload?.idx ?? null)}
                    />
                  )
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="border rounded-md p-4">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
            tool calls by type
          </p>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={toolData}>
              <XAxis dataKey="tool" fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip />
              <Bar dataKey="count" fill={CHART_PRIMARY} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <ToolCallsTable session={session} selectedTurnIndex={selectedTurn} />
    </div>
  )
}
