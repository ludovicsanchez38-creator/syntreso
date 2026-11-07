import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { HandCoins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { checkCcaRepayment, type Kpis } from '@/lib/api'
import { eurosToCents, formatCents } from '@/lib/money'
import { formatDate, formatMonth } from '@/lib/dates'
import { VerdictResult } from './RemunerationCheck'

/**
 * Compte courant d'associé : ce que la société doit au gérant, et le feu vert
 * « puis-je me rembourser X ? » (moteur : sans cotisations, plafonné par le CCA).
 */
export function CcaCheck({ cca }: { cca: NonNullable<Kpis['cca']> }) {
  const [euros, setEuros] = useState('')
  const [error, setError] = useState<string | null>(null)
  const check = useMutation({ mutationFn: (cents: number) => checkCcaRepayment(cents) })

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
      <div>
        <div className="tabular text-3xl font-semibold tracking-tight">{formatCents(cca.accruedCents)}</div>
        <p className="mt-1 text-xs text-muted-foreground">
          {cca.source === 'indy'
            ? `Solde réel de la compta${cca.asOfDate ? ` au ${formatDate(cca.asOfDate)}` : ''} : frais et IK avancés non encore remboursés.`
            : `Rémunération attribuée non versée depuis ${cca.sinceMonth}.`}
        </p>
      </div>
      {cca.untilMonth && cca.projectedEndCents !== cca.accruedCents && (
        <div className="flex items-baseline justify-between gap-2 border-t pt-3 text-xs">
          <span>Fin {formatMonth(cca.untilMonth)}, avec la rémunération non versée</span>
          <span className="tabular font-semibold">{formatCents(cca.projectedEndCents)}</span>
        </div>
      )}
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="cca-amount" className="text-xs font-medium text-muted-foreground">
            Montant à me rembourser (EUR)
          </label>
          <Input
            id="cca-amount"
            value={euros}
            onChange={(e) => setEuros(e.target.value)}
            placeholder={String(Math.round(cca.accruedCents / 100))}
            inputMode="numeric"
            className="tabular mt-1"
          />
        </div>
        <Button type="submit" disabled={check.isPending}>
          <HandCoins className="size-3.5" />
          {check.isPending ? 'Analyse…' : 'Puis-je me rembourser ?'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Un remboursement de CCA sort sans cotisations ni impôt.</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {check.isError && <p className="text-xs text-destructive">{check.error.message}</p>}
      {check.data?.exceedsCap && (
        <p className="text-xs text-destructive">Le montant dépasse ce que la société vous doit aujourd'hui.</p>
      )}
      {check.data && <VerdictResult data={check.data} costLabel="Montant remboursé" />}
    </form>
  )
}
