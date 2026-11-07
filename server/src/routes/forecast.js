import { Router } from 'express'
import { updateJson, appendAudit } from '../services/store.js'
import { loadState, forecastGrid, monthOf, todayFor } from '../services/projection.js'
import { autoManagedCategoryIds } from '../services/fiscal.js'
import { onDataChanged } from '../services/events.js'

const router = Router()

router.get('/', async (_req, res, next) => {
  try {
    const state = await loadState()
    res.json(forecastGrid(state))
  } catch (err) {
    next(err)
  }
})

router.patch('/', async (req, res, next) => {
  try {
    const { month, categoryId, amountCents, note } = req.body
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month invalide' })
    if (!Number.isInteger(amountCents)) return res.status(400).json({ error: 'amountCents doit être un entier (centimes)' })

    const state = await loadState()
    const cat = state.categories.find((c) => c.id === categoryId)
    if (!cat) return res.status(400).json({ error: 'categoryId inconnu' })
    // Catégories pilotées par le moteur (TVA/URSSAF/IS dérivées) : la saisie directe
    // aurait une sémantique ambiguë (montant absolu vs ajustement). Le seul chemin
    // d'écriture est une proposition de l'assistant (ajustement additif validé).
    if (autoManagedCategoryIds(state.company).has(categoryId)) {
      return res.status(400).json({ error: 'catégorie pilotée automatiquement par le moteur : passer par une proposition de l\'assistant (ajustement additif)' })
    }
    if (month < monthOf(todayFor(state.company))) return res.status(400).json({ error: 'mois passé non éditable' })
    if (cat.direction === 'in' && amountCents < 0) return res.status(400).json({ error: 'une catégorie d\'encaissement ne peut pas être négative' })
    if (cat.direction === 'out' && amountCents > 0) return res.status(400).json({ error: 'une catégorie de décaissement doit être négative ou nulle' })

    const id = `fc_${month}_${categoryId}`
    // Cycle read-modify-write VERROUILLÉ : la lecture et la réécriture du prévisionnel
    // tiennent dans une seule section critique de la file de données partagée. Plus de
    // last-write-wins entre ce PATCH et une confirmation de proposition concurrente.
    let auditBefore = null
    await updateJson(
      'forecast',
      (forecast) => {
        const list = forecast || []
        const existing = list.find((f) => f.id === id)
        auditBefore = existing ? { amountCents: existing.amountCents } : null
        if (existing) {
          existing.amountCents = amountCents
          existing.source = 'user'
          if (note !== undefined) existing.note = note
        } else {
          list.push({ id, month, categoryId, amountCents, note: note ?? null, source: 'user' })
        }
        return list
      },
      [],
    )
    await appendAudit({
      actor: 'user',
      action: 'forecast.upsert',
      target: id,
      before: auditBefore,
      after: { amountCents },
      meta: { month, categoryId },
    })
    await onDataChanged()

    const freshState = await loadState()
    res.json(forecastGrid(freshState))
  } catch (err) {
    next(err)
  }
})

export default router
