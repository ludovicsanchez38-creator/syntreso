import { useState } from 'react'
import { CalendarClock, FileText } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppState, useProjection } from '@/lib/api'
import { formatCents } from '@/lib/money'
import { formatDate } from '@/lib/dates'
import { TreasuryHero } from '@/components/kpi/TreasuryHero'
import { BalanceChart } from '@/components/charts/BalanceChart'
import { AlertsList } from '@/components/alerts/AlertsList'
import { RecentTransactions } from '@/components/transactions/RecentTransactions'
import { MonthlyComment } from '@/components/agent/MonthlyComment'
import { DataFreshnessBanner } from '@/components/DataFreshnessBanner'
import { CashCalendar } from '@/components/echeances/CashCalendar'

const RANGES = [
  { value: '1M', label: '1 M' },
  { value: '3M', label: '3 M' },
  { value: '6M', label: '6 M' },
  { value: '12M', label: '12 M' },
]

export default function DashboardPage() {
  const [range, setRange] = useState('6M')
  const state = useAppState()
  const projection = useProjection(range)

  if (state.isLoading || projection.isLoading || !state.data || !projection.data) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-80" />
      </div>
    )
  }

  const { company, kpis, alerts, dataFreshness } = state.data
  const proj = projection.data

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">Tableau de bord</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {company.name} - {company.location}
            {company.employees > 0 ? ` - ${company.employees} salarié${company.employees > 1 ? 's' : ''}` : ''}
          </p>
          <div className="mt-1.5">
            <DataFreshnessBanner freshness={dataFreshness} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <MonthlyComment />
          {/* Export dossier banquier : page HTML print-ready (PDF via Ctrl+P), nouvel onglet. */}
          <Button asChild variant="outline" size="sm">
            <a href="/api/export/dossier" target="_blank" rel="noopener noreferrer">
              <FileText className="size-3.5" />
              Dossier banquier
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">Situation au {formatDate(company.today)}</p>
        </div>
      </header>

      <TreasuryHero kpis={kpis} company={company} />

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Solde de trésorerie</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Trait plein : réalisé (banque). Pointillés : projeté (prévisionnel).</p>
          </div>
          <Tabs value={range} onValueChange={setRange}>
            <TabsList>
              {RANGES.map((r) => (
                <TabsTrigger key={r.value} value={r.value}>
                  {r.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          <BalanceChart
            series={proj.series}
            today={proj.today}
            thresholdCents={company.lowCashThresholdCents}
            lowPoint={kpis.lowPoint90 ?? undefined}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CalendarClock className="size-4 text-primary" />
              Ce qui sort dans les 90 jours
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Échéances datées certaines (TVA, cotisations, emprunts, impôts). Repère les mois chargés.
            </p>
          </CardHeader>
          <CardContent>
            <CashCalendar jours={90} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>À regarder</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Ce qui sort de l'ordinaire.</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <AlertsList alerts={alerts} />
            <div className="flex gap-8 border-t pt-3 text-xs text-muted-foreground">
              <div>
                Encaissé sur 30 jours
                <div className="tabular mt-0.5 text-lg font-semibold text-positive">+{formatCents(kpis.in30dCents)}</div>
              </div>
              <div>
                Décaissé sur 30 jours
                <div className="tabular mt-0.5 text-lg font-semibold text-foreground">{formatCents(kpis.out30dCents)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dernières opérations</CardTitle>
        </CardHeader>
        <CardContent>
          <RecentTransactions minAbsCents={100} />
        </CardContent>
      </Card>
    </div>
  )
}
