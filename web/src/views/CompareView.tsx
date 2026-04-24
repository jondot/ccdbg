import { useMemo, useState } from 'react'
import { useBundle } from '@/BundleContext'
import { InsightsTray } from '@/components/InsightsTray'
import { MetricCard } from '@/components/MetricCard'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { Session } from '@/types'
import { CHART_PRIMARY } from '@/lib/colors'

function fmtCost(n: number) {
  return `$${n.toFixed(2)}`
}
function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n))
}
function projectShort(p: string) {
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}
function sessionLabel(s: Session) {
  const d = new Date(s.start_ts).toLocaleDateString()
  return `${d} · ${projectShort(s.project)} · $${s.estimated_cost_usd.toFixed(2)}`
}

function SessionPanel({ s }: { s: Session }) {
  const data = s.turns.map((t) => ({ idx: t.index, ctx: t.context_window_tokens }))
  return (
    <div className="space-y-4">
      <div>
        <p className="font-mono text-xs text-muted-foreground">{s.id}</p>
        <p className="font-medium text-sm">{projectShort(s.project)}</p>
        <p className="font-mono text-xs text-muted-foreground">
          {new Date(s.start_ts).toLocaleString()}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MetricCard label="turns" value={String(s.turns.length)} />
        <MetricCard label="cost" value={fmtCost(s.estimated_cost_usd)} />
        <MetricCard label="peak ctx" value={fmtK(s.peak_context_tokens)} />
        <MetricCard label="loops" value={String(s.loop_count)} />
      </div>
      <div className="border rounded-md p-3">
        <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider mb-1">
          context per turn
        </p>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={data}>
            <XAxis dataKey="idx" fontSize={10} />
            <YAxis fontSize={10} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} />
            <Tooltip formatter={(v: unknown) => [`${((v as number) / 1000).toFixed(1)}K`, 'ctx']} />
            <Line type="monotone" dataKey="ctx" stroke={CHART_PRIMARY} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

export function CompareView() {
  const { sessions } = useBundle()
  const sorted = useMemo(
    () => [...sessions].sort((a, b) => (a.start_ts < b.start_ts ? 1 : -1)),
    [sessions],
  )
  const [leftId, setLeftId] = useState<string>(sorted[0]?.id ?? '')
  const [rightId, setRightId] = useState<string>(sorted[1]?.id ?? '')

  const left = sorted.find((s) => s.id === leftId) ?? null
  const right = sorted.find((s) => s.id === rightId) ?? null

  return (
    <div>
      <InsightsTray />

      <div className="grid grid-cols-2 gap-4 mb-6">
        <Select value={leftId} onValueChange={setLeftId}>
          <SelectTrigger>
            <SelectValue placeholder="pick left session" />
          </SelectTrigger>
          <SelectContent>
            {sorted.map((s) => (
              <SelectItem key={s.id} value={s.id} className="font-mono text-xs">
                {sessionLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={rightId} onValueChange={setRightId}>
          <SelectTrigger>
            <SelectValue placeholder="pick right session" />
          </SelectTrigger>
          <SelectContent>
            {sorted.map((s) => (
              <SelectItem key={s.id} value={s.id} className="font-mono text-xs">
                {sessionLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div>
          {left ? (
            <SessionPanel s={left} />
          ) : (
            <p className="text-muted-foreground">pick a session</p>
          )}
        </div>
        <div>
          {right ? (
            <SessionPanel s={right} />
          ) : (
            <p className="text-muted-foreground">pick a session</p>
          )}
        </div>
      </div>
    </div>
  )
}
