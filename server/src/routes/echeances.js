import { Router } from 'express'
import { loadState, actualsByMonth, forecastByMonth } from '../services/projection.js'
import { cashCalendar } from '../services/echeances.js'

const router = Router()

// GET /api/echeances?jours=90 -> cash calendar des sorties datées sur la fenêtre.
// Couche d'affichage : ne refond pas le moteur mensuel, date seulement les grosses
// échéances certaines (TVA, URSSAF dérivées + échéances saisies dans echeances.json).
router.get('/', async (req, res, next) => {
  try {
    const horizonDays = Number.isInteger(Number(req.query.jours)) && Number(req.query.jours) > 0
      ? Math.min(Number(req.query.jours), 365)
      : 90
    const state = await loadState()
    const actuals = actualsByMonth(state.transactions)
    const forecasts = forecastByMonth(state.forecast)
    const calendar = await cashCalendar(state, { horizonDays, actuals, forecasts })
    res.json(calendar)
  } catch (err) {
    next(err)
  }
})

export default router
