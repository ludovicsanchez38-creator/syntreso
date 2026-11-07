import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CircleCheck, CircleAlert, CircleX, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { checkRemuneration, type RemunerationCheckResponse } from '@/lib/api'
import { formatCents, formatMonths, eurosToCents } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'

type Verdict = RemunerationCheckResponse['verdict']

// Habillage du verdict (le verdict est calculé SERVEUR, on ne fait qu'afficher).
const VERDICT_STYLE: Record<Verdict, { wrap: string; accent: string; icon: typeof CircleCheck; label: string }> = {
  vert: { wrap: 'border-positive/30 bg-positive/5', accent: 'text-positive', icon: CircleCheck, label: 'Feu vert' },
  ambre: { wrap: 'border-warning/30 bg-warning/5', accent: 'text-warning', icon: CircleAlert, label: 'Prudence' },
  rouge: { wrap: 'border-destructive/30 bg-destructive/5', accent: 'text-destructive', icon: CircleX, label: 'Déconseillé' },
}

export function VerdictResult({ data, costLabel = 'Coût total (versement + cotisations)' }: { data: RemunerationCheckResponse; costLabel?: string }) {
  const style = VERDICT_STYLE[data.verdict]
  const Icon = style.icon
  return (
    <div className={cn('rounded-lg border p-3', style.wrap)}>
      <div className={cn('flex items-center gap-2 text-sm font-semibold', style.accent)}>
        <Icon className="size-4" />
        {style.label}
      </div>
      <dl className="mt-2 flex flex-col gap-1 text-xs">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">{costLabel}</dt>
          <dd className="tabular font-medium">{formatCents(data.totalCostCents)}</dd>
        </div>
        {data.couplingCents > 0 && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">dont cotisations TNS ({data.couplingRatePct} %)</dt>
            <dd className="tabular font-medium">{formatCents(data.couplingCents)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Point bas projeté</dt>
          <dd className={cn('tabular font-medium', data.lowPointNextCents < data.thresholdCents && 'text-destructive')}>
            {formatCents(data.lowPointNextCents)} le {formatDateShort(data.lowPointNextDate)}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Seuil de sécurité</dt>
          <dd className="tabular font-medium">{formatCents(data.thresholdCents)}</dd>
        </div>
        {data.runwayAfterMonths !== undefined && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Autonomie après</dt>
            <dd className="tabular font-medium">{formatMonths(data.runwayAfterMonths)}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}

/**
 * Widget « Puis-je me verser X ? ». L'utilisateur saisit un montant en euros, on
 * appelle l'endpoint feu vert (overlay éphémère, rien n'est écrit) et on affiche le
 * verdict Vert/Ambre/Rouge + sa justification chiffrée. Le verdict vient du moteur.
 */
export function RemunerationCheck() {
  const [euros, setEuros] = useState('')
  const [error, setError] = useState<string | null>(null)

  const check = useMutation({
    mutationFn: (montantCents: number) => checkRemuneration(montantCents),
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const value = Number(euros.replace(/\s/g, '').replace(',', '.'))
    if (Number.isNaN(value) || value <= 0) {
      setError('Saisissez un montant positif en euros.')
      return
    }
    setError(null)
    check.mutate(eurosToCents(value))
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Simulez un prélèvement gérant ce mois-ci. Rien n'est enregistré : le moteur projette l'impact sur votre
        trésorerie et rend un verdict.
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="rem-amount" className="text-xs font-medium text-muted-foreground">
            Montant à me verser (EUR)
          </label>
          <Input
            id="rem-amount"
            value={euros}
            onChange={(e) => setEuros(e.target.value)}
            placeholder="3 000"
            inputMode="numeric"
            className="tabular mt-1"
          />
        </div>
        <Button type="submit" disabled={check.isPending}>
          <Wallet className="size-3.5" />
          {check.isPending ? 'Analyse…' : 'Vérifier'}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {check.isError && <p className="text-xs text-destructive">{check.error.message}</p>}
      {check.data && <VerdictResult data={check.data} />}
    </form>
  )
}
