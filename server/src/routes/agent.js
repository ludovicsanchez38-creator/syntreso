import { Router } from 'express'
import { streamAgentResponse, isAskBusy, getCachedContent, getMonthlyReview, checkClaudeAvailable, assistantStatus } from '../services/agent.js'
import { regenerateDigest } from '../services/digest.js'

const router = Router()

// Assistant coupé (pas de clé d'API, SYNTRESO_ASSISTANT=non ou "assistant.actif": false
// dans les réglages) : les routes qui font travailler le modèle répondent 503 avec la
// raison, sans rien lancer ; tout le reste de l'appli marche.
function exigeAssistant(_req, res, next) {
  const statut = assistantStatus()
  if (!statut.available) return res.status(503).json({ error: `assistant indisponible : ${statut.raison}` })
  next()
}

// utilisé par npm run reset-demo : resynchronise le digest après re-seed
router.post('/digest', async (_req, res, next) => {
  try {
    await regenerateDigest()
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

router.get('/status', async (_req, res) => {
  const statut = assistantStatus()
  const available = statut.available ? await checkClaudeAvailable() : false
  res.json({ available, raison: available ? statut.raison : (statut.available ? 'Agent SDK non installé ou exécutable Claude introuvable (CLAUDE_BIN)' : statut.raison) })
})

// POST /api/agent/ask { question } -> flux SSE { type: chunk | proposal | proposal_error | done | error }
router.post('/ask', exigeAssistant, async (req, res) => {
  const question = String(req.body?.question || '').slice(0, 2000).trim()
  if (!question) return res.status(400).json({ error: 'question vide' })

  // Usage solo : un seul ask à la fois. Si une génération est déjà en cours, on
  // refuse immédiatement (429) avant d'ouvrir le flux SSE et de spawner un process.
  if (isAskBusy()) {
    return res.status(429).json({ error: 'assistant occupé : une réponse est déjà en cours de génération' })
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  const newConversation = req.body?.newConversation === true
  const iterator = streamAgentResponse({ question, newConversation })
  // client parti (onglet fermé, reload) : on arrête le générateur, son finally
  // tue le process claude au lieu de le laisser générer dans le vide
  res.on('close', () => {
    if (!res.writableEnded) iterator.return().catch(() => {})
  })
  try {
    for await (const evt of iterator) {
      send(evt)
      if (evt.type === 'error') break
    }
  } catch (err) {
    send({ type: 'error', message: err.message })
  }
  res.end()
})

// Revue mensuelle challengée : commentaire du mois + contre-lecture du contradicteur.
// ?refresh=1 régénère les deux (2 générations séquentielles : compter ~1-3 min).
router.get('/revue-mensuelle', exigeAssistant, async (req, res, next) => {
  try {
    res.json(await getMonthlyReview({ refresh: req.query.refresh === '1' }))
  } catch (err) {
    next(err)
  }
})

// Contenus pré-générés : alerte proactive et commentaire du mois
router.get('/proactive', exigeAssistant, async (req, res, next) => {
  try {
    res.json(await getCachedContent('proactive', { refresh: req.query.refresh === '1' }))
  } catch (err) {
    next(err)
  }
})

router.get('/comment', exigeAssistant, async (req, res, next) => {
  try {
    res.json(await getCachedContent('comment', { refresh: req.query.refresh === '1' }))
  } catch (err) {
    next(err)
  }
})

export default router
