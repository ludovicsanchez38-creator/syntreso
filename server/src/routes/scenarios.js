import { Router } from 'express'
import { readJson, updateJson, withDataSnapshot } from '../services/store.js'
import { addMonths, monthOf, todayFor } from '../services/dates.js'

const router = Router()

// Bornes de curseur relatives (« +1 », « +12 » = N mois après le mois courant) : résolues
// à la lecture, pour que les scénarios d'une base créée il y a un an restent utilisables.
const RELATIF = /^[+-]?\d+$/
function resoudreBornes(scenarios, currentMonth) {
  return scenarios.map((sc) => ({
    ...sc,
    sliders: (sc.sliders || []).map((sl) =>
      sl.type === 'month'
        ? {
            ...sl,
            min: RELATIF.test(String(sl.min)) ? addMonths(currentMonth, Number(sl.min)) : sl.min,
            max: RELATIF.test(String(sl.max)) ? addMonths(currentMonth, Number(sl.max)) : sl.max,
          }
        : sl,
    ),
  }))
}

router.get('/', async (_req, res, next) => {
  try {
    const [scenarios, company] = await withDataSnapshot(() => Promise.all([readJson('scenarios'), readJson('company')]))
    res.json(resoudreBornes(scenarios, monthOf(todayFor(company))))
  } catch (err) {
    next(err)
  }
})

router.put('/:id', async (req, res, next) => {
  try {
    let sc
    let error
    let status
    await updateJson('scenarios', (scenarios) => {
      sc = scenarios.find((s) => s.id === req.params.id)
      if (!sc) {
        error = 'scénario inconnu'
        status = 404
        return undefined
      }
      const { params, active } = req.body || {}
      if (params && typeof params === 'object') {
        for (const [key, value] of Object.entries(params)) {
          if (!(key in sc.params)) {
            error = `paramètre inconnu: ${key}`
            status = 400
            return undefined
          }
          sc.params[key] = value
        }
      }
      if (typeof active === 'boolean') sc.active = active
      return scenarios
    })
    if (error) return res.status(status).json({ error })

    const company = await readJson('company')
    res.json(resoudreBornes([sc], monthOf(todayFor(company)))[0])
  } catch (err) {
    next(err)
  }
})

export default router
