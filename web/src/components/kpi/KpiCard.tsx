import type { ReactNode } from 'react'
import { TrendingDown, TrendingUp } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatCents } from '@/lib/money'

interface KpiCardProps {
  label: string
  valueCents: number
  /** delta en centimes vs période précédente (affiche une flèche de tendance) */
  deltaCents?: number
  /** suffixe libre sous la valeur (ex : date du point bas) */
  hint?: ReactNode
  intent?: 'default' | 'positive' | 'negative' | 'alert'
}

const VALUE_COLOR: Record<NonNullable<KpiCardProps['intent']>, string> = {
  default: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-foreground',
  alert: 'text-destructive',
}

export function KpiCard({ label, valueCents, deltaCents, hint, intent = 'default' }: KpiCardProps) {
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className={cn('tabular mt-1 text-2xl font-semibold tracking-tight', VALUE_COLOR[intent])}>
          {formatCents(valueCents)}
        </div>
        {deltaCents !== undefined && (
          <div
            className={cn(
              'mt-1 flex items-center gap-1 text-xs font-medium',
              deltaCents >= 0 ? 'text-positive' : 'text-destructive',
            )}
          >
            {deltaCents >= 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
            <span className="tabular">
              {deltaCents >= 0 ? '+' : ''}
              {formatCents(deltaCents)}
            </span>
            <span className="font-normal text-muted-foreground">sur 30 jours</span>
          </div>
        )}
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}
