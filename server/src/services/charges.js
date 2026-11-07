// Charge mensuelle robuste par catégorie de sortie - SOURCE UNIQUE partagée par le
// point mort (fiscal.js), le recalage du prévisionnel (recalage.js) et le prévisionnel
// de base posé par l'import Indy (import-indy.js).
//
// Méthode (une moyenne plate sur toute la période projette un pic ponctuel comme une
// charge récurrente et dilue les charges qui ne tombent pas tous les mois) :
//   - fenêtre glissante : les N derniers mois CLOS (mois courant exclu) ;
//   - médiane des occurrences (robuste aux pics), PAS la moyenne ;
//   - mensualisation par la fréquence de présence : une charge de 300 EUR payée
//     2 mois sur 6 pèse 100 EUR/mois, pas 300 (l'ancien point mort comptait le
//     montant plein -> surestimation des charges trimestrielles).

import { addMonths } from './dates.js'

/** Médiane entière d'un tableau non vide. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * Analyse les sorties réalisées par catégorie sur les `lookbackMonths` derniers mois
 * clos. Retourne { [catId]: { medianCents, presence, lookbackMonths, monthlyCents } },
 * montants en valeur ABSOLUE (positifs) :
 *   - medianCents  : médiane des mois où la charge apparaît ;
 *   - presence     : nombre de mois (sur lookback) où elle apparaît ;
 *   - monthlyCents : charge mensuelle équivalente = médiane x présence / lookback.
 */
export function robustMonthlyOut(state, actuals, currentMonth, { lookbackMonths = 6 } = {}) {
  const outCats = state.categories.filter((c) => c.direction === 'out')
  const months = []
  for (let i = 1; i <= lookbackMonths; i++) months.push(addMonths(currentMonth, -i))
  const out = {}
  for (const cat of outCats) {
    const vals = []
    for (const ym of months) {
      const v = actuals[ym]?.[cat.id]
      if (v) vals.push(Math.abs(v))
    }
    if (!vals.length) continue
    const med = median(vals)
    out[cat.id] = {
      medianCents: med,
      presence: vals.length,
      lookbackMonths,
      monthlyCents: Math.round((med * vals.length) / lookbackMonths),
    }
  }
  return out
}

/**
 * Catégories de sortie éligibles au RECALAGE automatique du prévisionnel : on écarte
 * ce qui est dérivé ou piloté par le moteur (TVA toujours ; URSSAF et rémunération
 * quand autoCompute pilote la provision/les paliers) et les opérations hors résultat
 * (investissements, apports : ponctuelles par nature, jamais « récurrentes »).
 */
export function recalableOutCategories(state) {
  const tnsAuto = state.company.fiscal?.tns?.autoCompute === true
  const remCatId = state.company.fiscal?.tns?.remunerationCategoryId
  const provCatId = state.company.fiscal?.tns?.provisionCategoryId
  return state.categories.filter((c) => {
    if (c.direction !== 'out') return false
    if (c.id === 'dec_tva') return false
    if (c.excludeFromResultat) return false
    if (tnsAuto && (c.id === remCatId || c.id === provCatId)) return false
    return true
  })
}
