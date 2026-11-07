import './env.js'
import express from 'express'
import { existsSync } from 'node:fs'
import path from 'node:path'
import stateRouter from './routes/state.js'
import transactionsRouter from './routes/transactions.js'
import forecastRouter from './routes/forecast.js'
import projectionRouter from './routes/projection.js'
import compteResultatRouter from './routes/compte-resultat.js'
import scenariosRouter from './routes/scenarios.js'
import echeancesRouter from './routes/echeances.js'
import agentRouter from './routes/agent.js'
import proposalsRouter from './routes/proposals.js'
import auditRouter from './routes/audit.js'
import integrationsRouter from './routes/integrations.js'
import exportRouter from './routes/export.js'
import qualiteRouter from './routes/qualite.js'
import importRouter from './routes/import.js'
import { subscribeDataChanged } from './services/events.js'
import { regenerateDigest, ensureWorkspace } from './services/digest.js'
import { ensureMemoire } from './services/memoire.js'
import { ensureForecastSnapshot } from './services/qualite.js'
import { pregenerateContent, checkClaudeAvailable, assistantStatus } from './services/agent.js'
import { accessFromEnv } from './middleware/access.js'
import { ROOT, dataDir } from './services/paths.js'
import { dataPath } from './services/store.js'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: false, limit: '16kb' })) // formulaire de connexion

// Authentification AVANT tout (API + front) : jeton local (en-tête Bearer ou cookie posé
// par /connexion), ou Cloudflare Access en option. Voir middleware/access.js.
const access = accessFromEnv()
if (!access.enabled) {
  if (process.env.SYNTRESO_SANS_AUTH === '1') {
    console.warn('[accès] AUCUNE authentification (SYNTRESO_SANS_AUTH=1) : réservé au développement local')
  } else {
    console.error('[accès] SYNTRESO_JETON est vide : le serveur refuse de démarrer sans protection.')
    console.error('[accès] Générez un jeton (ex. : openssl rand -hex 32) et placez-le dans .env (SYNTRESO_JETON=...).')
    process.exit(1)
  }
}
app.use(access)

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'syntreso-server' })
})

app.use('/api/state', stateRouter)
app.use('/api/transactions', transactionsRouter)
app.use('/api/forecast', forecastRouter)
app.use('/api/projection', projectionRouter)
app.use('/api/compte-resultat', compteResultatRouter)
app.use('/api/scenarios', scenariosRouter)
app.use('/api/echeances', echeancesRouter)
app.use('/api/agent', agentRouter)
app.use('/api/proposals', proposalsRouter)
app.use('/api/audit', auditRouter)
app.use('/api/integrations', integrationsRouter)
app.use('/api/export', exportRouter)
app.use('/api/qualite-previsions', qualiteRouter)
app.use('/api/import', importRouter)

// Route API inconnue : 404 JSON explicite (sinon le repli du front renverrait du HTML).
app.use('/api', (_req, res) => res.status(404).json({ error: 'route inconnue' }))

// Front construit (web/dist) servi sur la même origine que /api : une seule adresse à
// protéger et à exposer. Sans web/dist (développement), Vite sert le front et relaie /api.
const webDist = path.join(ROOT, 'web', 'dist')
if (existsSync(webDist)) {
  app.use(express.static(webDist))
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
    res.sendFile(path.join(webDist, 'index.html'))
  })
  console.log('[web] interface servie depuis web/dist')
}

app.use((err, _req, res, _next) => {
  // Fichier de données absent : base pas encore initialisée (cas du premier démarrage).
  if (err?.code === 'ENOENT' && String(err.path || '').startsWith(dataDir())) {
    return res.status(503).json({
      error: `données absentes (${path.basename(err.path)}) : initialisez la base avec "npm run init" (base vide) ou "npm run demo" (données fictives)`,
    })
  }
  console.error(err)
  res.status(err?.status || 500).json({ error: err.message })
})

// Le digest de l'assistant suit chaque mutation des données ; le cliché mensuel du
// prévisionnel (boucle qualité prévu / réalisé) s'accroche au même signal.
subscribeDataChanged(async () => {
  await ensureForecastSnapshot()
  await regenerateDigest()
})

const PORT = Number(process.env.SYNTRESO_PORT) || 3900
// 127.0.0.1 par défaut : l'appli n'est joignable que depuis la machine elle-même (ou via
// un reverse proxy local). Dans Docker, le conteneur écoute sur 0.0.0.0 mais le port
// n'est publié que sur 127.0.0.1 de l'hôte (docker-compose.yml).
const HOST = process.env.SYNTRESO_HOST || '127.0.0.1'
app.listen(PORT, HOST, async () => {
  console.log(`Syntréso sur http://${HOST}:${PORT} (données : ${dataDir()})`)
  if (!existsSync(dataPath('company'))) {
    console.warn('[données] base vide : lancez "npm run init" (votre entreprise) ou "npm run demo" (données fictives)')
    return
  }
  try {
    await ensureWorkspace()
    await ensureForecastSnapshot()
    await regenerateDigest()
    await ensureMemoire()
    console.log('[assistant] digest régénéré')
  } catch (err) {
    console.error('[assistant] digest impossible :', err.message)
  }
  const statut = assistantStatus()
  if (!statut.available) {
    console.log(`[assistant] inactif : ${statut.raison}`)
    return
  }
  if (process.env.SYNTRESO_SKIP_PREGEN !== '1') {
    if (await checkClaudeAvailable()) {
      pregenerateContent() // en tâche de fond, sans bloquer le démarrage
    } else {
      console.warn('[assistant] Agent SDK non installé ou exécutable Claude introuvable : assistant indisponible')
    }
  }
})
