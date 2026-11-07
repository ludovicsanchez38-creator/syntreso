import { Router } from 'express'
import { readJson } from '../services/store.js'

const router = Router()

router.get('/', async (req, res, next) => {
  try {
    const { month, categoryId, limit } = req.query
    let txns = await readJson('transactions')
    if (month) txns = txns.filter((t) => t.date.startsWith(month))
    if (categoryId) txns = txns.filter((t) => t.categoryId === categoryId)
    txns.sort((a, b) => (a.date < b.date ? 1 : -1))
    if (limit) txns = txns.slice(0, Number(limit))
    res.json(txns)
  } catch (err) {
    next(err)
  }
})

export default router
