import { useMemo } from 'react'
import { useBundle, useSelectedSession } from '@/BundleContext'
import { InsightsTray } from '@/components/InsightsTray'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

function projectShort(p: string) {
  const parts = p.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}

function fmtK(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n))
}

export function IssuesView({ onOpenDetail }: { onOpenDetail?: () => void }) {
  const { sessions } = useBundle()
  const { setSelectedSessionId } = useSelectedSession()

  const openDetail = (id: string) => {
    setSelectedSessionId(id)
    onOpenDetail?.()
  }

  const toolErrors = useMemo(() => {
    const agg: Record<string, { tool: string; fails: number; sessions: Set<string> }> = {}
    for (const s of sessions) {
      for (const tc of s.tool_calls) {
        if (tc.success) continue
        const e = (agg[tc.tool] ??= { tool: tc.tool, fails: 0, sessions: new Set() })
        e.fails += 1
        e.sessions.add(s.id)
      }
    }
    return Object.values(agg).sort((a, b) => b.fails - a.fails)
  }, [sessions])

  const loopSessions = useMemo(
    () => sessions.filter((s) => s.loop_count > 0).sort((a, b) => b.loop_count - a.loop_count),
    [sessions],
  )

  const bloated = useMemo(() => {
    const BIG = 150_000
    return sessions
      .filter((s) => s.peak_context_tokens >= BIG)
      .sort((a, b) => b.peak_context_tokens - a.peak_context_tokens)
  }, [sessions])

  return (
    <div>
      <InsightsTray />

      <section className="mb-8">
        <h2 className="text-sm font-semibold tracking-tight mb-2">
          tool errors{' '}
          <span className="text-muted-foreground font-normal">
            ({toolErrors.reduce((a, e) => a + e.fails, 0)} total)
          </span>
        </h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>tool</TableHead>
                <TableHead className="text-right">failures</TableHead>
                <TableHead className="text-right">sessions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {toolErrors.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground">
                    no tool errors
                  </TableCell>
                </TableRow>
              ) : (
                toolErrors.map((e) => (
                  <TableRow key={e.tool}>
                    <TableCell className="font-mono">{e.tool}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.fails}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.sessions.size}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-sm font-semibold tracking-tight mb-2">
          loops{' '}
          <span className="text-muted-foreground font-normal">({loopSessions.length} sessions)</span>
        </h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>project</TableHead>
                <TableHead>start</TableHead>
                <TableHead className="text-right">loops</TableHead>
                <TableHead className="text-right">turns</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loopSessions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    no looping sessions
                  </TableCell>
                </TableRow>
              ) : (
                loopSessions.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => openDetail(s.id)}
                  >
                    <TableCell className="font-mono text-xs">{projectShort(s.project)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {new Date(s.start_ts).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.loop_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.turns.length}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold tracking-tight mb-2">
          context bloat{' '}
          <span className="text-muted-foreground font-normal">(≥ 150K tokens)</span>
        </h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>project</TableHead>
                <TableHead>start</TableHead>
                <TableHead className="text-right">peak ctx</TableHead>
                <TableHead>flags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bloated.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">
                    no sessions exceeded 150K tokens
                  </TableCell>
                </TableRow>
              ) : (
                bloated.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => openDetail(s.id)}
                  >
                    <TableCell className="font-mono text-xs">{projectShort(s.project)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {new Date(s.start_ts).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtK(s.peak_context_tokens)} tok
                    </TableCell>
                    <TableCell>
                      {s.loop_count > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          looping
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  )
}
