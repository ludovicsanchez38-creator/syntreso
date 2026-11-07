// Branchement Syntréso <- Twenty (CRM) via PROPOSITION.
//
// Problème résolu : passer une opportunité en WON dans Twenty ne bouge pas le
// prévisionnel de Syntréso tant qu'on ne relance pas l'import à la main. Ce service lit
// le pipe Twenty EN DIRECT (API REST, lecture seule), recalcule la contribution
// pondérée du pipe au prévisionnel d'encaissements, et — pour chaque écart vs ce qui
// est déjà au prévisionnel, ÉMET UNE PROPOSITION (mécanisme proposals existant, validée
// d'un clic par le dirigeant). Syntréso n'écrit JAMAIS en autonomie depuis une note CRM.
//
// Garde-fous :
//   - Twenty = source côté commercial (pipe), Indy = source côté banque (réalisé).
//     Ce service ne touche QUE le prévisionnel d'encaissement (catégorie des réglages), jamais
//     le réalisé bancaire.
//   - Pas d'écriture directe : on crée des propositions `forecast_line` en attente.
//   - Verrou read-modify-write : la création de propositions passe par `updateJson`
//     (store.js) -> mono-process, pas de last-write-wins entre ce sync, un PATCH
//     forecast et une confirmation. Une tâche planifiée doit appeler l'ENDPOINT HTTP
//     (même process que le serveur web) : tout passe donc par le même verrou applicatif.
//   - Une seule proposition Twenty en attente par mois/catégorie, fondée sur la
//     dernière cible et le montant de départ (les anciennes deviennent rejetées).

import { readJsonOr, readJson, updateJson, appendAudit, withDataSnapshot } from './store.js'
import { monthOf, addMonths, monthRange, todayFor } from './dates.js'
import { horizonEnd } from './horizon.js'
import { lireReglages, REGLAGES_PAR_DEFAUT } from './reglages.js'

// Paramètres du connecteur (catégorie alimentée, pondérations par étape, écart minimal,
// montants HT) : config/reglages.json, clé « twenty » (voir docs/REGLAGES.md). Relus à
// chaque synchronisation.
function cfg() {
  return lireReglages().twenty
}

// Pondérations par défaut (probabilité d'encaissement par étape du pipe), exportées pour
// les tests et la documentation. WON pondéré à 0,8 (et non 1) car une affaire gagnée n'est
// pas encore encaissée ; CUSTOMER/LOST = 0 (déjà facturé, suivi par la banque, ou perdu).
export const STAGE_WEIGHTS = REGLAGES_PAR_DEFAUT.twenty.ponderations

// ------------------------------------------------------------------ Lecture du pipe Twenty
/**
 * Lit les opportunités du pipe Twenty via l'API REST (lecture seule). Renvoie un tableau
 * normalisé { id, name, stage, amountCents, closeMonth | null }. Ne dépend d'aucune
 * écriture : pur GET. Lève si l'API est injoignable ou la clé invalide (le caller décide
 * quoi en faire).
 *
 * options : { baseUrl, apiKey, fetchImpl } (fetchImpl injectable pour les tests).
 */
