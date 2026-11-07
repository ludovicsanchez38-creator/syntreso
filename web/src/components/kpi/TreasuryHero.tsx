import { CircleAlert, CircleCheck, CircleX } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useCashCalendar, type Company, type Echeance, type Kpis } from '@/lib/api'
import { formatCents } from '@/lib/money'
import { formatDate, formatDateShort, formatMonth } from '@/lib/dates'
import { bandeauTresorerie, dot, type Tone } from '@/lib/bandeau'
import { cn } from '@/lib/utils'

const TONE_ICON: Record<Tone, typeof CircleCheck> = { positive: CircleCheck, warning: CircleAlert, destructive: CircleX }

// Ce qui est déjà mis de côté pour une échéance donnée (sous-compte dédié).
function heldFor(e: Echeance, company: Company): number {
  const ph = company.provisionsHeld || {}
  if (e.kind === 'urssaf') return ph.urssafCents || 0
  if (e.kind === 'tva') return ph.tvaCents || 0
  return 0
}

function echeanceLabel(e: Echeance): string {
  if (e.kind === 'urssaf') return `les cotisations URSSAF (${e.label})`
  if (e.kind === 'tva') return 'la TVA'
  return e.label
}

// Jauge « mis de côté / dû » d'une provision. Rien si rien n'est dû.
function ProvisionGauge({ label, held, due }: { label: string; held: number; due: number }) {
  if (due <= 0) return null
  const covered = held >= due
  return (
    <div className="mt-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span>{label}</span>
        <span className={cn('tabular font-medium', covered ? 'text-positive' : 'text-warning')}>
          {formatCents(held)} pour {formatCents(due)} dus
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', covered ? 'bg-positive' : 'bg-warning')}
          style={{ width: `${Math.min(100, Math.round((held / due) * 100))}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Bandeau de tête du tableau de bord (remplace RunwayHero) :
 * une phrase factuelle sur les 90 prochains jours, puis trois chiffres lus comme sur un
 * relevé (compte courant, mis de côté, trésorerie projetée fin d'année). Aucun calcul
 * de solde ici : tout vient du serveur (kpis, échéancier).
 */
export function TreasuryHero({ kpis, company }: { kpis: Kpis; company: Company }) {
  const cal = useCashCalendar(90)
  const threshold = kpis.lowCashThresholdCents
  const low = kpis.lowPoint90
  // point bas, puis disponible net : « Pas de creux en vue » seulement si les deux tiennent
  const { tone, headline } = bandeauTresorerie(kpis)
  const Icon = TONE_ICON[tone]

  const next = cal.data?.items.find((e) => e.amountCents < 0)
  let nextSentence = ''
  if (next) {
    const amount = -next.amountCents
    const held = Math.min(heldFor(next, company), amount)
    const reste = amount - held
    nextSentence = `La prochaine échéance, ce sont ${echeanceLabel(next)} : ${formatCents(amount)} le ${formatDateShort(next.dueDate)}`
    if (held > 0) nextSentence += `, dont ${formatCents(held)} déjà de côté`
    nextSentence = dot(nextSentence)
    if (held > 0 && reste > 0) nextSentence += ` Il reste ${formatCents(reste)} à mettre de côté d'ici là.`
  }

  const ph = company.provisionsHeld || {}
  const nextUrssaf = cal.data?.items.find((e) => e.kind === 'urssaf' && e.amountCents < 0)
  const hasCurrent = kpis.currentAccountCents !== null && kpis.currentAccountCents !== undefined

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-2.5 border-b pb-4 text-[15px] leading-relaxed">
          <Icon
            className={cn(
              'mt-0.5 size-5 shrink-0',
              tone === 'positive' ? 'text-positive' : tone === 'warning' ? 'text-warning' : 'text-destructive',
            )}
          />
          <p>
            <span className="font-semibold">{headline}</span> {nextSentence}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          <div>
            <div className="text-xs text-muted-foreground">{hasCurrent ? 'Sur le compte courant' : 'Disponible net'}</div>
            <div className="tabular mt-1 text-2xl font-semibold tracking-tight md:text-[28px]">
              {formatCents(hasCurrent ? kpis.currentAccountCents! : kpis.netAvailableCents)}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {hasCurrent ? 'Hors sous-comptes de provision, comme sur votre relevé. ' : 'Après TVA et cotisations dues. '}
              Seuil de sécurité : {formatCents(threshold)}.
            </p>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Mis de côté</div>
            <div className="tabular mt-1 text-2xl font-semibold tracking-tight md:text-[28px]">
              {formatCents(kpis.provisionsHeldCents ?? 0)}
            </div>
            <ProvisionGauge
              label={kpis.tvaDueDate ? `TVA (due le ${formatDate(kpis.tvaDueDate)})` : 'TVA'}
              held={ph.tvaCents || 0}
              due={kpis.tvaAReverserCents}
            />
            <ProvisionGauge
              label={nextUrssaf ? `URSSAF (${nextUrssaf.label}, ${formatDateShort(nextUrssaf.dueDate)})` : 'URSSAF'}
              held={ph.urssafCents || 0}
              due={kpis.socialProvisionCents}
            />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              Trésorerie totale fin {kpis.yearEndProjected ? formatMonth(kpis.yearEndProjected.month) : 'd’année'}
            </div>
            <div className="tabular mt-1 text-2xl font-semibold tracking-tight md:text-[28px]">
              {kpis.yearEndProjected ? formatCents(kpis.yearEndProjected.cents) : '-'}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Compte et sous-comptes, avec le pipe et le prévisionnel.
              {low ? ` ${dot(`Point bas sur 90 jours : ${formatCents(low.cents)} le ${formatDateShort(low.date)}`)}` : ''}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
