import { Router } from 'express'
import { listProposals, resolveProposal, createProposal } from '../services/agent.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    res.json(await listProposals())
  } catch (err) {
    next(err)
  }
})

// POST /api/proposals -> un agent (ou un script) PROPOSE une écriture ; elle reste en
// attente jusqu'à la décision humaine (interface, ou confirm/reject sur instruction).
router.post('/', async (req, res, next) => {
  try {
    const result = await createProposal(req.body || {}, { source: 'agent-api' })
    if (result.error) return res.status(result.status || 400).json({ error: result.error })
    res.status(201).json(result.proposal)
  } catch (err) {
    next(err)
  }
})

router.post('/:id/confirm', async (req, res, next) => {
  try {
    const result = await resolveProposal(req.params.id, 'confirm', req.body?.amendments || {})
    if (result.error) return res.status(result.status || 400).json({ error: result.error })
    res.json(result.proposal)
  } catch (err) {
    next(err)
  }
})

router.post('/:id/reject', async (req, res, next) => {
  try {
    const result = await resolveProposal(req.params.id, 'reject')
    if (result.error) return res.status(result.status || 400).json({ error: result.error })
    res.json(result.proposal)
  } catch (err) {
    next(err)
  }
})

export default router
