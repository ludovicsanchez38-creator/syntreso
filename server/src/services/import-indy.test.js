import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Jeu d'exports Indy FICTIFS (exemples/indy-fictif) : création au 01/09/2025, compte
// bancaire 512000, sous-compte de réserve TVA 512100, rémunération passée par le 644000,
// frais avancés au compte courant 455000. Données de test isolées dans un dossier temporaire.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const EXEMPLES = path.join(ROOT, 'exemples', 'indy-fictif')
const MODELE = path.join(ROOT, 'modeles', 'base-vide')
const TMP = mkdtempSync(path.join(os.tmpdir(), 'syntreso-import-'))
process.env.SYNTRESO_DATA_DIR = path.join(TMP, 'donnees')
process.env.SYNTRESO_REGLAGES = path.join(TMP, 'reglages.json')
writeFileSync(process.env.SYNTRESO_REGLAGES, JSON.stringify({
  indy: {
    comptesBancaires: { courant: ['512'], sousComptes: [{ compte: '512100', role: 'tva', libelle: 'Réserve TVA' }] },
    contreparties: [{ compte: '644', categorie: 'dec_remuneration' }],
  },
}))

const { lireGrandLivre, lireBalance, natureExport, cents, construireImport, executerImport, reperer } = await import('./import-indy.js')
const { lireReglages } = await import('./reglages.js')
const { loadState, project, reconciliation } = await import('./projection.js')

const lire = (nom) => ({ nom, texte: readFileSync(path.join(EXEMPLES, nom), 'utf8') })
const json = (nom) => JSON.parse(readFileSync(path.join(MODELE, `${nom}.json`), 'utf8'))
const existant = () => ({ company: json('company'), categories: json('categories'), forecast: [] })

before(() => {
  const d = process.env.SYNTRESO_DATA_DIR
  mkdirSync(d, { recursive: true })
  for (const n of ['company', 'categories']) copyFileSync(path.join(MODELE, `${n}.json`), path.join(d, `${n}.json`))
  writeFileSync(path.join(d, 'scenarios.json'), '[]')
})

test('lecture CSV : montants à la française, nature des fichiers reconnue au contenu', () => {
  assert.equal(cents('1 234,56'), 123456)
  assert.equal(cents(''), 0)
  assert.equal(natureExport(lire('grand-livre-2026.csv').texte), 'grand-livre')
  assert.equal(natureExport(lire('balance-2026.csv').texte), 'balance')
  const gl = lireGrandLivre(lire('grand-livre-2025.csv').texte)
  assert.equal(gl.premiereDate, '2025-09-01')
  assert.ok(gl.comptes['512000'].lignes.length > 10)
  assert.equal(lireBalance(lire('balance-2026.csv').texte)['512100'], 250_000)
})

test('import complet : réconciliation exacte, sous-compte consolidé, classement par contrepartie', () => {
  const r = construireImport({
    grandsLivres: [lire('grand-livre-2026.csv'), lire('grand-livre-2025.csv')],
    balance: lire('balance-2026.csv'),
    reglages: lireReglages(),
    existant: existant(),
    options: { aujourdhui: '2026-10-05' },
  })
  assert.equal(r.rapport.ouvertureCents, 0) // grands livres depuis la création
  assert.equal(r.rapport.soldeConsolideCents, 1_779_800 + 250_000)
  assert.equal(r.rapport.reconciliation.statut, 'ok')
  assert.equal(r.rapport.reconciliation.deltaCents, 0)
  // les dépôts vers le sous-compte sont des virements internes : ignorés
  assert.ok(!r.transactions.some((t) => /sous-compte/i.test(t.label)))
  // « Virement vers M. Dupont » : rémunération reconnue par le débit 644000 du même jour
  const dupont = r.transactions.filter((t) => /Dupont/.test(t.label))
  assert.equal(dupont.length, 9)
  assert.ok(dupont.every((t) => t.categoryId === 'dec_remuneration'))
  assert.ok(r.transactions.filter((t) => /CLIENT ALPHA/.test(t.label)).every((t) => t.categoryId === 'enc_prestations'))
  assert.equal(r.transactions.find((t) => /Apport/.test(t.label)).categoryId, 'enc_apport')
  // libellés génériques des règles par défaut : forfait télécom et abonnement logiciel
  assert.ok(r.transactions.filter((t) => /TELECOM DURANCE/.test(t.label)).every((t) => t.categoryId === 'dec_telecom'))
  assert.ok(r.transactions.filter((t) => /ABONNEMENT LOGICIEL/.test(t.label)).every((t) => t.categoryId === 'dec_abonnements'))
  // aucun mouvement ne tombe dans la catégorie par défaut avec les réglages fictifs
  assert.deepEqual(r.transactions.filter((t) => /_divers$/.test(t.categoryId)).map((t) => t.label), [])
  // balance : réserve TVA, dette de TVA réelle, compte courant d'associé
  assert.equal(r.company.provisionsHeld.tvaCents, 250_000)
  assert.equal(r.company.fiscal.vatDueActualCents, 680_000 - 140_471)
  assert.equal(r.company.ccaActual.cents, 20_550)
  assert.deepEqual(r.company.fraisCCA.reelParMoisCents, { '2026-03': 12_000, '2026-07': 8_550 })
  assert.equal(r.company.dataAsOf, '2026-09-28')
  assert.equal(r.company.demoToday, undefined)
})

