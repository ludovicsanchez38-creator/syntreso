import express, { Router } from 'express'
import { writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { executerImport, reperer, lireGrandLivre, natureExport } from '../services/import-indy.js'
import { entreeIndyDir } from '../services/paths.js'
import { onDataChanged } from '../services/events.js'

const router = Router()

// GET /api/import/indy -> ce que l'import prendrait dans le dossier d'entrée (rien n'est lu
// en profondeur ni écrit).
router.get('/indy', async (_req, res) => {
  try {
    const { grandsLivres, balance, ignores } = await reperer(entreeIndyDir())
    res.json({
      dossier: entreeIndyDir(),
      grandsLivres: grandsLivres.map((g) => {
        const { premiereDate, derniereDate } = lireGrandLivre(g.texte)
        return { nom: g.nom, du: premiereDate, au: derniereDate }
      }),
      balance: balance ? balance.nom : null,
      ignores,
    })
  } catch (err) {
    res.status(422).json({ error: err.message })
  }
})

// PUT /api/import/indy/fichiers/:nom (corps = contenu CSV brut) -> dépose un export dans
// le dossier d'entrée. Pratique pour un agent ou un serveur distant (pas besoin de scp).
const NOM_VALIDE = /^[\w .()-]{1,120}\.csv$/i
router.put('/indy/fichiers/:nom', express.text({ type: () => true, limit: '25mb' }), async (req, res, next) => {
  try {
    const nom = req.params.nom
    if (!NOM_VALIDE.test(nom) || path.basename(nom) !== nom) {
      return res.status(400).json({ error: 'nom de fichier invalide (lettres, chiffres, espaces, . - _ ( ), extension .csv)' })
    }
    const texte = typeof req.body === 'string' ? req.body : ''
    const nature = natureExport(texte)
    if (!nature) return res.status(422).json({ error: 'contenu non reconnu : grand livre ou balance Indy (CSV point-virgule) attendu' })
    await mkdir(entreeIndyDir(), { recursive: true })
    const cible = path.join(entreeIndyDir(), nom)
    await writeFile(`${cible}.tmp`, texte, 'utf8')
    await rename(`${cible}.tmp`, cible)
    res.status(201).json({ ok: true, nom, nature, octets: Buffer.byteLength(texte) })
  } catch (err) {
    next(err)
  }
})

// POST /api/import/indy { simulation?, reinitialiserPrevisionnel? } -> importe les exports du
// dossier d'entrée. simulation=true calcule et renvoie le rapport sans rien écrire.
router.post('/indy', async (req, res) => {
  const simulation = req.body?.simulation === true || req.query.simulation === '1'
  const reinitialiserPrevisionnel = req.body?.reinitialiserPrevisionnel === true
  let rapport
  try {
    rapport = await executerImport({ dossier: entreeIndyDir(), simulation, reinitialiserPrevisionnel })
  } catch (err) {
    return res.status(422).json({ error: err.message })
  }
  if (!simulation) await onDataChanged()
  res.json(rapport)
})

export default router
