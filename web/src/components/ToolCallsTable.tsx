import { useMemo, useState, useEffect, useRef } from 'react'
import { useBundle } from '@/BundleContext'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { Session, Turn, ModelRates } from '@/types'

// ── helpers ──────────────────────────────────────────────────────────────────

function findRate(model: string, rates: Record<string, ModelRates>): ModelRates | null {
  if (rates[model]) return rates[model]
  const bare = model.replace('claude-', '').replace(/-20\d{6}$/, '')
  for (const [key, rate] of Object.entries(rates)) {
    if (key.replace('claude-', '').replace(/-20\d{6}$/, '') === bare) return rate
  }
  return null
}

function turnCost(turn: Turn, rates: Record<string, ModelRates>): number {
  const r = findRate(turn.model, rates)
  if (!r) return 0
  const { input, output, cache_read } = turn.usage
  return (input * r.input + output * r.output + cache_read * r.cache_read) / 1_000_000
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

function fmtCost(n: number): string {
  if (n === 0) return '—'
  if (n < 0.001) return `$${n.toFixed(5)}`
  if (n < 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(3)}`
}

function fmtTime(ts: string, sessionStart: string): string {
  const offset = new Date(ts).getTime() - new Date(sessionStart).getTime()
  if (offset < 0) return new Date(ts).toLocaleTimeString()
  const s = Math.floor(offset / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `+${h}h${m % 60}m`
  if (m > 0) return `+${m}m${s % 60}s`
  return `+${s}s`
}

function shortModel(m: string): string {
  return m.replace('claude-', '').replace(/-20\d{6}$/, '')
}

// ── enriched call type ────────────────────────────────────────────────────────

interface RichCall {
  tool: string
  input_summary: string
  success: boolean
  turn_index: number
  timestamp: string
  tokens_in: number
  tokens_out: number
  context_tokens: number
  cost_usd: number
  duration_ms: number | null
  model: string
}

function enrich(session: Session, rates: Record<string, ModelRates>): RichCall[] {
  const turnMap = new Map(session.turns.map((t) => [t.index, t]))
  const callsPerTurn = new Map<number, number>()
  for (const tc of session.tool_calls) {
    callsPerTurn.set(tc.turn_index, (callsPerTurn.get(tc.turn_index) ?? 0) + 1)
  }
  const sortedTurns = [...session.turns].sort((a, b) => a.index - b.index)

  return session.tool_calls.map((tc) => {
    const turn = turnMap.get(tc.turn_index)
    if (!turn) {
      return {
        tool: tc.tool, input_summary: tc.input_summary, success: tc.success,
        turn_index: tc.turn_index, timestamp: '', tokens_in: 0, tokens_out: 0,
        context_tokens: 0, cost_usd: 0, duration_ms: null, model: '',
      }
    }
    const nCalls = callsPerTurn.get(tc.turn_index) ?? 1
    const cost = turnCost(turn, rates) / nCalls
    const turnIdx = sortedTurns.findIndex((t) => t.index === turn.index)
    const prevTurn = turnIdx > 0 ? sortedTurns[turnIdx - 1] : null
    const nextTurn = sortedTurns[turnIdx + 1] ?? null
    const duration_ms = nextTurn
      ? new Date(nextTurn.timestamp).getTime() - new Date(turn.timestamp).getTime()
      : null
    // ctx delta: how many tokens were added to the context this turn
    const ctxDelta = Math.max(0, turn.context_window_tokens - (prevTurn?.context_window_tokens ?? 0))
    return {
      tool: tc.tool, input_summary: tc.input_summary, success: tc.success,
      turn_index: tc.turn_index, timestamp: turn.timestamp,
      tokens_in: Math.round(ctxDelta / nCalls),
      tokens_out: Math.round(turn.usage.output / nCalls),
      context_tokens: turn.context_window_tokens,
      cost_usd: cost, duration_ms, model: turn.model,
    }
  })
}

// ── sort ──────────────────────────────────────────────────────────────────────

type SortKey = 'timestamp' | 'tool' | 'tokens' | 'cost' | 'duration' | 'status' | 'turn' | 'ctx'

function sortCalls(calls: RichCall[], key: SortKey, asc: boolean): RichCall[] {
  const val = (c: RichCall): number | string => {
    switch (key) {
      case 'timestamp': return c.timestamp
      case 'tool':      return c.tool
      case 'tokens':    return c.tokens_in + c.tokens_out
      case 'cost':      return c.cost_usd
      case 'duration':  return c.duration_ms ?? -1
      case 'status':    return c.success ? 1 : 0
      case 'turn':      return c.turn_index
      case 'ctx':       return c.context_tokens
    }
  }
  return [...calls].sort((a, b) => {
    const va = val(a), vb = val(b)
    if (va < vb) return asc ? -1 : 1
    if (va > vb) return asc ? 1 : -1
    return 0
  })
}

// ── shared header cell ────────────────────────────────────────────────────────

const headCls = 'h-8 px-3 py-0 text-[10px] font-mono uppercase tracking-wider text-muted-foreground whitespace-nowrap'

function ColHead({
  label, sortKey, current, asc, onClick,
}: {
  label: string; sortKey: SortKey; current: SortKey; asc: boolean
  onClick: (k: SortKey) => void
}) {
  return (
    <TableHead
      className={`${headCls} cursor-pointer select-none hover:text-foreground`}
      onClick={() => onClick(sortKey)}
    >
      {label}{current === sortKey ? (asc ? ' ↑' : ' ↓') : ''}
    </TableHead>
  )
}

function StaticHead({ children, className }: { children: React.ReactNode; className?: string }) {
  return <TableHead className={`${headCls} ${className ?? ''}`}>{children}</TableHead>
}

function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(0)}K` : String(n)
}

function tokenBg(tokens: number, maxTokens: number): string {
  if (maxTokens === 0 || tokens === 0) return ''
  const r = tokens / maxTokens
  if (r < 0.33) return ''
  if (r < 0.60) return 'bg-amber-50/70 dark:bg-amber-950/25'
  if (r < 0.80) return 'bg-orange-50/70 dark:bg-orange-950/25'
  return 'bg-red-50/70 dark:bg-red-950/25'
}

// ── shared inner table (used by both views) ───────────────────────────────────

function CallsTable({
  calls, sessionStart, sort, asc, onSort, showTool = false, selectedTurnIndex,
}: {
  calls: RichCall[]; sessionStart: string
  sort: SortKey; asc: boolean; onSort: (k: SortKey) => void
  showTool?: boolean
  selectedTurnIndex?: number | null
}) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const colCount = showTool ? 11 : 10
  const maxTokens = useMemo(
    () => Math.max(...calls.map((c) => c.tokens_in + c.tokens_out), 1),
    [calls],
  )

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <ColHead label="turn" sortKey="turn" current={sort} asc={asc} onClick={onSort} />
          <ColHead label="ctx" sortKey="ctx" current={sort} asc={asc} onClick={onSort} />
          {showTool && <ColHead label="tool" sortKey="tool" current={sort} asc={asc} onClick={onSort} />}
          <ColHead label="time" sortKey="timestamp" current={sort} asc={asc} onClick={onSort} />
          <StaticHead>input</StaticHead>
          <StaticHead>model</StaticHead>
          <ColHead label="in" sortKey="tokens" current={sort} asc={asc} onClick={onSort} />
          <StaticHead className="text-right">out</StaticHead>
          <ColHead label="~cost" sortKey="cost" current={sort} asc={asc} onClick={onSort} />
          <ColHead label="dur" sortKey="duration" current={sort} asc={asc} onClick={onSort} />
          {showTool
            ? <ColHead label="st" sortKey="status" current={sort} asc={asc} onClick={onSort} />
            : <StaticHead>{''}</StaticHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((c, i) => {
          const isSelected = selectedTurnIndex != null && c.turn_index === selectedTurnIndex
          const isExpanded = expandedIdx === i
          const heatCls = tokenBg(c.tokens_in + c.tokens_out, maxTokens)
          const rowCls = isSelected
            ? 'bg-primary/10 dark:bg-primary/20 hover:bg-primary/15 cursor-pointer'
            : `${heatCls} cursor-pointer`

          return (
            <>
              <TableRow
                key={i}
                data-turn={c.turn_index}
                className={rowCls}
                onClick={() => setExpandedIdx(isExpanded ? null : i)}
              >
                <TableCell className="px-3 py-1.5 font-mono text-[10px] tabular-nums text-muted-foreground whitespace-nowrap">
                  {c.turn_index}
                </TableCell>
                <TableCell className="px-3 py-1.5 font-mono text-[10px] tabular-nums text-right text-muted-foreground whitespace-nowrap">
                  {fmtK(c.context_tokens)}
                </TableCell>
                {showTool && (
                  <TableCell className="px-3 py-1.5 font-mono text-xs whitespace-nowrap">{c.tool}</TableCell>
                )}
                <TableCell className="px-3 py-1.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
                  {c.timestamp ? fmtTime(c.timestamp, sessionStart) : '—'}
                </TableCell>
                <TableCell className="px-3 py-1.5 font-mono text-xs max-w-[180px] truncate text-muted-foreground">
                  {c.input_summary || <span className="italic">no args</span>}
                </TableCell>
                <TableCell className="px-3 py-1.5 font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                  {c.model ? shortModel(c.model) : '—'}
                </TableCell>
                <TableCell className="px-3 py-1.5 font-mono text-[10px] text-right tabular-nums text-muted-foreground whitespace-nowrap">
                  {fmtK(c.tokens_in)}
                </TableCell>
                <TableCell className="px-3 py-1.5 font-mono text-[10px] text-right tabular-nums text-muted-foreground whitespace-nowrap">
                  {fmtK(c.tokens_out)}
                </TableCell>
                <TableCell className="px-3 py-1.5 font-mono text-xs text-right tabular-nums whitespace-nowrap">
                  {fmtCost(c.cost_usd)}
                </TableCell>
                <TableCell className="px-3 py-1.5 font-mono text-xs text-right tabular-nums text-muted-foreground whitespace-nowrap">
                  {c.duration_ms != null ? fmtDuration(c.duration_ms) : '—'}
                </TableCell>
                <TableCell className="px-3 py-1.5 w-8">
                  {!c.success && <Badge variant="destructive" className="text-[10px]">err</Badge>}
                </TableCell>
              </TableRow>
              {isExpanded && c.input_summary && (
                <TableRow key={`${i}-exp`} className="hover:bg-transparent">
                  <TableCell colSpan={colCount} className="px-3 pt-0 pb-2 border-t-0">
                    <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-all bg-muted/30 rounded px-3 py-2 leading-relaxed">
                      {c.input_summary}
                    </pre>
                  </TableCell>
                </TableRow>
              )}
            </>
          )
        })}
      </TableBody>
    </Table>
  )
}

