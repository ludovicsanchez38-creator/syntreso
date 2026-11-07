import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Interrupteur de l'assistant : coupé, AUCUN appel ne part. Preuve en boîte noire : le
// serveur est lancé pour de vrai avec CLAUDE_BIN pointant sur un faux programme Claude
// qui note chacun de ses lancements (arguments et NOMS des variables reçues, jamais leurs
// valeurs). Toutes les routes de l'assistant sont appelées ; le carnet doit rester vide.
// Le dernier test est le témoin : assistant allumé, le faux programme est bien lancé,
// donc la méthode verrait un appel s'il y en avait un. Aucun appel réseau dans ces tests.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const MODELE = path.join(ROOT, 'modeles', 'base-vide')
const BASE = mkdtempSync(path.join(os.tmpdir(), 'syntreso-interrupteur-'))
const CLE_FACTICE = 'cle-factice-de-test-aucun-appel'

function preparerDonnees(dossier) {
  mkdirSync(dossier, { recursive: true })
  const company = JSON.parse(readFileSync(path.join(MODELE, 'company.json'), 'utf8'))
  company.demoToday = '2026-10-15'
  writeFileSync(path.join(dossier, 'company.json'), JSON.stringify(company))
  writeFileSync(path.join(dossier, 'categories.json'), readFileSync(path.join(MODELE, 'categories.json')))
  writeFileSync(path.join(dossier, 'accounts.json'), JSON.stringify([{ id: 'acc_treso', openingBalanceCents: 1_000_000, openingDate: '2026-01-01' }]))
  for (const n of ['transactions', 'forecast', 'invoices', 'scenarios', 'proposals']) writeFileSync(path.join(dossier, `${n}.json`), '[]')
}

function fauxClaude(dossier) {
  const carnet = path.join(dossier, 'lancements.log')
  const prog = path.join(dossier, 'faux-claude')
  writeFileSync(
    prog,
    // note le lancement, puis lit l'entrée jusqu'à ce que le SDK la ferme (fin de délai) :
    // un programme qui mourrait aussitôt ferait tomber le serveur (EPIPE non intercepté
    // dans le SDK, voir la notice du dépôt), ce qui fausserait le témoin.
    `#!/bin/sh\nprintf '%s\\t%s\\n' "$*" "$(env | cut -d= -f1 | sort | tr '\\n' ' ')" >> '${carnet}'\ncat > /dev/null\nexit 1\n`,
  )
  chmodSync(prog, 0o755)
  return { prog, carnet }
}

function portLibre() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms))

async function lancer(nom, { env = {}, reglages } = {}) {
  const dossier = path.join(BASE, nom)
  const donnees = path.join(dossier, 'donnees')
  preparerDonnees(donnees)
  const { prog, carnet } = fauxClaude(dossier)
  const fichierReglages = path.join(dossier, 'reglages.json')
  if (reglages) writeFileSync(fichierReglages, JSON.stringify(reglages))
  const port = await portLibre()
  const jeton = 'jeton-de-test-' + nom
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR || os.tmpdir(),
      SYNTRESO_ENV_FILE: path.join(dossier, 'pas-de-fichier.env'), // ne jamais lire le .env du poste
      SYNTRESO_DATA_DIR: donnees,
      SYNTRESO_REGLAGES: fichierReglages,
      SYNTRESO_PORT: String(port),
      SYNTRESO_JETON: jeton,
      CLAUDE_BIN: prog,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let journal = ''
  proc.stdout.on('data', (d) => (journal += d))
  proc.stderr.on('data', (d) => (journal += d))
  const url = `http://127.0.0.1:${port}`
  const appel = (chemin, init = {}) =>
    fetch(url + chemin, { ...init, headers: { authorization: `Bearer ${jeton}`, 'content-type': 'application/json', ...(init.headers || {}) } })
  const fin = Date.now() + 15_000
  // le démarrage est fini quand le serveur a tranché le sort de l'assistant
  while (!/\[assistant\] (inactif|digest régénéré)/.test(journal)) {
    if (Date.now() > fin || proc.exitCode !== null) throw new Error(`serveur non démarré :\n${journal}`)
    await attendre(50)
  }
  const arreter = () =>
    new Promise((resolve) => {
      if (proc.exitCode !== null) return resolve()
      proc.on('exit', () => resolve())
      proc.kill('SIGTERM')
    })
  const lancements = () => (existsSync(carnet) ? readFileSync(carnet, 'utf8').trim().split('\n').filter(Boolean) : [])
  return { appel, arreter, lancements, journal: () => journal }
}

