import { useTransactions } from '@/lib/api'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { formatCentsExact } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'

// Le « relevé » : dernières opérations constatées, comme un flux bancaire synchronisé.
// minAbsCents : masque les micro-mouvements (centimes d'arrondi OVH, etc.) qui noient le relevé.
export function RecentTransactions({ limit = 8, minAbsCents = 0 }: { limit?: number; minAbsCents?: number }) {
  const txns = useTransactions({ limit: minAbsCents ? limit * 2 : limit })

  if (txns.isLoading || !txns.data) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-6" />
        ))}
      </div>
    )
  }

  return (
    <ul className="flex flex-col">
      {txns.data.filter((t) => Math.abs(t.amountCents) >= minAbsCents).slice(0, limit).map((t) => (
        <li key={t.id} className="flex items-center gap-3 border-b py-1.5 text-xs last:border-0">
          <span className="w-14 shrink-0 text-muted-foreground">{formatDateShort(t.date)}</span>
          <span className="min-w-0 flex-1 truncate" title={t.counterparty ?? undefined}>
            {t.label}
          </span>
          <span className={cn('tabular shrink-0 font-medium', t.amountCents >= 0 ? 'text-positive' : 'text-foreground')}>
            {t.amountCents >= 0 ? '+' : ''}
            {formatCentsExact(t.amountCents)}
          </span>
        </li>
      ))}
    </ul>
  )
}
