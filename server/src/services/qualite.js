// Boucle qualité des prévisions : sans archive des forecasts passés,
// la fiabilité des projections n'est pas mesurable - le prévu d'un mois est écrasé
// au fil des recalages et des imports. Deux briques :
//
//   1. ensureForecastSnapshot() : archive forecast.json une fois par mois calendaire
//      (archives/forecast-YYYY-MM.json dans le data dir). Appelée au boot et à chaque
//      mutation (onDataChanged) : idempotente, le premier passage du mois gagne.
//      Le snapshot du mois M = « ce qui était prévu au début de M ».
//
//   2. qualitePrevisions() : pour un mois CLOS, compare le prévu du snapshot de ce
//      mois-là au réalisé, catégorie par catégorie. Fallback sans archive (premiers
//      mois) : approx = null, on le dit plutôt que d'inventer.
//
// Le rapport existe aussi en texte brut (?format=text), prêt à être relayé tel quel par
// une notification ou un agent (Syntréso reste la seule source des chiffres).

import { copyFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { dataPath } from './store.js'
import { loadState, actualsByMonth, monthOf, addMonths, todayFor } from './projection.js'

function archiveDir() {
  return path.join(path.dirname(dataPath('forecast')), 'archives')
}
function archivePath(ym) {
  return path.join(archiveDir(), `forecast-${ym}.json`)
}

/** Archive forecast.json pour le mois calendaire courant si pas déjà fait. Fail-soft. */
export async function ensureForecastSnapshot() {
  try {
    const state = await loadState()
    const ym = monthOf(todayFor(state.company))
    const target = archivePath(ym)
    try {
      await readFile(target)
      return false // déjà archivé ce mois-ci
    } catch {
      /* absent : on archive */
    }
    await mkdir(archiveDir(), { recursive: true })
    await copyFile(dataPath('forecast'), target)
    return true
  } catch (err) {
    console.warn('[qualite] snapshot forecast impossible :', err.message)
    return false
  }
}

/**
 * Prévu (snapshot du mois) vs réalisé pour un mois CLOS. Par défaut : le dernier mois
 * clos. Retourne { month, hasArchive, items: [{ categoryId, label, direction,
 * plannedCents, actualCents, gapCents }] } trié par |écart| décroissant.
 */
export async function qualitePrevisions({ month } = {}) {
  const state = await loadState()
  const currentMonth = monthOf(todayFor(state.company))
  const ym = month || addMonths(currentMonth, -1)
  if (ym >= currentMonth) return { month: ym, error: 'mois non clos' }

  let archive = null
  try {
    archive = JSON.parse(await readFile(archivePath(ym), 'utf8'))
  } catch {
    /* pas d'archive pour ce mois (boucle démarrée après) */
  }

  const actuals = actualsByMonth(state.transactions)[ym] || {}
  const planned = {}
  if (archive) {
    for (const f of archive) {
      if (f.month === ym) planned[f.categoryId] = (planned[f.categoryId] || 0) + f.amountCents
    }
  }

  const items = []
  for (const cat of state.categories) {
    const p = planned[cat.id] || 0
    const a = actuals[cat.id] || 0
    if (!p && !a) continue
    items.push({
      categoryId: cat.id,
      label: cat.label,
      direction: cat.direction,
      plannedCents: p,
      actualCents: a,
      gapCents: a - p,
    })
  }
  items.sort((x, y) => Math.abs(y.gapCents) - Math.abs(x.gapCents))
  return { month: ym, hasArchive: Boolean(archive), items }
}

/** Bloc texte prêt à relayer (notification, message d'agent). */
export async function qualitePrevisionsText({ month } = {}) {
  const r = await qualitePrevisions({ month })
  if (r.error) return ''
  const eur = (c) => `${Math.round(c / 100).toLocaleString('fr-FR')} EUR`
  const lines = [`Prévu vs réalisé - ${r.month} :`]
  if (!r.hasArchive) {
    lines.push('(pas encore d\'archive du prévisionnel pour ce mois : la comparaison démarrera au prochain mois clos)')
    return lines.join('\n')
  }
  const top = r.items.filter((i) => Math.abs(i.gapCents) >= 5_000).slice(0, 5)
  if (!top.length) {
    lines.push('Aucun écart notable (toutes les catégories à moins de 50 EUR du prévu).')
    return lines.join('\n')
  }
  for (const i of top) {
    lines.push(`- ${i.label} : prévu ${eur(i.plannedCents)}, réalisé ${eur(i.actualCents)} (écart ${eur(i.gapCents)})`)
  }
  return lines.join('\n')
}
