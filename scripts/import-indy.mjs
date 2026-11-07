#!/usr/bin/env node
// Import des exports Indy en ligne de commande.
//
//   npm run import                      importe le dossier entree-indy/
//   npm run import -- --simulation      calcule et affiche le rapport sans rien écrire
//   npm run import -- --dossier ~/Téléchargements
//   npm run import -- --grand-livre gl-2025.csv gl-2026.csv --balance balance-2026.csv
//   npm run import -- --reinitialiser-previsionnel   (repart d'un prévisionnel neuf)
//
// Si le serveur tourne, il est prévenu à la fin pour régénérer le digest de l'assistant.
import '../server/src/env.js'
import { executerImport, rapportTexte } from '../server/src/services/import-indy.js'
import { entreeIndyDir } from '../server/src/services/paths.js'

function lireArguments(argv) {
  const opts = { grandsLivres: [], balance: null, dossier: entreeIndyDir(), simulation: false, reinitialiserPrevisionnel: false }
  let liste = null
  for (const a of argv) {
    if (a === '--simulation') { opts.simulation = true; liste = null }
    else if (a === '--reinitialiser-previsionnel') { opts.reinitialiserPrevisionnel = true; liste = null }
    else if (a === '--grand-livre') liste = 'grandsLivres'
    else if (a === '--balance') liste = 'balance'
    else if (a === '--dossier') liste = 'dossier'
    else if (a === '--aide' || a === '-h' || a === '--help') { opts.aide = true }
    else if (liste === 'grandsLivres') opts.grandsLivres.push(a)
    else if (liste === 'balance') { opts.balance = a; liste = null }
    else if (liste === 'dossier') { opts.dossier = a; liste = null }
    else { console.error(`argument inconnu : ${a}`); process.exit(2) }
  }
  return opts
}

const opts = lireArguments(process.argv.slice(2))
if (opts.aide) {
  console.log('Usage : npm run import -- [--simulation] [--dossier DOSSIER] [--grand-livre F1 F2 ...] [--balance F] [--reinitialiser-previsionnel]')
  process.exit(0)
}

try {
  const rapport = await executerImport(opts)
  console.log(rapportTexte(rapport))
  if (!rapport.simulation) await prevenirServeur()
  process.exit(rapport.reconciliation.statut === 'ok' ? 0 : 3)
} catch (err) {
  console.error(`Import impossible : ${err.message}`)
  process.exit(1)
}

// Best effort : le serveur relit les fichiers à chaque requête, mais le digest de
// l'assistant ne se régénère que sur un signal.
async function prevenirServeur() {
  const jeton = process.env.SYNTRESO_JETON
  const port = Number(process.env.SYNTRESO_PORT) || 3900
  if (!jeton) return
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/agent/digest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jeton}` },
      signal: AbortSignal.timeout(5000),
    })
    if (r.ok) console.log('Serveur prévenu (digest de l\'assistant régénéré).')
  } catch {
    console.log('Serveur arrêté : le digest sera régénéré au prochain démarrage.')
  }
}
