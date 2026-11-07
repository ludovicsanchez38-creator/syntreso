#!/usr/bin/env node
// Crée une base Syntréso vide pour VOTRE entreprise (aucune donnée fictive).
//
//   npm run init                         questions posées une à une
//   npm run init -- --nom "Ma SARL" --secteur "Menuiserie" --ville "Lyon" \
//                   --effectif 3 --seuil 8000 --solde 25000 --tva oui --non-interactif
//   npm run init -- --forcer             remplace une base existante (mise de côté, jamais effacée)
//
// Ensuite : déposez les exports Indy dans entree-indy/ puis lancez « npm run import ».
import '../server/src/env.js'
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import { ROOT } from '../server/src/services/paths.js'
import { addMonths, todayISO } from '../server/src/services/dates.js'
import { dataDir, lireJson, ecrireJson, natureBase, mettreDeCote, prevenirServeur } from './lib/donnees.mjs'

const MODELE = path.join(ROOT, 'modeles', 'base-vide')

function lireArguments(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--forcer') o.forcer = true
    else if (a === '--non-interactif') o.nonInteractif = true
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i]
  }
  return o
}

const euros = (s) => {
  const n = Number(String(s ?? '').replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
const ouiNon = (s, defaut) => {
  const t = String(s ?? '').trim().toLowerCase()
  if (!t) return defaut
  return ['o', 'oui', 'y', 'yes', '1', 'true'].includes(t)
}

const args = lireArguments(process.argv.slice(2))
const dossier = dataDir()
const nature = natureBase(dossier)

if (nature !== 'vide' && !args.forcer) {
  console.error(`Une base ${nature === 'demo' ? 'de démonstration' : 'réelle'} existe déjà dans ${dossier}.`)
  console.error('Relancez avec --forcer pour la remplacer : elle sera mise de côté dans un sous-dossier sauvegarde-..., rien n\'est effacé.')
  process.exit(1)
}

const interactif = process.stdin.isTTY && !args.nonInteractif
const rl = interactif ? createInterface({ input: process.stdin, output: process.stdout }) : null
async function demander(question, valeur, defaut) {
  if (valeur !== undefined) return valeur
  if (!rl) return defaut
  const r = (await rl.question(`${question}${defaut !== undefined && defaut !== '' ? ` [${defaut}]` : ''} : `)).trim()
  return r || defaut
}

const nom = await demander("Nom de l'entreprise", args.nom, 'Mon entreprise')
const secteur = await demander("Secteur d'activité", args.secteur, 'à préciser')
const ville = await demander('Ville', args.ville, 'à préciser')
const effectif = Number(await demander('Nombre de salariés (hors dirigeant)', args.effectif, '0')) || 0
const seuil = euros(await demander('Seuil de sécurité de trésorerie, en euros (alerte en dessous)', args.seuil, '0')) ?? 0
const solde = euros(await demander("Solde bancaire actuel, en euros (remplacé par l'import Indy)", args.solde, '0')) ?? 0
const tva = ouiNon(await demander('Calculer automatiquement la TVA à reverser à partir des flux ? (oui/non)', args.tva, 'oui'), true)
rl?.close()

if (nature !== 'vide') {
  const sauvegarde = mettreDeCote(dossier)
  if (sauvegarde) console.log(`Base précédente mise de côté dans ${sauvegarde}`)
}

const aujourdhui = todayISO()
const moisCourant = aujourdhui.slice(0, 7)
// "+N" dans le modèle = N mois après le mois courant (les bornes des curseurs restent
// relatives et sont résolues à la lecture par l'API).
const resoudre = (v) => (typeof v === 'string' && /^[+-]?\d+$/.test(v) ? addMonths(moisCourant, Number(v)) : v)

const company = lireJson(path.join(MODELE, 'company.json'))
Object.assign(company, { name: nom, sector: secteur, location: ville, employees: effectif, lowCashThresholdCents: seuil })
company.fiscal.tva.autoCompute = tva

const scenarios = lireJson(path.join(MODELE, 'scenarios.json')).map((sc) => ({
  ...sc,
  params: Object.fromEntries(Object.entries(sc.params).map(([k, v]) => [k, /month$/i.test(k) ? resoudre(v) : v])),
}))

ecrireJson(dossier, 'company', company)
ecrireJson(dossier, 'categories', lireJson(path.join(MODELE, 'categories.json')))
ecrireJson(dossier, 'scenarios', scenarios)
ecrireJson(dossier, 'accounts', [{
  id: 'acc_treso',
  label: 'Trésorerie (compte bancaire)',
  openingBalanceCents: solde,
  openingDate: aujourdhui,
}])
for (const n of ['transactions', 'forecast', 'invoices', 'proposals', 'echeances']) ecrireJson(dossier, n, [])

console.log(`Base créée dans ${dossier} pour « ${nom} ».`)
console.log('Étape suivante : déposez vos exports Indy (grand livre + balance) dans entree-indy/ puis lancez « npm run import ».')
if (await prevenirServeur()) console.log('Serveur prévenu.')
