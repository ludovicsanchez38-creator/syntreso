import { PiggyBank } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Company, Kpis } from '@/lib/api'
import { formatDate } from '@/lib/dates'
import { formatCents } from '@/lib/money'
import { cn } from '@/lib/utils'

// Une ligne de provision : ce qui est dû, ce qui est déjà mis de côté (sous-compte
// dédié), ce qu'il reste à provisionner. Empilé sur mobile, en ligne sur écran large.
function ProvisionRow({ label, due, held, reste }: { label: string; due: number; held: number; reste: number }) {
  return (
    <div className="flex flex-col gap-1 border-b py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm font-medium">{label}</div>
      <div className="tabular flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
        <span className="text-muted-foreground">
          dû <span className="font-semibold text-foreground">{formatCents(due)}</span>
        </span>
        <span className="text-muted-foreground">
          de côté <span className="font-semibold text-positive">{formatCents(held)}</span>
        </span>
        <span className={cn('font-semibold', reste > 0 ? 'text-warning' : 'text-positive')}>
          {reste > 0 ? `reste ${formatCents(reste)}` : 'couvert'}
        </span>
      </div>
    </div>
  )
}

/**
 * Suivi des provisions (TVA + cotisations) : dette réelle vs ce que le dirigeant a déjà
 * sécurisé sur ses sous-comptes dédiés, et le reste à mettre de côté. Masqué tant que
 * l'entreprise ne déclare pas de provisions (démo) -> rendu null.
 */
export function ProvisionsCard({ company, kpis, showCca = true }: { company: Company; kpis: Kpis; showCca?: boolean }) {
  const ph = company.provisionsHeld
  if (!ph) return null
  const tvaHeld = ph.tvaCents || 0
  const urssafHeld = ph.urssafCents || 0
  const perso = ph.persoCents || 0
  const tvaDue = kpis.vatDueCents
  const urssafDue = kpis.socialProvisionCents
  const tvaReste = Math.max(0, tvaDue - tvaHeld)
  const urssafReste = Math.max(0, urssafDue - urssafHeld)
  const totalReste = tvaReste + urssafReste

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PiggyBank className="size-4 text-primary" />
          Provisions (impôts &amp; cotisations)
        </CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Ce que vous devez, ce que vous avez déjà mis de côté sur vos sous-comptes, et ce qu'il reste à provisionner.
        </p>
      </CardHeader>
      <CardContent>
        <ProvisionRow label="TVA à reverser" due={tvaDue} held={tvaHeld} reste={tvaReste} />
        <ProvisionRow label="Cotisations URSSAF / TNS" due={urssafDue} held={urssafHeld} reste={urssafReste} />
        <div className="mt-3 flex items-center justify-between border-t pt-3">
          <span className="text-sm font-semibold">Reste à mettre de côté</span>
          <span className={cn('tabular text-lg font-semibold', totalReste > 0 ? 'text-warning' : 'text-positive')}>
            {totalReste > 0 ? formatCents(totalReste) : 'Tout est couvert'}
          </span>
        </div>
        {!showCca ? null : kpis.cca ? (
          <div className="mt-3 flex flex-col gap-1 border-t pt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Compte courant d'associé (dû au gérant)</span>
              <span className="tabular text-lg font-semibold">{formatCents(kpis.cca.accruedCents)}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {kpis.cca.source === 'indy' ? (
                <>Solde réel dans Indy{kpis.cca.asOfDate ? ` au ${formatDate(kpis.cca.asOfDate)}` : ''} (frais et IK avancés non encore remboursés).</>
              ) : (
                <>Rémunération attribuée non versée depuis {kpis.cca.sinceMonth}.</>
              )}{' '}
              {kpis.cca.projectedEndCents !== kpis.cca.accruedCents && kpis.cca.untilMonth && (
                <>
                  <span className="tabular font-medium text-foreground">{formatCents(kpis.cca.projectedEndCents)}</span> projetés à fin{' '}
                  {kpis.cca.untilMonth} avec la rémunération non versée.{' '}
                </>
              )}
              Un remboursement de CCA sort sans cotisations ni impôt (demander à l'assistant : « puis-je me rembourser X du CCA ? »).
            </p>
          </div>
        ) : (
          perso > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Compte courant d'associé : <span className="tabular font-medium text-foreground">{formatCents(perso)}</span> de rémunération mise en CCA, due par la société (hors disponible entreprise).
            </p>
          )
        )}
      </CardContent>
    </Card>
  )
}
