import { CircleAlert, Clock4, Search, Wallet, Scale } from 'lucide-react'
import type { Alert } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatCents } from '@/lib/money'

const ICONS: Record<Alert['kind'], typeof CircleAlert> = {
  low_point: CircleAlert,
  overdue_invoice: Clock4,
  anomaly: Search,
  net_below_threshold: Wallet,
  reconciliation: Scale,
}

// Réserver le rouge aux vraies alertes (critical). Le warning passe en ambre, l'info
// en neutre : un avertissement ne doit pas crier au feu rouge.
const SEVERITY_STYLE: Record<Alert['severity'], string> = {
  critical: 'text-destructive bg-destructive/10',
  warning: 'text-warning bg-warning/10',
  info: 'text-muted-foreground bg-muted',
}

export function AlertsList({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) {
    return <p className="text-sm text-muted-foreground">Aucune alerte. Trésorerie sous contrôle.</p>
  }
  return (
    <ul className="flex flex-col gap-3">
      {alerts.map((alert) => {
        const Icon = ICONS[alert.kind] ?? CircleAlert
        return (
          <li key={alert.id} className="flex items-start gap-3">
            <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md', SEVERITY_STYLE[alert.severity])}>
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{alert.title}</span>
                <span className="tabular shrink-0 text-sm font-semibold">{formatCents(alert.amountCents)}</span>
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{alert.detail}</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
