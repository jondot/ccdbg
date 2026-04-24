import { useMemo, useState } from 'react'
import { useBundle, useSelectedSession } from '@/BundleContext'
import { MetricCard } from '@/components/MetricCard'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import type { Session } from '@/types'
import { CostAlternatives } from '@/components/CostAlternatives'
import { DetailView } from './DetailView'

type SortKey = 'start_ts' | 'turns' | 'cost' | 'peak_ctx' | 'loops'

function fmtCost(n: number) {
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(3)}`
}

function fmtK(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`
  return String(Math.round(n))
}

function projectShort(p: string) {
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join(' / ') || p
}

// ── Session row ───────────────────────────────────────────────────────────────

function SessionRow({ s, onSelect }: { s: Session; onSelect: () => void }) {
  return (
    <TableRow className="cursor-pointer hover:bg-muted/50" onClick={onSelect}>
      <TableCell className="font-mono text-xs pl-8">
        {s.user_prompt ? (
          <span className="text-muted-foreground truncate block max-w-[260px]">
            {s.user_prompt}
          </span>
        ) : (
          <span className="text-muted-foreground/40 italic text-[10px]">no prompt</span>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">
        {new Date(s.start_ts).toLocaleString(undefined, {
          month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        })}
      </TableCell>
      <TableCell className="font-mono text-[10px] text-muted-foreground">
        {s.primary_model.replace('claude-', '').replace(/-20\d{6}$/, '')}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">{s.turns.length}</TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        <span className="inline-flex items-center gap-0.5">
          {fmtCost(s.estimated_cost_usd)}
          <CostAlternatives session={s} />
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
        {fmtK(s.peak_context_tokens)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
        {s.loop_count || ''}
      </TableCell>
      <TableCell>
        <div className="flex gap-1">
          {s.has_errors && <Badge variant="destructive" className="text-[10px]">err</Badge>}
          {s.has_sidechain && <Badge variant="outline" className="text-[10px]">sub</Badge>}
        </div>
      </TableCell>
    </TableRow>
  )
}

// ── Grouped sessions list ─────────────────────────────────────────────────────

function GroupedList({
  sessions, sort, asc, setSortKey, onSelect,
}: {
  sessions: Session[]
  sort: SortKey; asc: boolean
  setSortKey: (k: SortKey) => void
  onSelect: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const groups = useMemo(() => {
    const map = new Map<string, Session[]>()
    for (const s of sessions) {
      const g = map.get(s.project) ?? []
      g.push(s)
      map.set(s.project, g)
    }
    return [...map.entries()]
      .map(([project, rows]) => ({
        project,
        rows,
        totalCost: rows.reduce((a, s) => a + s.estimated_cost_usd, 0),
        errorCount: rows.filter((s) => s.has_errors).length,
        latestTs: Math.max(...rows.map((s) => new Date(s.start_ts).getTime())),
      }))
      .sort((a, b) => b.latestTs - a.latestTs)
  }, [sessions])

  const toggle = (project: string) => {
    const s = new Set(collapsed)
    s.has(project) ? s.delete(project) : s.add(project)
    setCollapsed(s)
  }

  const SortHead = ({ label, k, right }: { label: string; k: SortKey; right?: boolean }) => (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground whitespace-nowrap ${right ? 'text-right' : ''}`}
      onClick={() => setSortKey(k)}
    >
      {label}{sort === k ? (asc ? ' ↑' : ' ↓') : ''}
    </TableHead>
  )

  return (
    <div className="rounded-md border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>prompt</TableHead>
            <SortHead label="start" k="start_ts" />
            <TableHead>model</TableHead>
            <SortHead label="turns" k="turns" right />
            <SortHead label="cost" k="cost" right />
            <SortHead label="peak ctx" k="peak_ctx" right />
            <SortHead label="loops" k="loops" right />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {groups.map(({ project, rows, totalCost, errorCount }) => {
            const open = !collapsed.has(project)
            return (
              <>
                {/* Project header row */}
                <TableRow
                  key={`hdr-${project}`}
                  className="bg-muted/40 hover:bg-muted/60 cursor-pointer select-none"
                  onClick={() => toggle(project)}
                >
                  <TableCell colSpan={5} className="py-2 pl-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm leading-none text-muted-foreground">{open ? '▾' : '▸'}</span>
                      <span className="font-mono text-xs font-medium">{projectShort(project)}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {rows.length} session{rows.length !== 1 ? 's' : ''}
                      </span>
                      {errorCount > 0 && (
                        <Badge variant="destructive" className="text-[10px]">{errorCount} err</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell className="text-right pr-4">
                    <span className="font-mono text-xs text-muted-foreground">{fmtCost(totalCost)}</span>
                  </TableCell>
                </TableRow>
                {/* Session rows */}
                {open && rows.map((s) => (
                  <SessionRow key={s.id} s={s} onSelect={() => onSelect(s.id)} />
                ))}
              </>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

// ── Flat sessions list ────────────────────────────────────────────────────────

function FlatList({
  sessions, sort, asc, setSortKey, onSelect,
}: {
  sessions: Session[]
  sort: SortKey; asc: boolean
  setSortKey: (k: SortKey) => void
  onSelect: (id: string) => void
}) {
  const SortHead = ({ label, k, right }: { label: string; k: SortKey; right?: boolean }) => (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground whitespace-nowrap ${right ? 'text-right' : ''}`}
      onClick={() => setSortKey(k)}
    >
      {label}{sort === k ? (asc ? ' ↑' : ' ↓') : ''}
    </TableHead>
  )

  return (
    <div className="rounded-md border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>project / prompt</TableHead>
            <SortHead label="start" k="start_ts" />
            <TableHead>model</TableHead>
            <SortHead label="turns" k="turns" right />
            <SortHead label="cost" k="cost" right />
            <SortHead label="peak ctx" k="peak_ctx" right />
            <SortHead label="loops" k="loops" right />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow key={s.id} className="cursor-pointer hover:bg-muted/50" onClick={() => onSelect(s.id)}>
              <TableCell className="font-mono text-xs">
                <div className="text-foreground">{projectShort(s.project)}</div>
                {s.user_prompt && (
                  <div className="text-[10px] text-muted-foreground mt-0.5 truncate max-w-[240px] font-sans">
                    {s.user_prompt}
                  </div>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                {new Date(s.start_ts).toLocaleString(undefined, {
                  month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </TableCell>
              <TableCell className="font-mono text-[10px] text-muted-foreground">
                {s.primary_model.replace('claude-', '').replace(/-20\d{6}$/, '')}
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs">{s.turns.length}</TableCell>
              <TableCell className="text-right tabular-nums text-xs">
                <span className="inline-flex items-center gap-0.5">
                  {fmtCost(s.estimated_cost_usd)}
                  <CostAlternatives session={s} />
                </span>
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                {fmtK(s.peak_context_tokens)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-xs text-muted-foreground">
                {s.loop_count || ''}
              </TableCell>
              <TableCell>
                <div className="flex gap-1">
                  {s.has_errors && <Badge variant="destructive" className="text-[10px]">err</Badge>}
                  {s.has_sidechain && <Badge variant="outline" className="text-[10px]">sub</Badge>}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function SessionsView() {
  const bundle = useBundle()
  const sessions = bundle.sessions
  const { selectedSessionId, setSelectedSessionId } = useSelectedSession()
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('start_ts')
  const [asc, setAsc] = useState(false)
  const [viewMode, setViewMode] = useState<'grouped' | 'flat'>('grouped')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const base = needle
      ? sessions.filter(
          (s) =>
            s.project.toLowerCase().includes(needle) ||
            s.primary_model.toLowerCase().includes(needle) ||
            s.id.toLowerCase().includes(needle) ||
            (s.user_prompt ?? '').toLowerCase().includes(needle),
        )
      : sessions
    const keyFn: Record<SortKey, (s: Session) => number | string> = {
      start_ts: (s) => s.start_ts,
      turns: (s) => s.turns.length,
      cost: (s) => s.estimated_cost_usd,
      peak_ctx: (s) => s.peak_context_tokens,
      loops: (s) => s.loop_count,
    }
    return [...base].sort((a, b) => {
      const ka = keyFn[sort](a)
      const kb = keyFn[sort](b)
      if (ka < kb) return asc ? -1 : 1
      if (ka > kb) return asc ? 1 : -1
      return 0
    })
  }, [sessions, q, sort, asc])

  const totalCost = sessions.reduce((a, s) => a + s.estimated_cost_usd, 0)
  const totalTurns = sessions.reduce((a, s) => a + s.turns.length, 0)
  const avgCtx = sessions.length > 0
    ? sessions.reduce((a, s) => a + s.peak_context_tokens, 0) / sessions.length
    : 0

  const setSortKey = (k: SortKey) => {
    if (sort === k) setAsc(!asc)
    else { setSort(k); setAsc(false) }
  }

  // Detail view (replaces list)
  if (selectedSessionId) {
    return (
      <div>
        <button
          onClick={() => setSelectedSessionId(null)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-6 transition-colors"
        >
          <span>←</span>
          <span>Sessions</span>
        </button>
        <DetailView />
      </div>
    )
  }

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <MetricCard label="sessions" value={String(sessions.length)} />
        <MetricCard label="total cost" value={fmtCost(totalCost)} />
        <MetricCard label="total turns" value={String(totalTurns)} />
        <MetricCard label="avg peak ctx" value={`${fmtK(avgCtx)} tok`} />
      </div>

      <div className="flex items-center gap-2 mb-4">
        <Input
          placeholder="filter by project, prompt, model, or id"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="max-w-sm"
        />
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={() => setViewMode('grouped')}
            className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
              viewMode === 'grouped'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-foreground'
            }`}
          >
            group
          </button>
          <button
            onClick={() => setViewMode('flat')}
            className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
              viewMode === 'flat'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-foreground'
            }`}
          >
            flat
          </button>
        </div>
      </div>

      {viewMode === 'grouped' ? (
        <GroupedList
          sessions={filtered}
          sort={sort}
          asc={asc}
          setSortKey={setSortKey}
          onSelect={setSelectedSessionId}
        />
      ) : (
        <FlatList
          sessions={filtered}
          sort={sort}
          asc={asc}
          setSortKey={setSortKey}
          onSelect={setSelectedSessionId}
        />
      )}
    </div>
  )
}
