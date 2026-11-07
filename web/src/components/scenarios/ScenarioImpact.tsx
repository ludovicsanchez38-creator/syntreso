import { CircleCheck, TriangleAlert, Repeat, Coins } from 'lucide-react'
import type { ProjectionResponse, Scenario } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatCents, formatMonths, formatMonthsDelta } from '@/lib/money'
import { formatDateShort } from '@/lib/dates'

interface ScenarioImpactProps {
  projection: ProjectionResponse
  thresholdCents: number
  /** scénarios actifs, pour ventiler coût récurrent vs ponctuel. */
  activeScenarios: Scenario[]
}

// Extrait les coûts récurrents (mensuels) et ponctuels (one-shot) des params
// connus d'un scénario actif. Générique : on lit des clés de params standardisées,
// jamais une logique par ID. Inconnu = ignoré (pas d'invention).
function costsOf(sc: Scenario): { monthlyCents: number; oneOffCents: number } {
  const p = sc.params
  const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : 0)
  let monthlyCents = num('monthlyCostCents')
  let oneOffCents = num('oneOffCents')
  // achat : comptant = ponctuel, leasing = mensualisé (le moteur tranche déjà la
  // courbe ; ici on ne fait que qualifier le type de coût pour l'affichage).
  if (num('amountCents') > 0) {
    if (p.mode === 'leasing') monthlyCents += Math.round(num('amountCents') / 36)
    else oneOffCents += num('amountCents')
  }
  return { monthlyCents, oneOffCents }
}

/**
 * Verdict d'impact d'un scénario sur la trésorerie. Compare la trajectoire de base et
 * la trajectoire scénario (toutes deux produites par le moteur) :
 *  - delta de runway (mois de marge gagnés/perdus),
 *  - badge « reste au-dessus du seuil » (vert) / « passe sous le seuil le JJ/MM » (rouge),
 *  - coût mensuel récurrent vs coût ponctuel (dérivé des leviers actifs).
 * Aucun calcul de solde : le front lit base vs scénario.
 */
export function ScenarioImpact({ projection, thresholdCents, activeScenarios }: ScenarioImpactProps) {
  const sc = projection.scenario
  if (!sc) return null

  const baseRunway = projection.runwayMonths
  const scRunway = sc.runwayMonths
  // delta de runway en mois (gagné si scénario tient plus longtemps). null si une
  // des deux trajectoires ne descend jamais sous le seuil : on ne soustrait pas un null.
  const runwayDelta = baseRunway !== null && scRunway !== null ? scRunway - baseRunway : null

  const lowUnderThreshold = sc.lowPoint.cents < thresholdCents

  // Agrégat des coûts des leviers actifs.
  const costs = activeScenarios.reduce(
    (acc, s) => {
      const c = costsOf(s)
      acc.monthlyCents += c.monthlyCents
      acc.oneOffCents += c.oneOffCents
      return acc
    },
    { monthlyCents: 0, oneOffCents: 0 },
  )

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Verdict d'impact</div>

      {/* Badge seuil */}
      <div
        className={cn(
          'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm font-medium',
          lowUnderThreshold ? 'bg-destructive/10 text-destructive' : 'bg-positive/10 text-positive',
        )}
      >
        {lowUnderThreshold ? <TriangleAlert className="size-4" /> : <CircleCheck className="size-4" />}
        {lowUnderThreshold
          ? `Passe sous le seuil le ${formatDateShort(sc.lowPoint.date)}`
          : 'Reste au-dessus du seuil de sécurité'}
      </div>

      {/* Delta de marge (runway) */}
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">Marge d'autonomie</span>
        {runwayDelta === null ? (
          <span className="tabular font-medium">
            {formatMonths(baseRunway)} {'->'} {formatMonths(scRunway)}
          </span>
        ) : (
          <span
            className={cn('tabular font-semibold', runwayDelta >= 0 ? 'text-positive' : 'text-destructive')}
          >
            {formatMonthsDelta(runwayDelta)} de marge
          </span>
        )}
      </div>

      {/* Coût récurrent vs ponctuel */}
      {(costs.monthlyCents > 0 || costs.oneOffCents > 0) && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-2 text-xs">
          {costs.monthlyCents > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Repeat className="size-3.5" />
                Coût mensuel récurrent
              </span>
              <span className="tabular font-medium">{formatCents(costs.monthlyCents)} / mois</span>
            </div>
          )}
          {costs.oneOffCents > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Coins className="size-3.5" />
                Coût ponctuel
              </span>
              <span className="tabular font-medium">{formatCents(costs.oneOffCents)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
