import { Badge } from '@/components/ui/badge'
import type { Severity } from '@/types'

const LABELS: Record<Severity, { text: string; variant: 'secondary' | 'destructive' | 'outline' }> = {
  high: { text: 'HIGH', variant: 'destructive' },
  warn: { text: 'WARN', variant: 'secondary' },
  info: { text: 'INFO', variant: 'outline' },
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { text, variant } = LABELS[severity]
  return (
    <Badge variant={variant} className="font-mono text-[10px] tracking-wider">
      {text}
    </Badge>
  )
}
