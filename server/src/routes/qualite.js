import { Router } from 'express'
import { qualitePrevisions, qualitePrevisionsText } from '../services/qualite.js'

const router = Router()

// GET /api/qualite-previsions[?month=YYYY-MM][&format=text]
// Prévu (snapshot d'archive du mois) vs réalisé pour un mois clos. format=text renvoie
// le bloc prêt à relayer tel quel (notification, agent) : le serveur reste la seule
// source des chiffres.
router.get('/', async (req, res, next) => {
  try {
    const month = typeof req.query.month === 'string' ? req.query.month : undefined
    if (req.query.format === 'text') {
      res.type('text/plain').send(await qualitePrevisionsText({ month }))
    } else {
      res.json(await qualitePrevisions({ month }))
    }
  } catch (err) {
    next(err)
  }
})

export default router