// Toutes les routes qui font travailler le modèle, plus celle de l'état.
async function solliciterAssistant(appel) {
  const statut = await (await appel('/api/agent/status')).json()
  const codes = {
    ask: (await appel('/api/agent/ask', { method: 'POST', body: JSON.stringify({ question: 'Mon solde ?' }) })).status,
    proactive: (await appel('/api/agent/proactive')).status,
    proactiveRefresh: (await appel('/api/agent/proactive?refresh=1')).status,
    comment: (await appel('/api/agent/comment')).status,
    revue: (await appel('/api/agent/revue-mensuelle?refresh=1')).status,
  }
  await attendre(300) // laisse le temps à un lancement tardif d'apparaître au carnet
  return { statut, codes }
}

function verifierCoupe({ statut, codes }, motif) {
  assert.equal(statut.available, false)
  assert.match(statut.raison, motif)
  for (const [route, code] of Object.entries(codes)) assert.equal(code, 503, `route ${route}`)
}

test('SYNTRESO_ASSISTANT=non : aucun lancement, même avec une clé et au démarrage', async () => {
  const s = await lancer('env-non', { env: { SYNTRESO_ASSISTANT: 'non', ANTHROPIC_API_KEY: CLE_FACTICE } })
  try {
    verifierCoupe(await solliciterAssistant(s.appel), /SYNTRESO_ASSISTANT=non/)
    assert.match(s.journal(), /\[assistant\] inactif/)
    assert.deepEqual(s.lancements(), [])
  } finally {
    await s.arreter()
  }
})

test('réglage assistant.actif=false : aucun lancement, même avec une clé', async () => {
  const s = await lancer('reglage-off', {
    env: { SYNTRESO_ASSISTANT: 'auto', ANTHROPIC_API_KEY: CLE_FACTICE },
    reglages: { assistant: { actif: false } },
  })
  try {
    verifierCoupe(await solliciterAssistant(s.appel), /reglages\.json/)
    assert.deepEqual(s.lancements(), [])
  } finally {
    await s.arreter()
  }
})

test("sans clé d'API : un jeton d'abonnement ou « oui » n'allument rien", async () => {
  const s = await lancer('sans-cle', {
    env: { SYNTRESO_ASSISTANT: 'oui', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: 'jeton-abonnement-factice', ANTHROPIC_AUTH_TOKEN: 'jeton-passerelle-factice' },
  })
  try {
    verifierCoupe(await solliciterAssistant(s.appel), /ANTHROPIC_API_KEY/)
    assert.deepEqual(s.lancements(), [])
  } finally {
    await s.arreter()
  }
})

test('valeur inconnue de SYNTRESO_ASSISTANT : coupé par précaution', async () => {
  const s = await lancer('valeur-inconnue', { env: { SYNTRESO_ASSISTANT: 'peut-etre', ANTHROPIC_API_KEY: CLE_FACTICE } })
  try {
    verifierCoupe(await solliciterAssistant(s.appel), /valeur inconnue/)
    assert.deepEqual(s.lancements(), [])
  } finally {
    await s.arreter()
  }
})

test('témoin : allumé avec une clé, le programme est lancé avec la clé seule comme accès', async () => {
  const s = await lancer('temoin', {
    env: {
      SYNTRESO_ASSISTANT: 'auto',
      SYNTRESO_SKIP_PREGEN: '1',
      SYNTRESO_AGENT_TIMEOUT_MS: '1500', // le faux programme ne répond jamais : délai court
      ANTHROPIC_API_KEY: CLE_FACTICE,
      CLAUDE_CODE_OAUTH_TOKEN: 'jeton-abonnement-factice',
      ANTHROPIC_AUTH_TOKEN: 'jeton-passerelle-factice',
      TWENTY_KEY: 'cle-twenty-factice',
    },
  })
  try {
    const res = await s.appel('/api/agent/ask', { method: 'POST', body: JSON.stringify({ question: 'Mon solde ?' }) })
    assert.equal(res.status, 200)
    assert.match(await res.text(), /délai imparti/) // flux SSE : le faux programme ne répond pas
    const lancements = s.lancements()
    const generation = lancements.find((l) => !l.startsWith('--version'))
    assert.ok(generation, `le faux programme aurait dû être lancé pour la question :\n${lancements.join('\n')}`)
    const variables = generation.split('\t')[1].split(' ')
    assert.ok(variables.includes('ANTHROPIC_API_KEY'))
    for (const interdite of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'SYNTRESO_JETON', 'TWENTY_KEY']) {
      assert.ok(!variables.includes(interdite), `${interdite} ne doit pas être transmise`)
    }
  } finally {
    await s.arreter()
  }
})