test("import d'un seul exercice : solde d'ouverture relu sur l'extourne de début d'exercice", () => {
  const r = construireImport({
    grandsLivres: [lire('grand-livre-2026.csv')],
    balance: lire('balance-2026.csv'),
    reglages: lireReglages(),
    existant: existant(),
    options: { aujourdhui: '2026-10-05' },
  })
  assert.equal(r.rapport.ouvertureCents, 947_800 + 50_000)
  assert.equal(r.rapport.reconciliation.statut, 'ok')
  assert.equal(r.accounts[0].openingDate, '2026-01-01')
})

test('prévisionnel : médiane des charges récurrentes, TVA et apports non projetés, saisies conservées', () => {
  const base = existant()
  base.forecast = [
    { id: 'fc_2026-11_dec_loyer', month: '2026-11', categoryId: 'dec_loyer', amountCents: -70_000, source: 'user', note: 'hausse de loyer' },
    { id: 'fc_2026-12_dec_divers', month: '2026-12', categoryId: 'dec_divers', amountCents: -1, source: 'indy-import' },
  ]
  const r = construireImport({
    grandsLivres: [lire('grand-livre-2025.csv'), lire('grand-livre-2026.csv')],
    balance: lire('balance-2026.csv'),
    reglages: lireReglages(),
    existant: base,
    options: { aujourdhui: '2026-10-05' },
  })
  const fc = (m, c) => r.forecast.find((f) => f.month === m && f.categoryId === c)
  assert.equal(fc('2026-10', 'dec_loyer').amountCents, -60_000)
  assert.equal(fc('2026-11', 'dec_loyer').source, 'user') // la saisie l'emporte
  assert.equal(fc('2026-11', 'dec_loyer').amountCents, -70_000)
  assert.equal(fc('2026-12', 'dec_divers'), undefined) // ancienne ligne d'import retirée
  assert.equal(r.forecast.filter((f) => f.categoryId === 'dec_tva' || f.categoryId === 'enc_apport').length, 0)
  assert.ok(fc('2026-10', 'enc_prestations').amountCents > 0)
})

test("catégorie inconnue dans les règles : refus explicite avant toute écriture", () => {
  const reglages = lireReglages()
  reglages.indy.reglesCategories = [{ motif: 'loyer', sens: 'sortie', categorie: 'dec_inexistante' }]
  assert.throws(
    () => construireImport({ grandsLivres: [lire('grand-livre-2026.csv')], balance: lire('balance-2026.csv'), reglages, existant: existant() }),
    /dec_inexistante/,
  )
})

test('dossier d\'entrée : exécution réelle, le moteur relit les données importées', async () => {
  const entree = path.join(TMP, 'entree')
  mkdirSync(entree)
  for (const n of ['grand-livre-2025.csv', 'grand-livre-2026.csv', 'balance-2026.csv']) copyFileSync(path.join(EXEMPLES, n), path.join(entree, n))
  writeFileSync(path.join(entree, 'notes.csv'), 'rien;à;voir\n')
  const vus = await reperer(entree)
  assert.equal(vus.grandsLivres.length, 2)
  assert.equal(vus.balance.nom, 'balance-2026.csv')
  assert.ok(vus.ignores.some((i) => i.startsWith('notes.csv')))

  const simu = await executerImport({ dossier: entree, simulation: true, aujourdhui: '2026-10-05' })
  assert.equal(simu.simulation, true)
  assert.throws(() => readFileSync(path.join(process.env.SYNTRESO_DATA_DIR, 'transactions.json')))

  const rapport = await executerImport({ dossier: entree, aujourdhui: '2026-10-05' })
  assert.equal(rapport.reconciliation.statut, 'ok')
  const state = await loadState()
  assert.equal(reconciliation(state).status, 'ok')
  const proj = project(state)
  assert.ok(Number.isInteger(proj.balanceTodayCents))
})
