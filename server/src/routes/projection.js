import { Router } from 'express'
import { loadState, project, scenarioDeltas, addMonths, monthOf, todayFor } from '../services/projection.js'
import { remunerationCheck, ccaRepaymentCheck, forecastImpact, compareRemunerationDividendes } from '../services/decision.js'

const router = Router()

const RANGE_MONTHS = { '1M': 1, '3M': 3, '6M': 6, '12M': 12 }

router.get('/', async (req, res, next) => {
  try {
    const state = await loadState()
    const today = todayFor(state.company)

    let fromDate = null
    let toDate = null
    const range = req.query.range
    if (range && RANGE_MONTHS[range]) {
      const n = RANGE_MONTHS[range]
      // Fenêtre d'affichage : un peu de passé (max 2 mois, contexte du réalisé) + N mois
      // de futur projeté. Borner les DEUX côtés rend les paliers 1M/3M/6M/12M distincts
      // (sinon le futur jusqu'à l'horizon écrase la différence).
      fromDate = `${addMonths(monthOf(today), -Math.min(n, 2))}-01`
      toDate = `${addMonths(monthOf(today), n)}-31`
    }

    const base = project(state, { fromDate, toDate })

    let scenario = null
    const ids = (req.query.scenarios || '').split(',').filter(Boolean)
    if (ids.length) {
      const deltas = scenarioDeltas(state.scenarios, ids, state)
      const result = project(state, { fromDate, toDate, deltas })
      // On expose aussi le runway et le NET du scénario pour le « verdict d'impact »
      // côté front (delta de marge en mois, passage sous le seuil). Le front ne
      // recalcule jamais : il lit base vs scénario, déjà produits par le moteur.
      scenario = {
        ids,
        series: result.series,
        monthly: result.monthly,
        lowPoint: result.lowPoint,
        netAvailableCents: result.netAvailableCents,
        runwayMonths: result.runwayMonths,
        runwayWorstCaseMonths: result.runwayWorstCaseMonths,
      }
    }

    res.json({ ...base, scenario })
  } catch (err) {
    next(err)
  }
})

// Feu vert « puis-je me verser X ? » : overlay éphémère (prélèvement gérant +
// cotisations couplées), recalcul moteur, verdict vert/ambre/rouge + chiffres. Ne
// persiste rien. Le verdict est calculé serveur, jamais par le modèle de langage.
router.post('/remuneration-check', async (req, res, next) => {
  try {
    const { montantCents, mois, horizonJours } = req.body || {}
    if (!Number.isInteger(montantCents) || montantCents <= 0) {
      return res.status(400).json({ error: 'montantCents doit être un entier positif (centimes)' })
    }
    const state = await loadState()
    const result = remunerationCheck(state, {
      amountCents: montantCents,
      month: typeof mois === 'string' ? mois : null,
      horizonDays: Number.isInteger(horizonJours) ? horizonJours : 60,
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// Feu vert « puis-je me REMBOURSER X du compte courant d'associé ? » : comme le
// remuneration-check MAIS sans cotisations couplées (remboursement de dette, net
// d'impôt) et plafonné par le CCA accumulé. Ne persiste rien.
router.post('/cca-check', async (req, res, next) => {
  try {
    const { montantCents, mois, horizonJours } = req.body || {}
    if (!Number.isInteger(montantCents) || montantCents <= 0) {
      return res.status(400).json({ error: 'montantCents doit être un entier positif (centimes)' })
    }
    const state = await loadState()
    const result = ccaRepaymentCheck(state, {
      amountCents: montantCents,
      month: typeof mois === 'string' ? mois : null,
      horizonDays: Number.isInteger(horizonJours) ? horizonJours : 60,
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// Aperçu d'impact d'une écriture prévisionnelle (verdict d'impact d'une proposition).
// Overlay éphémère { mois -> { catégorie -> montant signé } }, recalcul moteur, base
// vs après. Ne persiste rien. 400 si payload invalide.
router.post('/impact', async (req, res, next) => {
  try {
    const { mois, categoryId, montantCents } = req.body || {}
    if (!Number.isInteger(montantCents)) {
      return res.status(400).json({ error: 'montantCents doit être un entier (centimes)' })
    }
    if (typeof mois !== 'string' || typeof categoryId !== 'string') {
      return res.status(400).json({ error: 'mois et categoryId (chaînes) sont requis' })
    }
    const state = await loadState()
    if (!state.categories.some((c) => c.id === categoryId)) {
      return res.status(400).json({ error: `Catégorie inconnue : ${categoryId}` })
    }
    const result = forecastImpact(state, { month: mois, categoryId, amountCents: montantCents })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// Arbitrage rémunération vs dividendes (SARL-U à l'IS, gérant majoritaire TNS) : pour une
// enveloppe de coût entreprise `montantCents`, le NET en poche par chaque voie. Le calcul
// fiscal vit dans fiscal.js (taux 2026 paramétrables company.fiscal). Ne persiste rien.
router.post('/dividendes-vs-remuneration', async (req, res, next) => {
  try {
    const { montantCents, mois } = req.body || {}
    if (!Number.isInteger(montantCents) || montantCents <= 0) {
      return res.status(400).json({ error: 'montantCents doit être un entier positif (centimes)' })
    }
    const state = await loadState()
    const result = compareRemunerationDividendes(state, {
      grossCostCents: montantCents,
      month: typeof mois === 'string' ? mois : null,
    })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

export default router
