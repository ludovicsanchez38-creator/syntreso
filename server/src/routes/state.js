import { Router } from 'express'
import { loadState, project, kpis, dataFreshness, reconciliation, todayFor } from '../services/projection.js'
import { computeAlerts } from '../services/alerts.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const state = await loadState()
    const projection = project(state)
    res.json({
      // today calculé serveur (demoToday en démo, date réelle sinon) : le front ne
      // déduit jamais « aujourd'hui » lui-même, ni de new Date() ni de demoToday.
      company: { ...state.company, today: todayFor(state.company) },
      accounts: state.accounts,
      categories: state.categories,
      invoices: state.invoices,
      kpis: kpis(state, projection),
      alerts: computeAlerts(state, projection),
      dataFreshness: dataFreshness(state.company),
      reconciliation: reconciliation(state),
    })
  } catch (err) {
    next(err)
  }
})

export default router