export async function readTwentyPipe({ baseUrl, apiKey, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('TWENTY_URL manquant')
  if (!apiKey) throw new Error('TWENTY_KEY manquant')
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/rest/opportunities`)
  url.searchParams.set('limit', '200')
  const pipe = []
  const cursors = new Set()
  let totalCount
  while (true) {
    const resp = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!resp.ok) throw new Error(`Twenty API ${resp.status} ${resp.statusText}`)
    const body = await resp.json()
    const opps = body?.data?.opportunities
    if (!Array.isArray(opps)) throw new Error('Réponse Twenty inattendue (data.opportunities absent)')
    pipe.push(...opps.map(normalizeOpp))
    if (Number.isInteger(body.totalCount)) totalCount = body.totalCount
    const pageInfo = body.pageInfo ?? body.data.pageInfo
    if (!pageInfo) {
      // Compatibilité avec une petite réponse sans pagination. Une page pleine
      // ne prouve pas que le pipe est complet : on refuse de la valider.
      if (opps.length >= 200 || cursors.size) throw new Error('Twenty pagination incomplète : indication de fin absente')
      break
    }
    if (typeof pageInfo.hasNextPage !== 'boolean') throw new Error('Twenty pagination incomplète : indication de suite invalide')
    if (!pageInfo.hasNextPage) break
    const cursor = pageInfo.endCursor
    if (!opps.length || typeof cursor !== 'string' || !cursor || cursors.has(cursor)) {
      throw new Error('Twenty pagination : curseur de suite absent ou répété')
    }
    cursors.add(cursor)
    url.searchParams.set('starting_after', cursor)
  }
  if (totalCount !== undefined && pipe.length !== totalCount) throw new Error('Twenty pagination incomplète : total reçu incohérent')
  return pipe
}

/** Normalise une opportunité Twenty brute en structure interne. */
export function normalizeOpp(o) {
  const micros = o?.amount?.amountMicros
  const amountCents = Number.isFinite(Number(micros)) ? Math.round(Number(micros) / 1e6 * 100) : 0
  // closeDate Twenty (ISO) -> mois de rattachement. Absent = pas daté (on l'ignorera
  // pour la ventilation mensuelle, il alimentera le mois courant par défaut).
  const closeDate = typeof o?.closeDate === 'string' ? o.closeDate.slice(0, 10) : null
  return {
    id: o?.id || null,
    name: o?.name || '(sans nom)',
    stage: o?.stage || 'NEW',
    amountCents,
    closeDate,
    closeMonth: closeDate && /^\d{4}-\d{2}-\d{2}$/.test(closeDate) ? monthOf(closeDate) : null,
  }
}

// ------------------------------------------------------------------ Pondération -> prévisionnel mensuel
/**
 * À partir du pipe normalisé et de l'état Syntréso, calcule la contribution pondérée du
 * pipe au prévisionnel d'encaissement, ventilée par mois sur l'horizon de projection.
 *
 * Stratégie de ventilation (volontairement simple, proto solo) :
 *   - chaque opp pondérée (amount x poids d'étape) est rattachée à son closeMonth si
 *     présent et dans l'horizon futur ; sinon elle est lissée sur les mois futurs de
 *     l'horizon (mois courant -> horizonEnd), comme l'import historique répartissait le
 *     pipe pondéré sur les 6 mois à venir.
 *
 * Retourne { byMonth: { 'YYYY-MM': cents }, weightedTotalCents, months: [...] }.
 */
// Twenty stocke les montants HT ; le prévisionnel de Syntréso est en TTC, comme la banque.
// On applique donc le taux de TVA de la catégorie d'encaissement (réglage twenty.montantsHT).
// Sans catégorie connue (tests, démo), facteur 1.
export function vatFactorFor(state) {
  if (!cfg().montantsHT) return 1
  const cat = (state.categories || []).find((c) => c.id === cfg().categorieEncaissement)
  const pct = Number(cat?.vatRatePct)
  return Number.isFinite(pct) && pct > 0 ? 1 + pct / 100 : 1
}

export function pipeForecastByMonth(pipe, state) {
  const vatFactor = vatFactorFor(state)
  const weights = cfg().ponderations || {}
  const currentMonth = monthOf(todayFor(state.company))
  const end = horizonEnd(currentMonth)
  const futureMonths = monthRange(currentMonth, end)
  const byMonth = {}
  for (const m of futureMonths) byMonth[m] = 0

  let undatedWeighted = 0
  let weightedTotal = 0
  for (const opp of pipe) {
    const weight = Number(weights[opp.stage]) || 0
    if (weight <= 0 || opp.amountCents <= 0) continue
    const weighted = Math.round(opp.amountCents * weight * vatFactor)
    weightedTotal += weighted
    // Daté et dans le futur de l'horizon -> rattaché au mois. Daté dans le passé ou hors
    // horizon -> ignoré pour la ventilation (déjà encaissé / hors fenêtre). Non daté ->
    // lissé.
    if (opp.closeMonth && opp.closeMonth >= currentMonth && opp.closeMonth <= end) {
      byMonth[opp.closeMonth] += weighted
    } else if (!opp.closeMonth) {
      undatedWeighted += weighted
    }
  }
  // Lissage des opps non datées sur les mois futurs (réparti uniformément, reste au
  // dernier mois pour conserver le centime).
  if (undatedWeighted > 0 && futureMonths.length) {
    const per = Math.floor(undatedWeighted / futureMonths.length / 100) * 100
    let distributed = 0
    for (let i = 0; i < futureMonths.length; i++) {
      const isLast = i === futureMonths.length - 1
      const add = isLast ? undatedWeighted - distributed : per
      byMonth[futureMonths[i]] += add
      distributed += add
    }
  }
  return { byMonth, weightedTotalCents: weightedTotal, months: futureMonths }
}

// ------------------------------------------------------------------ Forecast Syntréso actuel (pipe)
/**
 * Somme, par mois, le prévisionnel d'encaissement DÉJÀ enregistré pour la catégorie
 * pipe (enc_prestations). Sert de base pour ne proposer QUE l'écart vs l'existant.
 */
export function currentPipeForecastByMonth(state) {
  const byMonth = {}
  const categorie = cfg().categorieEncaissement
  for (const f of state.forecast) {
    if (f.categoryId !== categorie) continue
    byMonth[f.month] = (byMonth[f.month] || 0) + f.amountCents
  }
  return byMonth
}

// ------------------------------------------------------------------ Calcul des propositions
/**
 * Compare le prévisionnel pipe RECALCULÉ (Twenty live) au prévisionnel ACTUEL et produit
 * la liste des deltas à proposer, par mois. Pure (pas d'I/O). Renvoie :
 *   [{ month, categoryId, deltaCents, currentCents, targetCents }]
 * Un delta n'est retenu que s'il dépasse MIN_DELTA_CENTS.
 *
 * IMPORTANT : enc_prestations est une catégorie d'ENCAISSEMENT (direction 'in'). Le
 * mécanisme de proposition (agent.validateProposal) rejette un montant négatif sur un
 * encaissement. On ne propose donc QUE les HAUSSES de prévisionnel (delta > 0 : nouvelle
 * opp gagnée / pipe qui grossit), cas de loin le plus fréquent. Une BAISSE (opp perdue,
 * pipe qui rétrécit) n'est pas proposée automatiquement — elle relèverait d'une
 * correction manuelle du prévisionnel, hors périmètre du sync (un ajustement à la baisse
 * d'un encaissement déjà saisi n'est pas une « proposition d'écriture » mais une révision,
 * que le moteur de proposition actuel ne sait pas exprimer sans casser sa validation). Les
 * baisses détectées sont renvoyées dans le rapport (champ `decreases`) pour information,
 * sans créer de proposition.
 */
export function computePipeDeltas(state, pipe) {
  const target = pipeForecastByMonth(pipe, state).byMonth
  const current = currentPipeForecastByMonth(state)
  const out = []
  const decreases = []
  const { categorieEncaissement, ecartMinimalCents } = cfg()
  for (const [month, targetCents] of Object.entries(target)) {
    const currentCents = current[month] || 0
    const deltaCents = targetCents - currentCents
    if (Math.abs(deltaCents) < ecartMinimalCents) continue
    const entry = { month, categoryId: categorieEncaissement, deltaCents, currentCents, targetCents }
    if (deltaCents > 0) out.push(entry)
    else decreases.push(entry)
  }
  out.sort((a, b) => (a.month < b.month ? -1 : 1))
  decreases.sort((a, b) => (a.month < b.month ? -1 : 1))
  // On attache les baisses sur le tableau retourné (propriété non-énumérable pour ne pas
  // polluer les itérations sur les deltas à proposer).
  Object.defineProperty(out, 'decreases', { value: decreases, enumerable: false })
  return out
}

// ------------------------------------------------------------------ Émission des propositions
let twentyProposalSeq = 0

/**
 * Crée des propositions `forecast_line` (en attente) pour chaque delta pipe, via le verrou
 * de données (updateJson). Remplace les propositions périmées, y compris si le pipe
 * disparaît ou passe sous le seuil. Conserve une proposition strictement identique.
 */
async function emitPipeProposals(deltas, months, categoryId) {
  let created = 0
  let skipped = 0
  await updateJson(
    'proposals',
    (proposals) => {
      const list = Array.isArray(proposals) ? proposals : []
      let changed = false
      for (const month of months) {
        const d = deltas.find((delta) => delta.month === month)
        const pending = list.filter(
          (p) =>
            p.status === 'pending' &&
            p.kind === 'forecast_line' &&
            p.source === 'twenty-sync' &&
            p.payload?.month === month &&
            p.payload?.categoryId === categoryId,
        )
        const identical = d && pending.find((p) => p.payload.amountCents === d.deltaCents && p.context?.currentCents === d.currentCents && p.context?.targetCents === d.targetCents)
        for (const p of pending) {
          if (p === identical) continue
          p.status = 'rejected'
          p.resolvedAt = new Date().toISOString()
          p.resolutionReason = 'Remplacée par une synchronisation Twenty plus récente.'
          changed = true
        }
        if (!d) continue
        if (identical) {
          skipped += 1
          continue
        }
        const label = `Pipe Twenty - ajustement ${d.month} (hausse)`
        twentyProposalSeq += 1
        const proposal = {
          id: `prop_tw_${Date.now().toString(36)}_${twentyProposalSeq}`,
          createdAt: new Date().toISOString(),
          status: 'pending',
          source: 'twenty-sync',
          kind: 'forecast_line',
          payload: {
            kind: 'forecast_line',
            month: d.month,
            categoryId: d.categoryId,
            amountCents: d.deltaCents,
            label,
          },
          // contexte affiché au dirigeant pour décider en un coup d'oeil
          context: {
            currentCents: d.currentCents,
            targetCents: d.targetCents,
            deltaCents: d.deltaCents,
          },
        }
        list.push(proposal)
        created += 1
        changed = true
      }
      // si rien de neuf, ne pas réécrire le fichier (updateJson skip sur undefined)
      if (!changed) return undefined
      return list
    },
    [],
  )
  return { created, skipped }
}

// ------------------------------------------------------------------ Point d'entrée du sync
/**
 * Sync complet : lit Twenty live, calcule les deltas, émet les propositions, met à jour
 * company.importedAt.twenty et journalise. Ne persiste AUCUN solde, n'écrit JAMAIS le
 * forecast directement : il ne crée que des propositions en attente.
 *
 * options :
 *   - baseUrl / apiKey : surchargent TWENTY_URL / TWENTY_KEY (env).
 *   - fetchImpl : pour les tests.
 *   - dryRun : calcule et renvoie les deltas SANS créer de proposition ni écrire.
 *
 * Renvoie un rapport { ok, weightedTotalCents, deltas, proposalsCreated, proposalsSkipped, dryRun }.
 */
export async function syncTwenty({ baseUrl, apiKey, fetchImpl = fetch, dryRun = false } = {}) {
  const resolvedBase = baseUrl || process.env.TWENTY_URL || ''
  const resolvedKey = apiKey || process.env.TWENTY_KEY || ''
  const state = await loadStateLight()
  const categorie = cfg().categorieEncaissement
  if (state.categories.length && !state.categories.some((c) => c.id === categorie)) {
    const err = new Error(`catégorie « ${categorie} » (réglage twenty.categorieEncaissement) absente de categories.json`)
    err.status = 422
    throw err
  }

  const pipe = await readTwentyPipe({ baseUrl: resolvedBase, apiKey: resolvedKey, fetchImpl })
  const { weightedTotalCents, months } = pipeForecastByMonth(pipe, state)
  const deltas = computePipeDeltas(state, pipe)

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      oppCount: pipe.length,
      weightedTotalCents,
      deltas,
      decreases: deltas.decreases || [],
      proposalsCreated: 0,
      proposalsSkipped: 0,
    }
  }

  const { created: proposalsCreated, skipped: proposalsSkipped } = await emitPipeProposals(deltas, months, categorie)

  // Marqueur de fraîcheur : la source commerciale (twenty) vient d'être relue. On met à
  // jour company.importedAt.twenty (le bandeau de fraîcheur côté front s'appuie dessus).
  await touchTwentyImportedAt()

  await appendAudit({
    actor: 'cron',
    action: 'import.run',
    target: 'twenty',
    meta: {
      source: 'twenty-sync',
      oppCount: pipe.length,
      deltas: deltas.length,
      created: proposalsCreated,
      skipped: proposalsSkipped,
    },
  })

  return {
    ok: true,
    dryRun: false,
    oppCount: pipe.length,
    weightedTotalCents,
    deltas,
    decreases: deltas.decreases || [],
    proposalsCreated,
    proposalsSkipped,
  }
}

// Met à jour company.importedAt.twenty = aujourd'hui (date serveur), via le verrou.
async function touchTwentyImportedAt() {
  const today = new Date().toISOString().slice(0, 10)
  await updateJson('company', (company) => {
    if (!company) return undefined
    const next = { ...company }
    next.importedAt = { ...(next.importedAt || {}), twenty: today }
    return next
  })
}

// Lecture d'état minimale pour le sync (company + forecast). On ne dépend pas de
// projection.loadState (qui charge tout) pour rester léger et éviter d'importer le moteur.
async function loadStateLight() {
  return withDataSnapshot(async () => {
    const [company, forecast, categories] = await Promise.all([
      readJson('company'),
      readJson('forecast'),
      readJsonOr('categories', []),
    ])
    return { company, forecast, categories }
  })
}
