// Helpers de date purs (sans dépendance). Extraits de projection.js pour casser le
// cycle d'import projection.js <-> horizon.js : horizon.js a besoin de addMonths,
// projection.js a besoin de HORIZON_MONTHS de horizon.js. Les helpers vivent ici,
// importés par les deux.
//
// Convention : les dates sont des chaînes ISO ('YYYY-MM-DD'), les mois 'YYYY-MM'.
// Comparées lexicographiquement. Aucun fuseau local : tout en UTC.

/** Mois ('YYYY-MM') d'une date ('YYYY-MM-DD'). */
export function monthOf(date) {
  return date.slice(0, 7)
}

/** Nombre de jours du mois 'YYYY-MM'. */
export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Dernier jour du mois 'YYYY-MM' au format 'YYYY-MM-DD'. */
export function endOfMonth(ym) {
  return `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`
}

/** Décale un mois 'YYYY-MM' de n mois (n peut être négatif). */
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

/** Liste inclusive des mois de fromYm à toYm. Bornée (jamais de boucle infinie). */
export function monthRange(fromYm, toYm) {
  const out = []
  let cur = fromYm
  while (cur <= toYm) {
    out.push(cur)
    cur = addMonths(cur, 1)
  }
  return out
}

/** Décale une date 'YYYY-MM-DD' de n jours (n peut être négatif). */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

/** Date du jour réelle 'YYYY-MM-DD' (UTC). */
export function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * « Aujourd'hui » du moteur : demoToday si présent (démo à date figée,
 * reproductible), sinon la date réelle. Les données réelles importées ne posent
 * PAS demoToday : le moteur raisonne à la vraie date du jour, même si le dernier
 * import date d'il y a 15 jours - c'est dataFreshness qui signale le retard,
 * pas le calendrier qui s'arrête à la dernière transaction.
 */
export function todayFor(company) {
  return company?.demoToday || todayISO()
}
