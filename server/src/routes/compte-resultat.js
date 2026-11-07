import { Router } from 'express'
import { loadState, actualsByMonth, forecastByMonth, monthOf, todayFor } from '../services/projection.js'
import { compteResultatMensuel } from '../services/fiscal.js'

const router = Router()

// Compte de résultat mensuel (produits/charges HT, résultat avant/après IS, ratios) pour
// un exercice donné. Même calcul que le résultat annuel (resultatPrevisionnel en est
// l'agrégat) : une seule vérité partagée avec le PDF dossier banquier et l'assistant.
router.get('/', async (req, res, next) => {
  try {
    const state = await loadState()
    const currentMonth = monthOf(todayFor(state.company))
    const year =
      typeof req.query.year === 'string' && /^\d{4}$/.test(req.query.year)
        ? req.query.year
        : currentMonth.slice(0, 4)
    const actuals = actualsByMonth(state.transactions)
    const forecasts = forecastByMonth(state.forecast)
    const cr = compteResultatMensuel(state, { actuals, forecasts, currentMonth }, year)

    // Exercices proposables au sélecteur : ceux couverts par le réalisé ou le prévisionnel.
    const years = new Set([currentMonth.slice(0, 4)])
    for (const t of state.transactions) years.add(t.date.slice(0, 4))
    for (const f of state.forecast) years.add(f.month.slice(0, 4))

    res.json({ ...cr, availableYears: [...years].sort(), currentYear: currentMonth.slice(0, 4) })
  } catch (err) {
    next(err)
  }
})

export default router
