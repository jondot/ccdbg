import { useState } from 'react'
import type { Session } from '@/types'
import { useBundle } from '@/BundleContext'

function computeAlt(session: Session, _model: string, rates: { input: number; output: number; cache_read: number }) {
  const t = session.token_totals
  const m = 1_000_000
  return (
    t.input * rates.input / m +
    t.output * rates.output / m +
    t.cache_read * rates.cache_read / m +
    (t.cache_creation_5m + t.cache_creation_1h) * rates.input / m  // approx cache creation at input rate
  )
}

// Short display names for models
function shortName(m: string): string {
  return m.replace('claude-', '').replace(/-20\d{6}$/, '')
}

export function CostAlternatives({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const { model_rates } = useBundle()

  // Build alternatives: exclude current primary model, group by family
  const current = session.primary_model
  const alternatives = Object.entries(model_rates)
    .filter(([name]) => name !== current)
    // Deduplicate by short name (keep first seen)
    .reduce<[string, typeof model_rates[string]][]>((acc, entry) => {
      const short = shortName(entry[0])
      if (!acc.some(([n]) => shortName(n) === short)) acc.push(entry)
      return acc
    }, [])
    .map(([name, rates]) => ({
      name,
      short: shortName(name),
      cost: computeAlt(session, name, rates),
    }))
    .sort((a, b) => a.cost - b.cost)

  const currentCost = session.estimated_cost_usd

  return (
    <span className="relative inline-flex items-center">
      <button
        className="ml-1 text-muted-foreground hover:text-foreground text-[10px] leading-none rounded-full border border-border w-3.5 h-3.5 flex items-center justify-center font-mono"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        aria-label="cost alternatives"
      >
        i
      </button>
      {open && (
        <div className="absolute left-5 top-0 z-50 bg-popover border rounded-md shadow-md p-2 min-w-[180px]">
          <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider mb-1.5">
            cost alternatives
          </p>
          <div className="space-y-0.5">
            <div className="flex justify-between text-xs gap-3">
              <span className="font-mono font-medium">{shortName(current)}</span>
              <span className="tabular-nums text-muted-foreground">current · ${currentCost.toFixed(3)}</span>
            </div>
            {alternatives.map((a) => {
              const delta = a.cost - currentCost
              const pct = currentCost > 0 ? (delta / currentCost) * 100 : 0
              return (
                <div key={a.name} className="flex justify-between text-xs gap-3">
                  <span className="font-mono text-muted-foreground">{a.short}</span>
                  <span className={`tabular-nums ${delta < 0 ? 'text-green-600' : 'text-muted-foreground'}`}>
                    ${a.cost.toFixed(3)} ({pct > 0 ? '+' : ''}{pct.toFixed(0)}%)
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </span>
  )
}