// ── grouped view ──────────────────────────────────────────────────────────────

function GroupedView({ calls, sessionStart, sort, asc, onSort, selectedTurnIndex }: {
  calls: RichCall[]; sessionStart: string
  sort: SortKey; asc: boolean; onSort: (k: SortKey) => void
  selectedTurnIndex?: number | null
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    const m = new Map<string, RichCall[]>()
    for (const c of calls) {
      const g = m.get(c.tool) ?? []
      g.push(c)
      m.set(c.tool, g)
    }
    return [...m.entries()]
      .map(([tool, rows]) => ({
        tool,
        rows: sortCalls(rows, sort, asc),
        errors: rows.filter((r) => !r.success).length,
        totalCost: rows.reduce((s, r) => s + r.cost_usd, 0),
        avgDuration:
          rows.filter((r) => r.duration_ms != null).length > 0
            ? rows.reduce((s, r) => s + (r.duration_ms ?? 0), 0) /
              rows.filter((r) => r.duration_ms != null).length
            : null,
      }))
      .sort((a, b) => b.rows.length - a.rows.length)
  }, [calls, sort, asc])

  const toggle = (tool: string) => {
    const s = new Set(expanded)
    s.has(tool) ? s.delete(tool) : s.add(tool)
    setExpanded(s)
  }

  return (
    <div className="space-y-1">
      {groups.map(({ tool, rows, errors, totalCost, avgDuration }) => {
        const open = expanded.has(tool)
        return (
          <div key={tool} className="border rounded-md overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 text-left"
              onClick={() => toggle(tool)}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{open ? '▾' : '▸'}</span>
                <span className="font-mono text-xs font-medium">{tool}</span>
                <span className="text-[10px] text-muted-foreground">×{rows.length}</span>
                {errors > 0 && (
                  <Badge variant="destructive" className="text-[10px]">{errors} err</Badge>
                )}
              </div>
              <div className="flex items-center gap-4 text-[10px] font-mono text-muted-foreground">
                {avgDuration != null && <span>avg {fmtDuration(avgDuration)}</span>}
                <span>{fmtCost(totalCost)}</span>
              </div>
            </button>

            {open && (
              <div className="border-t">
                <CallsTable
                  calls={rows}
                  sessionStart={sessionStart}
                  sort={sort}
                  asc={asc}
                  onSort={onSort}
                  showTool={false}
                  selectedTurnIndex={selectedTurnIndex}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── main export ───────────────────────────────────────────────────────────────

export function ToolCallsTable({
  session,
  selectedTurnIndex,
}: {
  session: Session
  selectedTurnIndex?: number | null
}) {
  const { model_rates } = useBundle()
  const [grouped, setGrouped] = useState(false)
  const [sort, setSort] = useState<SortKey>('timestamp')
  const [asc, setAsc] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const calls = useMemo(() => enrich(session, model_rates), [session, model_rates])
  const sorted = useMemo(() => sortCalls(calls, sort, asc), [calls, sort, asc])

  // When a turn is selected from the chart, switch to flat and scroll to it.
  // setGrouped triggers a re-render; we defer the querySelector until after React commits.
  useEffect(() => {
    if (selectedTurnIndex == null) return
    setGrouped(false)
    const turn = selectedTurnIndex
    const id = setTimeout(() => {
      const el = scrollRef.current?.querySelector(`[data-turn="${turn}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    return () => clearTimeout(id)
  }, [selectedTurnIndex])

  const handleSort = (k: SortKey) => {
    if (sort === k) setAsc(!asc)
    else { setSort(k); setAsc(true) }
  }

  const totalCost = calls.reduce((s, c) => s + c.cost_usd, 0)
  const errorCount = calls.filter((c) => !c.success).length

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
            tool calls ({session.tool_calls.length})
          </p>
          {errorCount > 0 && (
            <Badge variant="destructive" className="text-[10px]">{errorCount} errors</Badge>
          )}
          <span className="text-[10px] font-mono text-muted-foreground">
            ~{totalCost.toFixed(4) !== '0.0000' ? `$${totalCost.toFixed(4)}` : '< $0.0001'} total
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setGrouped(false)}
            className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
              !grouped
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-foreground'
            }`}
          >
            flat
          </button>
          <button
            onClick={() => setGrouped(true)}
            className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
              grouped
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-foreground'
            }`}
          >
            group
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="max-h-[32rem] overflow-y-auto">
        {grouped ? (
          <GroupedView
            calls={sorted}
            sessionStart={session.start_ts}
            sort={sort}
            asc={asc}
            onSort={handleSort}
            selectedTurnIndex={selectedTurnIndex}
          />
        ) : (
          <div className="border rounded-md overflow-hidden">
            <CallsTable
              calls={sorted}
              sessionStart={session.start_ts}
              sort={sort}
              asc={asc}
              onSort={handleSort}
              showTool
              selectedTurnIndex={selectedTurnIndex}
            />
          </div>
        )}
      </div>
    </div>
  )
}
