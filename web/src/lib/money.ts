const fmt = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
})

const fmtExact = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
})

/** Formate un montant en centimes entiers vers un libellé EUR arrondi (démo : pas de décimales). */
export function formatCents(cents: number): string {
  return fmt.format(Math.round(cents / 100))
}

/** Formate avec centimes (lignes de transactions). */
export function formatCentsExact(cents: number): string {
  return fmtExact.format(cents / 100)
}

/** Formate en k EUR compact pour les axes de graphiques. */
export function formatCentsCompact(cents: number): string {
  const eur = cents / 100
  if (Math.abs(eur) >= 1000) return `${Math.round(eur / 1000)} k€`
  return `${Math.round(eur)} €`
}

const fmtPlain = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

/** Nombre seul sans symbole (cellules de grille), arrondi à l'euro. */
export function formatCentsPlain(cents: number): string {
  return fmtPlain.format(Math.round(Math.abs(cents) / 100))
}

/** Conversion euros saisis -> centimes entiers (parade IEEE754 : 128,02 x 100 = 12802.000…02). */
export function eurosToCents(euros: number): number {
  return Math.round(euros * 100)
}

const fmtMonths = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

/**
 * Formate un runway (mois de réserve) renvoyé par le moteur. `null` = pas de descente
 * sous le seuil détectée sur l'horizon (on n'invente pas un infini).
 */
export function formatMonths(months: number | null): string {
  if (months === null) return 'au-delà de l’horizon'
  if (months >= 24) return '24 mois et plus'
  return `${fmtMonths.format(months)} ${months <= 1 ? 'mois' : 'mois'}`
}

/** Formate un écart de runway signé en mois (« +2,5 mois », « -1,2 mois »). */
export function formatMonthsDelta(deltaMonths: number): string {
  const sign = deltaMonths >= 0 ? '+' : '-'
  return `${sign}${fmtMonths.format(Math.abs(deltaMonths))} mois`
}
