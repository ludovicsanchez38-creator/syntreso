import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Scale, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { compareRemunerationDividendes, type RemDivComparison } from '@/lib/api'
import { formatCents, eurosToCents } from '@/lib/money'

// Ligne de détail d'une voie (libellé / montant), avec une nuance optionnelle.
function Row({ label, cents, strong = false, sub = false }: { label: string; cents: number; strong?: boolean; sub?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-2', sub && 'pl-3')}>
      <dt className={cn('text-muted-foreground', sub && 'text-[11px]')}>{label}</dt>
      <dd className={cn('tabular', strong ? 'font-semibold' : 'font-medium', sub && 'text-[11px]')}>{formatCents(cents)}</dd>
    </div>
  )
}

function ComparisonResult({ data }: { data: RemDivComparison }) {
  const rem = data.remuneration
  const div = data.dividendes
  // La voie avantageuse en net : on compare le net dividendes au net rému AVANT IR (le
  // delta est calculé serveur). On reste prudent : le delta favorise la rému (IR non
  // modélisé), donc on l'annonce comme indicatif.
  const divPlusAvantageux = data.deltaNetDividendesMoinsRemAvantIRCents > 0
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="text-sm font-semibold text-primary">Rémunération</div>
          <dl className="mt-2 flex flex-col gap-1 text-xs">
            <Row label="Brut versé" cents={rem.brutCents} />
            <Row label={`Cotisations TNS (${rem.cotisationRatePct} %)`} cents={rem.cotisationsCents} />
            <Row label="Net en poche (avant IR)" cents={rem.netAvantIRCents} strong />
          </dl>
        </div>
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
          <div className="text-sm font-semibold text-warning">Dividendes</div>
          <dl className="mt-2 flex flex-col gap-1 text-xs">
            <Row label={`IS (${div.isRatePct} %)`} cents={div.isCents} />
            <Row label="Dividende distribuable" cents={div.dividendeBrutCents} />
            {div.prelevementsSociauxCents > 0 && (
              <Row label={`Prélèv. sociaux (${div.prelevementsSociauxPct} %)`} cents={div.prelevementsSociauxCents} sub />
            )}
            {div.cotisationsTnsCents > 0 && (
              <Row label={`Cotisations TNS (${div.cotisationsTnsPct} %)`} cents={div.cotisationsTnsCents} sub />
            )}
            <Row label={`IR forfaitaire (${div.irPct} %)`} cents={div.irCents} sub />
            <Row label="Net en poche" cents={div.netCents} strong />
          </dl>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Pour {formatCents(data.grossCostCents)} sortis de la société (capital social {formatCents(data.capitalSocialCents)},
        seuil de 10 % = {formatCents(data.seuil10Cents)}), la voie{' '}
        <span className={cn('font-semibold', divPlusAvantageux ? 'text-warning' : 'text-primary')}>
          {divPlusAvantageux ? 'dividendes' : 'rémunération'}
        </span>{' '}
        ressort la plus avantageuse en net (indicatif).
      </p>
      <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-2.5">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <ul className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          {data.avertissements.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * Comparateur « rémunération vs dividendes » (SARL-U à l'IS, gérant majoritaire TNS).
 * L'utilisateur saisit une enveloppe de coût entreprise (« combien je sors de la
 * société ») ; le moteur chiffre le net en poche par chaque voie. Le calcul fiscal vit
 * serveur (fiscal.js), le front n'affiche que. Fonction surtout pertinente pour un gérant majoritaire TNS.
 */
export function RemDivComparator() {
  const [euros, setEuros] = useState('')
  const [error, setError] = useState<string | null>(null)

  const compare = useMutation({
    mutationFn: (montantCents: number) => compareRemunerationDividendes(montantCents),
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const value = Number(euros.replace(/\s/g, '').replace(',', '.'))
    if (Number.isNaN(value) || value <= 0) {
      setError('Saisissez un montant positif en euros.')
      return
    }
    setError(null)
    compare.mutate(eurosToCents(value))
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Pour une enveloppe sortie de la société, comparez le net dans votre poche en rémunération (déductible,
        cotisations TNS) ou en dividendes (après IS, flat tax, cotisations au-delà de 10 % du capital).
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor="remdiv-amount" className="text-xs font-medium text-muted-foreground">
            Enveloppe sortie société (EUR)
          </label>
          <Input
            id="remdiv-amount"
            value={euros}
            onChange={(e) => setEuros(e.target.value)}
            placeholder="10 000"
            inputMode="numeric"
            className="tabular mt-1"
          />
        </div>
        <Button type="submit" disabled={compare.isPending}>
          <Scale className="size-3.5" />
          {compare.isPending ? 'Calcul…' : 'Comparer'}
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {compare.isError && <p className="text-xs text-destructive">{compare.error.message}</p>}
      {compare.data && <ComparisonResult data={compare.data} />}
    </form>
  )
}
