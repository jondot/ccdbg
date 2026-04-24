import { useMemo, useRef, useState } from 'react'
import { useBundle } from '@/BundleContext'
import { InsightsTray } from '@/components/InsightsTray'
import { CHART_COLORS, CHART_PRIMARY } from '@/lib/colors'
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  ReferenceLine,
} from 'recharts'

type Range = '7d' | '30d' | '90d' | 'all'

function startOfWeek(d: Date): string {
  const diff = (d.getDay() + 6) % 7
  const monday = new Date(d)
  monday.setDate(d.getDate() - diff)
  return monday.toISOString().slice(0, 10)
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function rangeStart(range: Range): Date | null {
  if (range === 'all') return null
  const d = new Date()
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  d.setDate(d.getDate() - days)
  return d
}

type DayEntry = { cost: number; count: number; turns: number; peak_ctx: number }
type HeatCell = DayEntry & { date: string; dow: number }

// ── Heatmap ───────────────────────────────────────────────────────────────────

function HeatmapGrid({ data, range }: { data: Record<string, DayEntry>; range: Range }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<{ cell: HeatCell; x: number; y: number } | null>(null)

  const today = new Date()
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90  // 'all' also uses 90 for fixed grid
  const cells: HeatCell[] = []
  for (let i = days; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const key = dayKey(d)
    const entry = data[key]
    cells.push({
      date: key,
      cost: entry?.cost ?? 0,
      count: entry?.count ?? 0,
      turns: entry?.turns ?? 0,
      peak_ctx: entry?.peak_ctx ?? 0,
      dow: d.getDay(),
    })
  }

  const maxCost = Math.max(...cells.map((c) => c.cost), 0.01)
  const intensity = (cost: number) => cost === 0 ? 0 : Math.ceil((cost / maxCost) * 4)
  const activeColor = ['#C7D2FE', '#818CF8', '#6366F1', '#4F46E5', '#3730A3']

  // Arrange into week columns (Sun→Sat)
  const cols: HeatCell[][] = []
  let col: HeatCell[] = []
  const firstDow = cells[0].dow
  for (let i = 0; i < firstDow; i++) col.push({ date: '', cost: 0, count: 0, turns: 0, peak_ctx: 0, dow: i })
  for (const c of cells) {
    col.push(c)
    if (c.dow === 6) { cols.push(col); col = [] }
  }
  if (col.length > 0) cols.push(col)

  const handleMouseEnter = (cell: HeatCell, e: React.MouseEvent<HTMLDivElement>) => {
    if (!cell.date) return
    const containerRect = containerRef.current?.getBoundingClientRect()
    const cellRect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    if (!containerRect) return
    setTooltip({
      cell,
      x: cellRect.left - containerRect.left + cellRect.width / 2,
      y: cellRect.top - containerRect.top,
    })
  }

  return (
    <div ref={containerRef} className="relative">
      {tooltip && (
        <div
          className="absolute z-20 bg-popover border border-border rounded-md shadow-md px-3 py-2 text-xs font-mono pointer-events-none"
          style={{ left: tooltip.x, top: tooltip.y - 90, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}
        >
          <div className="font-semibold text-foreground mb-1">
            {new Date(tooltip.cell.date + 'T12:00:00').toLocaleDateString('en-US', {
              weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
            })}
          </div>
          {tooltip.cell.count === 0 ? (
            <div className="text-muted-foreground">no sessions</div>
          ) : (
            <>
              <div className="text-muted-foreground">
                <span className="text-foreground">${tooltip.cell.cost.toFixed(2)}</span>
                {' · '}
                {tooltip.cell.count} session{tooltip.cell.count !== 1 ? 's' : ''}
                {' · '}
                {tooltip.cell.turns} turns
              </div>
              <div className="text-muted-foreground mt-0.5">
                peak ctx:{' '}
                <span className="text-foreground">
                  {tooltip.cell.peak_ctx >= 1000
                    ? `${(tooltip.cell.peak_ctx / 1000).toFixed(0)}K`
                    : tooltip.cell.peak_ctx} tok
                </span>
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex gap-[3px] w-full" onMouseLeave={() => setTooltip(null)}>
        {cols.map((col, ci) => (
          <div key={ci} className="flex flex-col gap-[3px] flex-1">
            {col.map((cell, ri) => {
              if (!cell.date) {
                return <div key={ri} className="aspect-square" />
              }
              if (cell.count === 0) {
                return (
                  <div
                    key={ri}
                    className="aspect-square rounded-[2px] border border-border/40 bg-background cursor-default"
                    onMouseEnter={(e) => handleMouseEnter(cell, e)}
                  />
                )
              }
              return (
                <div
                  key={ri}
                  className="aspect-square rounded-[2px] cursor-default"
                  style={{ backgroundColor: activeColor[intensity(cell.cost)] }}
                  onMouseEnter={(e) => handleMouseEnter(cell, e)}
                />
              )
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1.5 mt-2">
        <span className="text-[10px] text-muted-foreground">less</span>
        {activeColor.map((color, i) => (
          <div key={i} className="w-3 h-3 rounded-[2px]" style={{ backgroundColor: color }} />
        ))}
        <span className="text-[10px] text-muted-foreground">more</span>
      </div>
    </div>
  )
}

// ── Profile view ──────────────────────────────────────────────────────────────

export function ProfileView() {
  const { sessions } = useBundle()
  const [range, setRange] = useState<Range>('all')

  const filtered = useMemo(() => {
    const cutoff = rangeStart(range)
    if (!cutoff) return sessions
    return sessions.filter((s) => new Date(s.start_ts) >= cutoff)
  }, [sessions, range])

  // Heatmap — uses filtered so range applies
  const heatmapData = useMemo(() => {
    const map: Record<string, DayEntry> = {}
    for (const s of filtered) {
      const key = dayKey(new Date(s.start_ts))
      if (!map[key]) map[key] = { cost: 0, count: 0, turns: 0, peak_ctx: 0 }
      map[key].cost += s.estimated_cost_usd
      map[key].count += 1
      map[key].turns += s.turns.length
      map[key].peak_ctx = Math.max(map[key].peak_ctx, s.peak_context_tokens)
    }
    return map
  }, [filtered])

  // Hourly cost
  const hourly = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, cost_usd: 0, sessions: 0 }))
    for (const s of filtered) {
      const h = new Date(s.start_ts).getHours()
      buckets[h].cost_usd += s.estimated_cost_usd
      buckets[h].sessions += 1
    }
    return buckets
  }, [filtered])

  // Day of week activity
  const dowData = useMemo(() => {
    const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const buckets = labels.map((label) => ({ label, sessions: 0, cost: 0 }))
    for (const s of filtered) {
      const dow = new Date(s.start_ts).getDay()
      buckets[dow].sessions += 1
      buckets[dow].cost += s.estimated_cost_usd
    }
    return buckets
  }, [filtered])

  // Session duration distribution
  const durationDist = useMemo(() => {
    const buckets = [
      { label: '<5m',    max: 5 * 60_000,   count: 0 },
      { label: '5-15m',  max: 15 * 60_000,  count: 0 },
      { label: '15-30m', max: 30 * 60_000,  count: 0 },
      { label: '30-60m', max: 60 * 60_000,  count: 0 },
      { label: '1h+',    max: Infinity,      count: 0 },
    ]
    for (const s of filtered) {
      const dur = new Date(s.end_ts).getTime() - new Date(s.start_ts).getTime()
      for (const b of buckets) {
        if (dur <= b.max) { b.count += 1; break }
      }
    }
    return buckets
  }, [filtered])

  // Cache hit rate over time (weekly)
  const cacheByWeek = useMemo(() => {
    const weekly: Record<string, { total: number; cached: number; cost: number }> = {}
    for (const s of filtered) {
      const wk = startOfWeek(new Date(s.start_ts))
      weekly[wk] ??= { total: 0, cached: 0, cost: 0 }
      weekly[wk].cost += s.estimated_cost_usd
      for (const t of s.turns) {
        const u = t.usage
        const total = u.input + u.cache_read + u.cache_creation_5m + u.cache_creation_1h
        weekly[wk].total += total
        weekly[wk].cached += u.cache_read
      }
    }
    return Object.entries(weekly)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, d]) => ({
        week,
        hit_pct: d.total > 0 ? +(d.cached / d.total * 100).toFixed(1) : 0,
        cost: +d.cost.toFixed(2),
      }))
  }, [filtered])

  // Model over time (weekly cost)
  const modelOverTime = useMemo(() => {
    const weekly: Record<string, Record<string, number>> = {}
    const allModels = new Set<string>()
    for (const s of filtered) {
      const wk = startOfWeek(new Date(s.start_ts))
      const m = s.primary_model.replace('claude-', '').replace(/-20\d{6}$/, '')
      allModels.add(m)
      weekly[wk] ??= {}
      weekly[wk][m] = (weekly[wk][m] ?? 0) + s.estimated_cost_usd
    }
    const weeks = Object.keys(weekly).sort()
    return { series: weeks.map((w) => ({ week: w, ...weekly[w] })), models: Array.from(allModels) }
  }, [filtered])

  // Prompt length distribution
  const promptLenDist = useMemo(() => {
    const buckets = [
      { label: '0-50',   max: 50,       count: 0 },
      { label: '51-200', max: 200,      count: 0 },
      { label: '201-500',max: 500,      count: 0 },
      { label: '501-1k', max: 1000,     count: 0 },
      { label: '1k+',    max: Infinity, count: 0 },
    ]
    for (const s of filtered) {
      const len = s.user_prompt?.length ?? 0
      if (len === 0) continue
      for (const b of buckets) {
        if (len <= b.max) { b.count += 1; break }
      }
    }
    return buckets
  }, [filtered])

  const withPrompt = filtered.filter((s) => s.user_prompt).length
  const avgCacheHit = cacheByWeek.length > 0
    ? (cacheByWeek.reduce((s, w) => s + w.hit_pct, 0) / cacheByWeek.length).toFixed(1)
    : null

  const RANGES: Range[] = ['7d', '30d', '90d', 'all']

  return (
    <div>
      <InsightsTray />

      {/* Range selector */}
      <div className="flex items-center gap-2 mb-6">
        <span className="text-xs text-muted-foreground font-mono">range:</span>
        {RANGES.map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`text-xs font-mono px-2 py-0.5 rounded border transition-colors ${
              range === r
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground'
            }`}
          >
            {r}
          </button>
        ))}
        <span className="text-xs text-muted-foreground font-mono ml-2">
          {filtered.length} sessions
        </span>
        {avgCacheHit != null && (
          <span className="text-xs text-muted-foreground font-mono ml-auto">
            avg cache hit: <span className="text-foreground">{avgCacheHit}%</span>
          </span>
        )}
      </div>

      {/* Heatmap */}
      <div className="border rounded-md p-4 mb-4">
        <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-3">
          activity · cost per day
        </p>
        <HeatmapGrid data={heatmapData} range={range} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* Hourly cost */}
        <div className="border rounded-md p-4">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
            cost by hour of day
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={hourly}>
              <XAxis dataKey="hour" fontSize={10} />
              <YAxis fontSize={10} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
              <Tooltip
                formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, 'cost']}
                labelFormatter={(h) => `${h}:00–${h}:59`}
              />
              <Bar dataKey="cost_usd" fill={CHART_PRIMARY} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Day of week */}
        <div className="border rounded-md p-4">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
            activity by day of week
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={dowData}>
              <XAxis dataKey="label" fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip formatter={(v: unknown) => [String(v), 'sessions']} />
              <Bar dataKey="sessions" fill={CHART_COLORS[2]} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* Session duration distribution */}
        <div className="border rounded-md p-4">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
            session duration distribution
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={durationDist}>
              <XAxis dataKey="label" fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip formatter={(v: unknown) => [String(v), 'sessions']} />
              <Bar dataKey="count" fill={CHART_COLORS[3]} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Prompt length distribution */}
        <div className="border rounded-md p-4">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
            prompt length distribution
            {withPrompt === 0 && <span className="text-destructive ml-1">(no data)</span>}
          </p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={promptLenDist}>
              <XAxis dataKey="label" fontSize={10} />
              <YAxis fontSize={10} />
              <Tooltip formatter={(v: unknown) => [String(v), 'sessions']} />
              <Bar dataKey="count" fill={CHART_COLORS[1]} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-[10px] text-muted-foreground mt-1">
            {withPrompt} of {filtered.length} sessions have a recorded prompt
          </p>
        </div>
      </div>

      {/* Model over time */}
      <div className="border rounded-md p-4 mb-4">
        <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider mb-2">
          model usage over time (weekly cost)
        </p>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={modelOverTime.series}>
            <XAxis dataKey="week" fontSize={10} />
            <YAxis fontSize={10} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
            <Tooltip formatter={(v: unknown) => [`$${(v as number).toFixed(2)}`, '']} />
            <Legend />
            {modelOverTime.models.map((m, i) => (
              <Line
                key={m}
                type="monotone"
                dataKey={m}
                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                dot={false}
                strokeWidth={2}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Cache hit rate */}
      {cacheByWeek.length > 0 && (
        <div className="border rounded-md p-4">
          <div className="flex items-baseline justify-between mb-2">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-wider">
              cache hit rate (weekly %)
            </p>
            <p className="text-[10px] text-muted-foreground font-mono">
              proportion of input tokens served from cache · higher = more efficient
            </p>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={cacheByWeek}>
              <XAxis dataKey="week" fontSize={10} />
              <YAxis fontSize={10} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
              <Tooltip formatter={(v: unknown) => [`${v}%`, 'cache hit rate']} />
              <ReferenceLine y={50} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" strokeOpacity={0.4} />
              <Line
                type="monotone"
                dataKey="hit_pct"
                stroke={CHART_COLORS[4 % CHART_COLORS.length]}
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
