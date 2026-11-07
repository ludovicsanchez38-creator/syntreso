import { Router } from 'express'
import { syncTwenty } from '../services/twenty.js'
import { recalageCharges } from '../services/recalage.js'

const router = Router()

// POST /api/integrations/recalage-charges -> compare le prévisionnel de charges au
// réalisé récent (médiane 6 mois mensualisée, charges.js) et ÉMET DES PROPOSITIONS de
// recalage au-delà des seuils (écart > 30 % ET > 50 EUR/mois). Jamais d'écriture
// directe : le dirigeant valide dans l'interface, ses ajustements manuels restent maîtres.
// ?dry=1 : diagnostic seul (rien de créé).
router.post('/recalage-charges', async (req, res, next) => {
  try {
    const dryRun = req.query.dry === '1' || req.body?.dryRun === true
    res.json(await recalageCharges({ dryRun }))
  } catch (err) {
    next(err)
  }
})

// POST /api/integrations/twenty/sync -> lit le pipe Twenty live, calcule les écarts vs le
// prévisionnel d'encaissement et ÉMET DES PROPOSITIONS (jamais d'écriture directe). Un
// agent ou une tâche planifiée peut l'appeler ; le dirigeant valide ensuite les
// propositions d'un clic dans l'interface. ?dry=1 calcule les écarts sans rien créer.
//
// Garde-fou : Twenty = source côté commercial, Indy = source côté banque. Syntréso n'écrit
// jamais le forecast en autonomie depuis une note CRM : elle propose, l'humain tranche.
router.post('/twenty/sync', async (req, res, next) => {
  try {
    const dryRun = req.query.dry === '1' || req.body?.dryRun === true
    const report = await syncTwenty({ dryRun })
    res.json(report)
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ ok: false, error: err.message })
    // Twenty injoignable / clé invalide / réponse inattendue : 502 (dépendance externe),
    // message lisible, pas de 500 opaque.
    if (/TWENTY_(URL|KEY) manquant/.test(err.message)) {
      return res.status(503).json({ ok: false, error: `connecteur Twenty non configuré (${err.message}) : renseigner TWENTY_URL et TWENTY_KEY dans .env` })
    }
    if (/fetch failed/.test(err.message)) {
      return res.status(502).json({ ok: false, error: `Twenty injoignable à l'adresse TWENTY_URL (${err.cause?.code || err.message})` })
    }
    if (/Twenty|TWENTY/.test(err.message)) {
      return res.status(502).json({ ok: false, error: err.message })
    }
    next(err)
  }
})

export default router
