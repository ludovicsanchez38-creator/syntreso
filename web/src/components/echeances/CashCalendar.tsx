import { useCashCalendar } from '@/lib/api'
import type { Echeance } from '@/lib/api'
import { formatCents } from '@/lib/money'
import { formatDateShort, formatMonth } from '@/lib/dates'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Receipt, Landmark, FileText, Building2, ShieldCheck, Banknote, CircleDollarSign } from 'lucide-react'
import { cn } from '@/lib/utils'

// Icône par nature d'échéance (lucide, jamais d'emoji).
const KIND_ICON: Record<Echeance['kind'], typeof Receipt> = {
  tva: Receipt,
  urssaf: Landmark,
  is: FileText,
  loyer: Building2,
  assurance: ShieldCheck,
  emprunt: Banknote,
  autre: CircleDollarSign,
}

const KIND_LABEL: Record<Echeance['kind'], string> = {
  tva: 'TVA',
  urssaf: 'Cotisations',
  is: 'IS',
  loyer: 'Loyer',
  assurance: 'Assurance',
  emprunt: 'Emprunt',
  autre: 'Autre',
}

// Une échéance dérivée des flux (TVA/URSSAF recalculées) vs saisie à la main.
const SOURCE_LABEL: Record<Echeance['source'], string> = {
  derived: 'calculée',
  manual: 'saisie',
  agent: 'proposée',
}

/**
 * Cash calendar : ce qui SORT (et entre) de façon datée et certaine sur les prochaines
 * semaines. Couche d'affichage par-dessus le moteur mensuel : repère la concentration
 * d'échéances (le piège du dirigeant solo). Les montants viennent du serveur (TVA/URSSAF
 * dérivées + échéances saisies), le front ne calcule aucun solde.
 */
export function CashCalendar({ jours = 90 }: { jours?: number }) {
  const cal = useCashCalendar(jours)

  if (cal.isLoading || !cal.data) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    )
  }

  const { items, totalOutCents, byMonth, fromDate, toDate } = cal.data
  if (!items.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucune sortie datée certaine d'ici le {formatDateShort(toDate)}.
      </p>
    )
  }

  // Regroupement par mois pour visualiser la concentration d'échéances.
  const months: string[] = []
  const itemsByMonth: Record<string, Echeance[]> = {}
  for (const e of items) {
    const ym = e.dueDate.slice(0, 7)
    if (!itemsByMonth[ym]) {
      itemsByMonth[ym] = []
      months.push(ym)
    }
    itemsByMonth[ym].push(e)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>
          Du {formatDateShort(fromDate)} au {formatDateShort(toDate)}
        </span>
        <span>
          Total des sorties :{' '}
          <span className="tabular font-semibold text-foreground">{formatCents(totalOutCents)}</span>
        </span>
      </div>

      {months.map((ym) => {
        const monthItems = itemsByMonth[ym]
        const monthOut = byMonth[ym]?.outCents ?? 0
        return (
          <div key={ym} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between border-b pb-1">
              <span className="text-sm font-medium capitalize">{formatMonth(ym)}</span>
              <span className="tabular text-xs font-semibold text-muted-foreground">{formatCents(monthOut)}</span>
            </div>
            <ul className="flex flex-col gap-1.5">
              {monthItems.map((e) => {
                const Icon = KIND_ICON[e.kind] ?? CircleDollarSign
                const isOut = e.amountCents < 0
                return (
                  <li key={e.id} className="flex items-center gap-3">
                    <span className="flex w-12 shrink-0 flex-col items-center">
                      <span className="text-sm font-semibold leading-none">{Number(e.dueDate.slice(8, 10))}</span>
                    </span>
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm">{e.label}</span>
                        <span
                          className={cn(
                            'tabular shrink-0 text-sm font-semibold',
                            isOut ? 'text-foreground' : 'text-positive',
                          )}
                        >
                          {formatCents(e.amountCents)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                          {KIND_LABEL[e.kind]}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">{SOURCE_LABEL[e.source]}</span>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
