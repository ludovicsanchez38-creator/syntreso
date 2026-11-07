import { Router } from 'express'
import { readAudit } from '../services/store.js'

const router = Router()

// GET /api/audit?limit=100 -> dernières lignes du journal d'audit (append-only JSONL).
// Trace ULTRA-LIGHT de ce que l'agent/l'utilisateur a touché (confort, pas conformité).
// Plus récentes en dernier. Utile pour un panneau « historique des modifications ».
router.get('/', async (req, res, next) => {
  try {
    const limit = Number.isInteger(Number(req.query.limit)) && Number(req.query.limit) > 0
      ? Math.min(Number(req.query.limit), 1000)
      : 100
    const entries = await readAudit({ limit })
    res.json({ entries, count: entries.length })
  } catch (err) {
    next(err)
  }
})

export default router
