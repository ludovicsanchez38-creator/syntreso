import { Router } from 'express'
import { readJson, writeJson } from '../services/store.js'
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
    const [scenarios, company] = await Promise.all([readJson('scenarios'), readJson('company')])
    res.json(resoudreBornes(scenarios, monthOf(todayFor(company))))
  } catch (err) {
    next(err)
  }
})

router.put('/:id', async (req, res, next) => {
  try {
    const scenarios = await readJson('scenarios')
    const sc = scenarios.find((s) => s.id === req.params.id)
    if (!sc) return res.status(404).json({ error: 'scénario inconnu' })

    const { params, active } = req.body || {}
    if (params && typeof params === 'object') {
      for (const [key, value] of Object.entries(params)) {
        if (!(key in sc.params)) return res.status(400).json({ error: `paramètre inconnu: ${key}` })
        sc.params[key] = value
      }
    }
    if (typeof active === 'boolean') sc.active = active

    await writeJson('scenarios', scenarios)
    const company = await readJson('company')
    res.json(resoudreBornes([sc], monthOf(todayFor(company)))[0])
  } catch (err) {
    next(err)
  }
})

export default router
