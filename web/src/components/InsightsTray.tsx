import { useBundleState } from '@/BundleContext'
import { Card, CardContent } from '@/components/ui/card'
import { SeverityBadge } from './SeverityBadge'
import type { Insight, Severity } from '@/types'

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, warn: 1, info: 2 }

function rank(a: Insight, b: Insight) {
  const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  if (s !== 0) return s
  return (b.metric_value || 0) - (a.metric_value || 0)
}

export function InsightsTray({ max = 3 }: { max?: number }) {
  const load = useBundleState()
  if (load.status !== 'ready') return null
  const bundle = load.bundle

  const top = [...bundle.insights].sort(rank).slice(0, max)
  if (top.length === 0) return null

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
      {top.map((i, idx) => (
        <Card key={idx}>
          <CardContent className="pt-4 pb-4 space-y-2">
            <div className="flex items-center gap-2">
              <SeverityBadge severity={i.severity} />
              <span className="text-xs text-muted-foreground font-mono">{i.kind}</span>
            </div>
            <p className="text-sm font-medium leading-tight">{i.headline}</p>
            {i.mitigation && (
              <p className="text-xs text-muted-foreground leading-snug">{i.mitigation.advice}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
