import { Router } from 'express'
import { loadState } from '../services/projection.js'
import { buildDossierHTML } from '../services/export-dossier.js'

const router = Router()

// GET /api/export/dossier -> page HTML print-ready (dossier banquier). PDF via impression navigateur (Ctrl+P) : aucune dépendance lourde. Sert
// du text/html, pas du JSON (c'est une page autonome destinée à être imprimée).
router.get('/dossier', async (_req, res, next) => {
  try {
    const state = await loadState()
    const html = buildDossierHTML(state)
    res.set('Content-Type', 'text/html; charset=utf-8')
    res.send(html)
  } catch (err) {
    next(err)
  }
})

export default router
