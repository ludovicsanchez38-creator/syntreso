import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppState, useForecastGrid, sendJson, type ForecastGridResponse } from '@/lib/api'
import { eurosToCents } from '@/lib/money'
import { ForecastGrid } from '@/components/grid/ForecastGrid'
import { MonthGlance } from '@/components/charts/MonthGlance'

export default function ForecastPage() {
  const queryClient = useQueryClient()
  const state = useAppState()
  const grid = useForecastGrid()

  const editCell = useMutation({
    mutationFn: ({ month, categoryId, signedCents }: { month: string; categoryId: string; signedCents: number }) =>
      sendJson<ForecastGridResponse>('/api/forecast', 'PATCH', { month, categoryId, amountCents: signedCents }),
    onSuccess: (fresh) => {
      queryClient.setQueryData(['forecast'], fresh)
      queryClient.invalidateQueries({ queryKey: ['projection'] })
      queryClient.invalidateQueries({ queryKey: ['state'] })
    },
    onError: (err) => toast.error(err.message),
  })

  if (state.isLoading || grid.isLoading || !state.data || !grid.data) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6">
      <header>
        <h1 className="font-heading text-xl font-semibold tracking-tight">Prévisionnel</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Montants mensuels par catégorie, en euros TTC, comme sur le compte (la page Rentabilité les passe en HT). Chiffres pleins : réalisé (banque). Chiffres atténués : prévision,
          cliquez pour modifier. Le solde de pied et la courbe du tableau de bord se recalculent immédiatement.
        </p>
      </header>
      <ForecastGrid
        grid={grid.data}
        thresholdCents={state.data.company.lowCashThresholdCents}
        onCellEdit={(month, categoryId, direction, absEuros) => {
          const cents = eurosToCents(absEuros)
          editCell.mutate({ month, categoryId, signedCents: direction === 'in' ? cents : -cents })
        }}
      />
      <p className="text-xs text-muted-foreground">
        Les mois passés ne sont pas modifiables : ils reflètent les opérations bancaires constatées. Le mois en cours
        combine réalisé à date et reste à venir.
      </p>
      <div className="max-w-3xl">
        <MonthGlance />
      </div>
    </div>
  )
}
