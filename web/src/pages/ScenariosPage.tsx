import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { MoveRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppState, useProjection, useScenarios, sendJson, type Scenario } from '@/lib/api'
import { formatCents } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'
import { cn } from '@/lib/utils'
import { BalanceChart } from '@/components/charts/BalanceChart'
import { LeverCard } from '@/components/scenarios/LeverCard'
import { ScenarioImpact } from '@/components/scenarios/ScenarioImpact'

// Mêmes paliers d'horizon que le tableau de bord (cohérence). Défaut 12 mois sur les
// scénarios : un levier (embauche, prêt, achat) se juge sur l'année, pas sur 3 mois.
const RANGES = [
  { value: '1M', label: '1 M' },
  { value: '3M', label: '3 M' },
  { value: '6M', label: '6 M' },
  { value: '12M', label: '12 M' },
]

export default function ScenariosPage() {
  const queryClient = useQueryClient()
  const [range, setRange] = useState('12M')
  const state = useAppState()
  const scenarios = useScenarios()
  const activeIds = (scenarios.data ?? []).filter((s) => s.active).map((s) => s.id)
  const projection = useProjection(range, activeIds)
  // un timer PAR scénario : un seul timer partagé ferait perdre le PUT du scénario A
  // quand on touche un curseur du scénario B dans la fenêtre de debounce
  const debounceRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const updateScenario = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Pick<Scenario, 'active' | 'params'>> }) =>
      sendJson<Scenario>(`/api/scenarios/${id}`, 'PUT', body),
    onSuccess: (fresh) => {
      queryClient.setQueryData<Scenario[]>(['scenarios'], (prev) =>
        (prev ?? []).map((s) => (s.id === fresh.id ? fresh : s)),
      )
      queryClient.invalidateQueries({ queryKey: ['projection'] })
    },
  })

  // mise à jour optimiste locale + PUT débouncé (les curseurs émettent en rafale)
  const onParamChange = (id: string, key: string, value: string | number) => {
    queryClient.setQueryData<Scenario[]>(['scenarios'], (prev) =>
      (prev ?? []).map((s) => (s.id === id ? { ...s, params: { ...s.params, [key]: value } } : s)),
    )
    const existing = debounceRef.current.get(id)
    if (existing) clearTimeout(existing)
    debounceRef.current.set(
      id,
      setTimeout(() => {
        debounceRef.current.delete(id)
        const sc = queryClient.getQueryData<Scenario[]>(['scenarios'])?.find((s) => s.id === id)
        if (sc) updateScenario.mutate({ id, body: { params: sc.params } })
      }, 180),
    )
  }

  if (state.isLoading || scenarios.isLoading || !state.data || !scenarios.data) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  const proj = projection.data
  const baseLow = proj?.lowPoint
  const scenarioLow = proj?.scenario?.lowPoint

  return (
    <div className="flex flex-col gap-5 p-6">
      <header>
        <h1 className="font-heading text-xl font-semibold tracking-tight">Scénarios</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Activez un ou plusieurs leviers et déplacez les curseurs : la courbe compare la trajectoire actuelle
          (bleu) et le scénario (ambre). Rien n'est écrit dans le prévisionnel.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="flex flex-col gap-4">
          {scenarios.data.map((sc) => (
            <LeverCard
              key={sc.id}
              scenario={sc}
              onToggle={(active) => updateScenario.mutate({ id: sc.id, body: { active } })}
              onParamChange={(key, value) => onParamChange(sc.id, key, value)}
            />
          ))}
        </div>

        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle>Trajectoire comparée</CardTitle>
              {baseLow && scenarioLow && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Point bas :</span>
                  <span className="tabular font-semibold">{formatCents(baseLow.cents)}</span>
                  <MoveRight className="size-3.5 text-muted-foreground" />
                  <span
                    className={cn(
                      'tabular font-semibold',
                      scenarioLow.cents < baseLow.cents ? 'text-destructive' : 'text-positive',
                    )}
                  >
                    {formatCents(scenarioLow.cents)}
                  </span>
                  <span className="text-muted-foreground">le {formatDateShort(scenarioLow.date)}</span>
                </div>
              )}
            </div>
            <Tabs value={range} onValueChange={setRange} className="shrink-0">
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
            {proj ? (
              <BalanceChart
                series={proj.series}
                scenarioSeries={proj.scenario?.series}
                today={proj.today}
                thresholdCents={state.data.company.lowCashThresholdCents}
                lowPoint={proj.scenario ? proj.scenario.lowPoint : proj.lowPoint}
                height={380}
              />
            ) : (
              <Skeleton className="h-[380px]" />
            )}
            {!activeIds.length && (
              <p className="mt-3 text-center text-xs text-muted-foreground">
                Aucun levier actif : la courbe ambre apparaîtra dès qu'un scénario est activé.
              </p>
            )}
            {proj?.scenario && (
              <div className="mt-4">
                <ScenarioImpact
                  projection={proj}
                  thresholdCents={state.data.company.lowCashThresholdCents}
                  activeScenarios={scenarios.data.filter((s) => s.active)}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
