import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppState, useProjection } from '@/lib/api'
import { formatMonth } from '@/lib/dates'
import { WaterfallChart } from '@/components/charts/WaterfallChart'

// « Le mois en un coup d'œil » : cascade ouverture / entrées / sorties / clôture d'un
// mois, navigable. Affiché dans la page Prévisionnel.
export function MonthGlance() {
  const state = useAppState()
  const projection = useProjection('6M')
  const [offset, setOffset] = useState(0)

  if (!state.data || !projection.data) return <Skeleton className="h-72" />

  const monthly = projection.data.monthly
  const currentMonth = state.data.company.today.slice(0, 7)
  const idx = Math.max(0, Math.min(monthly.length - 1, monthly.findIndex((m) => m.month === currentMonth) + offset))
  const month = monthly[idx]

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>
          Le mois en un coup d'œil
          <span className="ml-2 font-normal text-muted-foreground">
            {formatMonth(month.month)}
            {month.projected ? ' (projeté)' : ''}
          </span>
        </CardTitle>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setOffset((o) => o - 1)} disabled={idx <= 0} aria-label="Mois précédent">
            <ChevronLeft className="size-4" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setOffset((o) => o + 1)} disabled={idx >= monthly.length - 1} aria-label="Mois suivant">
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <WaterfallChart month={month} />
      </CardContent>
    </Card>
  )
}
