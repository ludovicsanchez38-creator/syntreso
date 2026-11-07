// Phrase de tête du tableau de bord : ce qui compte sur les 90 prochains jours.
// Fonction pure (aucun calcul de solde : tout vient des indicateurs du serveur), testée
// par web/test/bandeau.test.ts.
//
// Ordre de priorité : trésorerie projetée sous zéro, puis point bas sous le seuil, puis
// disponible net sous le seuil. « Pas de creux en vue » n'est écrit que si aucun des
// trois n'est vrai : un point bas confortable ne doit pas masquer un disponible net déjà
// sous le seuil une fois la TVA et les cotisations dues retranchées.
import type { Kpis } from './api.ts'
import { formatCents } from './money.ts'
import { formatDateShort } from './dates.ts'

export type Tone = 'positive' | 'warning' | 'destructive'

export type IndicateursBandeau = Pick<Kpis, 'lowCashThresholdCents' | 'lowPoint90' | 'netAvailableCents' | 'committedCents'>

// Termine une phrase sans doubler le point d'une date abrégée (« 4 oct. »).
export const dot = (s: string) => (s.endsWith('.') ? s : `${s}.`)

export function bandeauTresorerie(kpis: IndicateursBandeau): { tone: Tone; headline: string } {
  const threshold = kpis.lowCashThresholdCents
  const low = kpis.lowPoint90
  if (low && low.cents < 0) {
    return {
      tone: 'destructive',
      headline: dot(`La trésorerie projetée passe sous zéro dans les 90 jours : ${formatCents(low.cents)} le ${formatDateShort(low.date)}`),
    }
  }
  if (low && low.cents < threshold) {
    return {
      tone: 'warning',
      headline: dot(`Point bas sous le seuil de sécurité dans les 90 jours : ${formatCents(low.cents)} le ${formatDateShort(low.date)}`),
    }
  }
  const net = kpis.netAvailableCents
  if (typeof net === 'number' && net < threshold) {
    const apres = kpis.committedCents > 0 ? ', une fois la TVA et les cotisations dues retranchées' : ''
    return {
      tone: net < 0 ? 'destructive' : 'warning',
      headline: `Disponible net sous le seuil de sécurité : ${formatCents(net)}${apres}, pour un seuil de ${formatCents(threshold)}.`,
    }
  }
  return { tone: 'positive', headline: 'Pas de creux en vue sur 90 jours, selon le prévisionnel.' }
}
