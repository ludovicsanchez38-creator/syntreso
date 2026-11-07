import { Gauge, ShieldCheck, TriangleAlert, OctagonAlert } from 'lucide-react'
import type { Kpis } from '@/lib/api'
import { cn } from '@/lib/utils'
import { formatCents, formatMonths } from '@/lib/money'

// Seuils du verdict d'autonomie (runway) calibrés solo. Le runway lui-même vient du
// moteur (sur le NET) ; ici on ne fait que choisir la couleur et la phrase.
const RUNWAY_GREEN_MONTHS = 3
const RUNWAY_AMBER_MONTHS = 1.5

type Tone = 'green' | 'amber' | 'red'

// runway null = pas de descente sous le seuil détectée -> situation saine (vert).
function toneFor(runwayMonths: number | null): Tone {
  if (runwayMonths === null || runwayMonths >= RUNWAY_GREEN_MONTHS) return 'green'
  if (runwayMonths >= RUNWAY_AMBER_MONTHS) return 'amber'
  return 'red'
}

// Couleurs sobres (pas de dégradé) adossées aux tokens fonctionnels.
const TONE_STYLE: Record<Tone, { wrap: string; accent: string; icon: typeof Gauge }> = {
  green: { wrap: 'border-positive/30 bg-positive/5', accent: 'text-positive', icon: ShieldCheck },
  amber: { wrap: 'border-warning/30 bg-warning/5', accent: 'text-warning', icon: TriangleAlert },
  red: { wrap: 'border-destructive/30 bg-destructive/5', accent: 'text-destructive', icon: OctagonAlert },
}

/**
 * Compose la phrase-verdict en langage humain à partir des chiffres du moteur.
 * Aucun calcul de solde ici : on reformule netAvailableCents / runwayMonths.
 */
function verdictSentence(runwayMonths: number | null, tone: Tone): string {
  if (runwayMonths === null) {
    return "Aucune descente sous le seuil de sécurité détectée sur l'horizon. La trésorerie tient."
  }
  const m = formatMonths(runwayMonths)
  if (tone === 'green') return `Vous tenez ${m} au rythme actuel. Marge confortable.`
  if (tone === 'amber') return `Vous tenez ${m} au rythme actuel. À surveiller, la marge se resserre.`
  return `Vous ne tenez que ${m} au rythme actuel. Réagissez vite.`
}

/**
 * HERO RUNWAY : bande pleine largeur en tête du dashboard. Met l'autonomie (mois de
 * réserve sur le NET) au premier plan, avec une phrase-verdict, puis le solde brut et
 * le NET disponible (« dont X à reverser »). Le solde brut n'est plus le héros.
 */
export function RunwayHero({ kpis }: { kpis: Kpis }) {
  const tone = toneFor(kpis.runwayMonths)
  const style = TONE_STYLE[tone]
  const Icon = style.icon
  const committed = kpis.committedCents
  const hasCommitted = committed > 0

  return (
    <section className={cn('flex flex-col gap-4 rounded-xl border p-5 lg:flex-row lg:flex-wrap lg:items-center lg:gap-6', style.wrap)}>
      {/* Bloc autonomie (runway) */}
      <div className="flex shrink-0 items-center gap-4">
        <span className={cn('flex size-12 shrink-0 items-center justify-center rounded-lg bg-background/60', style.accent)}>
          <Icon className="size-6" />
        </span>
        <div>
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Gauge className="size-3.5" />
            Autonomie de trésorerie
          </div>
          <div className={cn('tabular mt-0.5 text-3xl font-semibold tracking-tight', style.accent)}>
            {formatMonths(kpis.runwayMonths)}
          </div>
        </div>
      </div>

      {/* Phrase-verdict humaine */}
      <p className={cn('min-w-0 flex-1 text-sm font-medium leading-relaxed lg:text-base', style.accent)}>
        {verdictSentence(kpis.runwayMonths, tone)}
      </p>

      {/* Solde brut + NET disponible, rétrogradés en seconde ligne */}
      <div className="flex shrink-0 gap-6 lg:border-l lg:border-border/60 lg:pl-6">
        <div>
          <div className="text-xs font-medium text-muted-foreground">Solde actuel</div>
          <div className="tabular mt-0.5 text-lg font-semibold tracking-tight">{formatCents(kpis.balanceTodayCents)}</div>
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">Disponible net</div>
          <div className="tabular mt-0.5 text-lg font-semibold tracking-tight">{formatCents(kpis.netAvailableCents)}</div>
          {hasCommitted && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              dont {formatCents(committed)} à reverser : TVA + cotisations
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
