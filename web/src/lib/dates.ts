const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const MONTHS_FR_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

/** '2026-08' -> 'août 2026' */
export function formatMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTHS_FR[m - 1]} ${y}`
}

/** '2026-08' -> 'août 26' */
export function formatMonthShort(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTHS_FR_SHORT[m - 1]} ${String(y).slice(2)}`
}

/** '2026-08-31' -> '31 août 2026' */
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS_FR[m - 1]} ${y}`
}

/** '2026-08-31' -> '31 août' */
export function formatDateShort(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS_FR_SHORT[m - 1]}`
}
