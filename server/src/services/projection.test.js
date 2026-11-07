import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  project, retainedFor, scenarioDeltas, actualsByMonth, forecastByMonth,
  addMonths, addDays, monthRange, balanceAt, loadState, forecastGrid,
  monthOf, dataFreshness, kpis, mergeDeltas, computeRunway, reconciliation, todayFor,
  seasonalityDeltas,
} from './projection.js'
import { HORIZON_MONTHS, HISTORY_MONTHS, horizonEnd, gridStart } from './horizon.js'
import {
  vatForMonth, socialProvisionForMonth, tnsRatePctForMonth, derivedFiscalDeltas,
  breakEvenMonthly, resultatPrevisionnel, estimateIS, remunerationVsDividendes,
  compteResultatMensuel,
} from './fiscal.js'
import { remunerationCheck, forecastImpact, compareRemunerationDividendes } from './decision.js'
import { buildDossierHTML } from './export-dossier.js'
import { computeAlerts } from './alerts.js'

// Les tests "données seedées" valident le couple seed démo -> moteur. On seede la
// démo Maçonnerie des Trois Collines dans un dossier TEMPORAIRE et on y pointe loadState via
// SYNTRESO_DATA_DIR, pour rester déterministe quelles que soient les données qui
// vivent dans le dossier donnees/ (par exemple les vraies données).
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SEED_SCRIPT = path.resolve(HERE, '../../../scripts/generate-data.mjs')
let demoDir
let prevDataDir
before(() => {
  demoDir = mkdtempSync(path.join(os.tmpdir(), 'syntreso-demo-'))
  execFileSync('node', [SEED_SCRIPT], { env: { ...process.env, SYNTRESO_DATA_DIR: demoDir }, stdio: 'ignore' })
  prevDataDir = process.env.SYNTRESO_DATA_DIR
  process.env.SYNTRESO_DATA_DIR = demoDir
})
after(() => {
  if (prevDataDir === undefined) delete process.env.SYNTRESO_DATA_DIR
  else process.env.SYNTRESO_DATA_DIR = prevDataDir
  if (demoDir) rmSync(demoDir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ Fixture synthétique
// Entreprise minimale : 1 compte, 2 catégories, 3 mois (avril passé, mai courant, juin futur).
const CATS = [
  { id: 'in_ventes', label: 'Ventes', direction: 'in', order: 1 },
  { id: 'out_charges', label: 'Charges', direction: 'out', order: 2 },
]
const FIXTURE = {
  company: { demoToday: '2026-05-10', lowCashThresholdCents: 100_000 },
  accounts: [{ id: 'acc', openingBalanceCents: 1_000_00, openingDate: '2026-04-01' }],
  categories: CATS,
  transactions: [
    { id: 't1', date: '2026-04-05', categoryId: 'in_ventes', amountCents: 500_00 },
    { id: 't2', date: '2026-04-20', categoryId: 'out_charges', amountCents: -300_00 },
    { id: 't3', date: '2026-05-03', categoryId: 'in_ventes', amountCents: 200_00 },
    { id: 't4', date: '2026-05-08', categoryId: 'out_charges', amountCents: -150_00 },
  ],
  invoices: [
    { id: 'inv1', clientName: 'Client X', amountCents: 400_00, dueDate: '2026-05-01', status: 'overdue', expectedPaymentDate: '2026-05-25' },
  ],
  forecast: [
    { id: 'f1', month: '2026-05', categoryId: 'in_ventes', amountCents: 600_00 },
    { id: 'f2', month: '2026-05', categoryId: 'out_charges', amountCents: -400_00 },
    { id: 'f3', month: '2026-06', categoryId: 'in_ventes', amountCents: 700_00 },
    { id: 'f4', month: '2026-06', categoryId: 'out_charges', amountCents: -500_00 },
  ],
  scenarios: [
    { id: 'sc_embauche', params: { startMonth: '2026-06', monthlyCostCents: 100_00, oneOffCents: 50_00 } },
    { id: 'sc_invest', params: { month: '2026-06', amountCents: 100_000, mode: 'leasing' } },
    { id: 'sc_retard', params: { invoiceId: 'inv1', delayDays: 30 } },
  ],
}

test('règle des montants retenus : passé / courant / futur', () => {
  const actuals = actualsByMonth(FIXTURE.transactions)
  const forecasts = forecastByMonth(FIXTURE.forecast)
  const current = '2026-05'
  // passé : réalisé seul (le prévu est ignoré)
  assert.equal(retainedFor('2026-04', CATS[0], actuals, forecasts, current), 500_00)
  // courant, entrées : réalisé 200 + max(0, 600-200) = 600
  assert.equal(retainedFor('2026-05', CATS[0], actuals, forecasts, current), 600_00)
  // courant, sorties : réalisé -150 + min(0, -400-(-150)) = -400
  assert.equal(retainedFor('2026-05', CATS[1], actuals, forecasts, current), -400_00)
  // courant, réalisé dépasse le prévu (entrées) : on garde le réalisé
  const moreActuals = { '2026-05': { in_ventes: 800_00 } }
  assert.equal(retainedFor('2026-05', CATS[0], moreActuals, forecasts, current), 800_00)
  // futur : prévu seul
  assert.equal(retainedFor('2026-06', CATS[0], actuals, forecasts, current), 700_00)
})

test('projection : soldes cohérents sur la fixture', () => {
  const proj = project(FIXTURE)
  // solde aujourd'hui : 1000 + 500 - 300 + 200 - 150 = 1250
  assert.equal(proj.balanceTodayCents, 1_250_00)
  // fin mai : avril réalisé (+200) + mai retenu (600-400=200) => 1000+200+200 = 1400
  const may = proj.series.find((p) => p.date === '2026-05-31')
  assert.equal(may.projectedCents, 1_400_00)
  // fin juin : 1400 + (700-500) = 1600
  const june = proj.series.find((p) => p.date === '2026-06-30')
  assert.equal(june.projectedCents, 1_600_00)
  // la série réalisée s'arrête à demoToday et le raccord porte les deux valeurs
  const lastActual = proj.series.filter((p) => p.actualCents !== null).at(-1)
  assert.equal(lastActual.date, '2026-05-10')
  assert.equal(lastActual.projectedCents, proj.balanceTodayCents)
})

test('table mensuelle : ouverture + entrées + sorties = clôture, chaînage des mois', () => {
  const proj = project(FIXTURE)
  let prevClosing = null
  for (const m of proj.monthly) {
    assert.equal(m.openingCents + m.inCents + m.outCents, m.closingCents, m.month)
    if (prevClosing !== null) assert.equal(m.openingCents, prevClosing, `ouverture ${m.month}`)
    prevClosing = m.closingCents
  }
  // avril : entrées 500, sorties -300
  const april = proj.monthly.find((m) => m.month === '2026-04')
  assert.equal(april.inCents, 500_00)
  assert.equal(april.outCents, -300_00)
  assert.equal(april.projected, false)
})

test('scénario embauche : coût mensuel + équipement initial', () => {
  const deltas = scenarioDeltas(FIXTURE.scenarios, ['sc_embauche'], FIXTURE)
  // juin : one-off 50 + mensuel 100
  assert.equal(deltas['2026-06'].dec_salaires, -(150_00))
  const proj = project(FIXTURE, { deltas })
  const june = proj.series.find((p) => p.date === '2026-06-30')
  assert.equal(june.projectedCents, 1_600_00 - 150_00)
})

test('scénario leasing : mensualité arrondie aux centimes entiers', () => {
  const deltas = scenarioDeltas(FIXTURE.scenarios, ['sc_invest'], FIXTURE)
  // 100 000 centimes / 36 mois = 2 777,78 centimes -> arrondi à l'euro = 2 800 centimes
  assert.equal(deltas['2026-06'].dec_leasing, -2800)
  assert.ok(Object.values(deltas).flatMap((d) => Object.values(d)).every(Number.isInteger))
})

test('scénario retard : le montant glisse du mois attendu vers le mois décalé', () => {
  const deltas = scenarioDeltas(FIXTURE.scenarios, ['sc_retard'], FIXTURE)
  // attendu le 25/05, +30 j => 24/06 : -400 en mai, +400 en juin
  assert.equal(deltas['2026-05'].enc_chantiers, -400_00)
  assert.equal(deltas['2026-06'].enc_chantiers, 400_00)
  // le solde final ne change pas (le retard déplace, ne supprime pas)
  const base = project(FIXTURE)
  const delayed = project(FIXTURE, { deltas })
  assert.equal(base.series.at(-1).projectedCents, delayed.series.at(-1).projectedCents)
})

test('utilitaires dates', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01')
  assert.equal(addMonths('2026-01', -1), '2025-12')
  assert.equal(addDays('2026-05-31', 1), '2026-06-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.deepEqual(monthRange('2026-11', '2027-01'), ['2026-11', '2026-12', '2027-01'])
})

// ------------------------------------------------------------------ Horizon glissant
test('horizon : bornes dérivées du mois courant, plus de date en dur', () => {
  // horizonEnd = currentMonth + HORIZON_MONTHS ; gridStart = currentMonth - HISTORY_MONTHS
  assert.equal(horizonEnd('2026-06'), addMonths('2026-06', HORIZON_MONTHS))
  assert.equal(gridStart('2026-06'), addMonths('2026-06', -HISTORY_MONTHS))
  // glissant : un mois courant différent décale tout sans valeur figée
  assert.equal(horizonEnd('2027-01'), addMonths('2027-01', HORIZON_MONTHS))
  assert.equal(gridStart('2027-01'), addMonths('2027-01', -HISTORY_MONTHS))
})

test('horizon : la projection couvre jusqu\'à currentMonth + HORIZON_MONTHS', () => {
  const proj = project(FIXTURE)
  const current = monthOf(FIXTURE.company.demoToday) // 2026-05
  const end = horizonEnd(current)
  // le dernier point mensuel de la table atteint l'horizon (et pas une date figée)
  const lastMonth = proj.monthly.at(-1).month
  assert.equal(lastMonth, end)
  // au-delà du forecast (qui s'arrête à 2026-06), le solde reste plat : pas de NaN,
  // pas de boucle. On vérifie juste que la série projetée va bien jusqu'à fin d'horizon.
  const lastProjected = proj.series.filter((p) => p.projectedCents !== null).at(-1)
  assert.equal(lastProjected.date.slice(0, 7), end)
  assert.ok(Number.isInteger(lastProjected.projectedCents))
})

test('horizon : scenarioDeltas borne ses récurrences sur l\'horizon glissant', () => {
  // un scénario mensuel ne doit pas générer de delta au-delà de l'horizon courant
  const deltas = scenarioDeltas(FIXTURE.scenarios, ['sc_embauche'], FIXTURE)
  const end = horizonEnd(monthOf(FIXTURE.company.demoToday))
  for (const ym of Object.keys(deltas)) {
    assert.ok(ym <= end, `delta hors horizon : ${ym} > ${end}`)
  }
})

// ------------------------------------------------------------------ Fraîcheur des données
test('dataFreshness : niveaux orange (>10j) / rouge (>30j) calculés contre demoToday', () => {
  const company = {
    demoToday: '2026-06-10',
    importedAt: {
      frais: '2026-06-05', // 5 j -> fresh
      limite: '2026-05-31', // 10 j -> encore fresh (seuil strict > 10)
      orange: '2026-05-25', // 16 j -> warn
      rouge: '2026-04-01', // 70 j -> stale
    },
  }
  const f = dataFreshness(company)
  assert.equal(f.frais.level, 'fresh')
  assert.equal(f.frais.daysOld, 5)
  assert.equal(f.limite.level, 'fresh')
  assert.equal(f.orange.level, 'warn')
  assert.equal(f.rouge.level, 'stale')
})

test('dataFreshness : source absente ou importedAt manquant -> unknown (pas d\'alerte trompeuse)', () => {
  assert.deepEqual(dataFreshness({ demoToday: '2026-06-10' }), {})
  const f = dataFreshness({ demoToday: '2026-06-10', importedAt: { indy: null, twenty: '2026-06-09' } })
  assert.equal(f.indy.level, 'unknown')
  assert.equal(f.indy.date, null)
  assert.equal(f.twenty.level, 'fresh')
})

// ------------------------------------------------------------------ todayFor (date réelle vs demoToday)
test('todayFor : demoToday si présent (démo figée), sinon la date réelle du jour', () => {
  assert.equal(todayFor({ demoToday: '2026-06-10' }), '2026-06-10')
  const real = todayFor({})
  assert.match(real, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(real, new Date().toISOString().slice(0, 10))
  assert.equal(todayFor(undefined), real)
})

test('dataFreshness sans demoToday : l\'âge se mesure contre la vraie date -> le bandeau vieillit entre deux imports', () => {
  const today = new Date().toISOString().slice(0, 10)
  const f = dataFreshness({ importedAt: { indy: addDays(today, -15), twenty: today } })
  assert.equal(f.indy.daysOld, 15)
  assert.equal(f.indy.level, 'warn')
  assert.equal(f.twenty.daysOld, 0)
  assert.equal(f.twenty.level, 'fresh')
})

// ------------------------------------------------------------------ Coeur comptable (lot 2)
// Fixture fictive, dirigeant TNS seul, avec TVA et provision URSSAF dérivées, pour des
// assertions déterministes (montants ronds choisis pour des calculs vérifiables à la main).
// demoToday mai 2026 : courant = 2026-05. Forecast posé en juin/juillet.
const FISCAL_FIXTURE = () => ({
  company: {
    demoToday: '2026-05-10',
    lowCashThresholdCents: 100_000,
    fiscal: {
      vatRatePct: 20,
      amountsAreTTC: true,
      tva: { autoCompute: true, payDayOfMonth: 22 },
      tns: {
        autoCompute: true,
        remunerationCategoryId: 'dec_rem',
        provisionCategoryId: 'dec_urssaf',
        cotisationTauxPct: 40,
        cotisationTauxApresAcrePct: 45,
        acre: { actif: true, tauxPct: 25, finMois: '2026-06' },
      },
    },
  },
  accounts: [{ id: 'acc', openingBalanceCents: 1_000_000, openingDate: '2026-04-01' }],
  categories: [
    { id: 'enc_presta', label: 'Prestations', direction: 'in', order: 1, vatRatePct: 20 },
    { id: 'dec_achats', label: 'Achats', direction: 'out', order: 2, vatRatePct: 20, fixed: false },
    { id: 'dec_rem', label: 'Rémunération gérant', direction: 'out', order: 3, vatRatePct: 0, fixed: true },
    { id: 'dec_urssaf', label: 'URSSAF', direction: 'out', order: 4, vatRatePct: 0, fixed: true },
    { id: 'dec_tva', label: 'TVA à reverser', direction: 'out', order: 5, vatRatePct: 0, fixed: false },
  ],
  transactions: [
    { id: 't1', date: '2026-04-10', categoryId: 'enc_presta', amountCents: 1_200_000 },
  ],
  invoices: [],
  forecast: [
    // Juin : 12 000 TTC encaissés, 1 200 TTC d'achats, rému 2 000, URSSAF en dur 999 (à neutraliser), TVA en dur -888 (à neutraliser)
    { id: 'f1', month: '2026-06', categoryId: 'enc_presta', amountCents: 1_200_000 },
    { id: 'f2', month: '2026-06', categoryId: 'dec_achats', amountCents: -120_000 },
    { id: 'f3', month: '2026-06', categoryId: 'dec_rem', amountCents: -200_000 },
    { id: 'f4', month: '2026-06', categoryId: 'dec_urssaf', amountCents: -99_900 },
    { id: 'f5', month: '2026-06', categoryId: 'dec_tva', amountCents: -88_800 },
    // Juillet : rému 2 000 (taux après ACRE attendu car fin ACRE = juin)
    { id: 'f6', month: '2026-07', categoryId: 'dec_rem', amountCents: -200_000 },
  ],
  scenarios: [
    { id: 'sc_rem_up', params: { startMonth: '2026-06', extraMonthlyCents: 100_000 } },
  ],
})

test('TVA : collectée - déductible, TTC, sur les bons sens de flux', () => {
  const state = FISCAL_FIXTURE()
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  // Juin : collectée sur 1 200 000 TTC à 20% = 200 000 ; déductible sur 120 000 TTC = 20 000
  const v = vatForMonth('2026-06', state, actuals, forecasts, '2026-05')
  assert.equal(v.collectedCents, 200_000)
  assert.equal(v.deductibleCents, 20_000)
  assert.equal(v.dueCents, 180_000)
})

test('TVA dérivée : posée le mois M+1 sur dec_tva et neutralise le forecast en dur', () => {
  const state = FISCAL_FIXTURE()
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const { deltas, vatDueByMonth } = derivedFiscalDeltas(state, { actuals, forecasts, currentMonth: '2026-05' })
  // la TVA due de juin (180 000) se paie en juillet
  assert.equal(vatDueByMonth['2026-07'], 180_000)
  // sur juillet : neutralisation du forecast dec_tva (il n'y en a pas en juillet) + pose -180 000
  assert.equal(deltas['2026-07'].dec_tva, -180_000)
  // tous les deltas restent des centimes entiers
  assert.ok(Object.values(deltas).flatMap((d) => Object.values(d)).every(Number.isInteger))
})

test('TVA dérivée : la ligne dec_tva en dur du forecast est annulée (pas de double comptage)', () => {
  const state = FISCAL_FIXTURE()
  // Ajoutons une activité en mai pour que la TVA de mai se paie en juin et neutralise f5 (-88 800)
  state.transactions.push({ id: 't2', date: '2026-05-05', categoryId: 'enc_presta', amountCents: 600_000 })
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const { deltas } = derivedFiscalDeltas(state, { actuals, forecasts, currentMonth: '2026-05' })
  // juin reçoit : annulation du forecast en dur (+88 800) puis pose de la TVA dérivée de mai
  // mai courant retenu enc_presta = réalisé 600 000 (pas de forecast mai) -> TVA due = 100 000
  // delta juin dec_tva = +88 800 (annulation) - 100 000 (dérivée) = -11 200
  assert.equal(deltas['2026-06'].dec_tva, 88_800 - 100_000)
})

test('TVA : montants HT -> tva = montant x taux/100 (pas de division par 1,2)', () => {
  const state = FISCAL_FIXTURE()
  state.company.fiscal.amountsAreTTC = false
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  // HT : collectée sur 1 200 000 a 20% = 240 000 ; deductible sur 120 000 = 24 000
  const v = vatForMonth('2026-06', state, actuals, forecasts, '2026-05')
  assert.equal(v.collectedCents, 240_000)
  assert.equal(v.deductibleCents, 24_000)
  assert.equal(v.dueCents, 216_000)
})

test('TVA : le reversement du mois courant déjà payé (jour passé) n\'est pas re-posé', () => {
  const state = FISCAL_FIXTURE()
  // demoToday = 2026-05-10, payDay = 22 -> pas encore payé, le reversement de mai (en juin) est futur
  // On force un jour après le 22 : la TVA dont le paiement tomberait en mai (activité d'avril)
  // est déjà réalisée -> aucun delta sur le mois courant.
  state.company.demoToday = '2026-05-25'
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const { deltas } = derivedFiscalDeltas(state, { actuals, forecasts, currentMonth: '2026-05' })
  // aucun reversement posé sur le mois courant (2026-05)
  assert.equal(deltas['2026-05']?.dec_tva, undefined)
})

test('URSSAF : provision = rému du mois x taux effectif, bascule au mois suivant la fin ACRE', () => {
  const state = FISCAL_FIXTURE()
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  // fin ACRE = 2026-06 -> juin à 40%, juillet à 45%
  assert.equal(tnsRatePctForMonth('2026-06', state.company.fiscal.tns), 40)
  assert.equal(tnsRatePctForMonth('2026-07', state.company.fiscal.tns), 45)
  // rému 2 000 EUR : juin = 800 EUR (40%), juillet = 900 EUR (45%)
  assert.equal(socialProvisionForMonth('2026-06', state, actuals, forecasts, '2026-05'), 80_000)
  assert.equal(socialProvisionForMonth('2026-07', state, actuals, forecasts, '2026-05'), 90_000)
})

test('URSSAF dérivée : neutralise la moyenne morte du forecast et pose la provision pilotée', () => {
  const state = FISCAL_FIXTURE()
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  const { deltas, socialByMonth } = derivedFiscalDeltas(state, { actuals, forecasts, currentMonth: '2026-05' })
  assert.equal(socialByMonth['2026-06'], 80_000)
  // juin : annulation du forecast en dur (-99 900 -> +99 900) puis pose -80 000 = +19 900
  assert.equal(deltas['2026-06'].dec_urssaf, 99_900 - 80_000)
})

test('scénario sc_rem_up : pousse la rému ET le delta cotisations couplé (sinon il ment)', () => {
  const state = FISCAL_FIXTURE()
  const deltas = scenarioDeltas(state.scenarios, ['sc_rem_up'], state)
  // juin : +100 000 de rému en sortie -> -100 000 sur dec_rem, et cotisations couplées à 40% -> -40 000 sur dec_urssaf
  assert.equal(deltas['2026-06'].dec_rem, -100_000)
  assert.equal(deltas['2026-06'].dec_urssaf, -40_000)
  // juillet : taux après ACRE 45% -> -45 000 de cotisations couplées
  assert.equal(deltas['2026-07'].dec_urssaf, -45_000)
})

test('mergeDeltas : addition par (mois, catégorie), sans muter les sources', () => {
  const a = { '2026-06': { dec_tva: -100 } }
  const b = { '2026-06': { dec_tva: -50, dec_urssaf: -10 }, '2026-07': { dec_tva: -5 } }
  const m = mergeDeltas(a, b)
  assert.equal(m['2026-06'].dec_tva, -150)
  assert.equal(m['2026-06'].dec_urssaf, -10)
  assert.equal(m['2026-07'].dec_tva, -5)
  // sources intactes
  assert.equal(a['2026-06'].dec_tva, -100)
})

test('solde NET : committed = TVA due + provision, net = brut - committed (3 mois)', () => {
  const state = FISCAL_FIXTURE()
  const proj = project(state)
  const k = kpis(state, proj)
  // les sous-composantes sont positives (montant réservé)
  assert.ok(proj.vatDueCents >= 0)
  assert.ok(proj.socialProvisionCents > 0)
  assert.equal(proj.committedCents, proj.vatDueCents + proj.socialProvisionCents)
  assert.equal(proj.netAvailableCents, proj.balanceTodayCents - proj.committedCents)
  // alias français exposés et cohérents
  assert.equal(k.soldeNetDisponibleCents, proj.netAvailableCents)
  assert.equal(k.tvaAReverserCents, proj.vatDueCents)
  assert.equal(k.cotisationsProvisionneesCents, proj.socialProvisionCents)
})

test('inactif : autoCompute off -> committed 0 et net = brut (additif et réversible)', () => {
  const state = FISCAL_FIXTURE()
  state.company.fiscal.tva.autoCompute = false
  state.company.fiscal.tns.autoCompute = false
  const proj = project(state)
  assert.equal(proj.committedCents, 0)
  assert.equal(proj.vatDueCents, 0)
  assert.equal(proj.socialProvisionCents, 0)
  assert.equal(proj.netAvailableCents, proj.balanceTodayCents)
})

test('seuil sur le NET : alerte si le brut couvre mais le net passe dessous', () => {
  const state = FISCAL_FIXTURE()
  // seuil entre net et brut : brut 1 000 000, on choisit un seuil que seul le net franchit
  const proj = project(state)
  assert.ok(proj.committedCents > 0, 'la fixture doit engager de la trésorerie')
  state.company.lowCashThresholdCents = proj.balanceTodayCents - Math.round(proj.committedCents / 2)
  const proj2 = project(state)
  const alerts = computeAlerts(state, proj2)
  const netAlert = alerts.find((a) => a.kind === 'net_below_threshold')
  assert.ok(netAlert, 'une alerte net_below_threshold doit être émise')
  assert.equal(netAlert.amountCents, proj2.netAvailableCents)
})

// ------------------------------------------------------------------ Décision (lot 2 décision)
// Fixture « gérant TNS solo » avec un historique de 6 mois clos déficitaires pour que
// le burn et le point mort soient déterministes. demoToday = mois courant juillet 2026.
// Chaque mois clos (janv-juin) : encaissé 10 000, charges fixes 8 000 -> net +2 000 ?
// Pour avoir un burn, on rend certains mois déficitaires (charges variables ponctuelles).
const DECISION_FIXTURE = () => {
  const company = {
    demoToday: '2026-07-10',
    lowCashThresholdCents: 500_000, // 5 000 EUR
    fiscal: {
      vatRatePct: 20,
      amountsAreTTC: true,
      tva: { autoCompute: false }, // on isole le runway/point mort de la TVA dérivée
      tns: {
        autoCompute: true,
        remunerationCategoryId: 'dec_rem',
        provisionCategoryId: 'dec_urssaf',
        cotisationTauxPct: 40,
        cotisationTauxApresAcrePct: 45,
        acre: { actif: true, tauxPct: 25, finMois: '2026-09' },
      },
    },
  }
  const categories = [
    { id: 'enc_presta', label: 'Prestations', direction: 'in', order: 1, vatRatePct: 20, fixed: false },
    { id: 'dec_serveurs', label: 'Serveurs & abos', direction: 'out', order: 2, vatRatePct: 20, fixed: true },
    { id: 'dec_rem', label: 'Rémunération gérant', direction: 'out', order: 3, vatRatePct: 0, fixed: true },
    { id: 'dec_urssaf', label: 'URSSAF', direction: 'out', order: 4, vatRatePct: 0, fixed: true },
    { id: 'dec_achats', label: 'Achats ponctuels', direction: 'out', order: 5, vatRatePct: 20, fixed: false },
  ]
  // 6 mois clos (janv-juin 2026). Charges fixes constantes : serveurs 1 200 TTC,
  // rému 3 000, URSSAF 1 200. Encaissements variables. 3 mois déficitaires.
  const transactions = []
  const closed = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']
  const encByMonth = [800_000, 200_000, 900_000, 150_000, 850_000, 100_000] // 3 bas
  closed.forEach((ym, i) => {
    transactions.push({ id: `e${i}`, date: `${ym}-15`, categoryId: 'enc_presta', amountCents: encByMonth[i] })
    transactions.push({ id: `s${i}`, date: `${ym}-05`, categoryId: 'dec_serveurs', amountCents: -120_000 })
    transactions.push({ id: `r${i}`, date: `${ym}-28`, categoryId: 'dec_rem', amountCents: -300_000 })
    transactions.push({ id: `u${i}`, date: `${ym}-05`, categoryId: 'dec_urssaf', amountCents: -120_000 })
  })
  return {
    company,
    accounts: [{ id: 'acc', openingBalanceCents: 2_000_000, openingDate: '2026-01-01' }],
    categories,
    transactions,
    invoices: [],
    forecast: [],
    scenarios: [],
  }
}

test('runway : burn = moyenne des mois clos déficitaires, runway = net / burn', () => {
  const state = DECISION_FIXTURE()
  const actuals = actualsByMonth(state.transactions)
  const proj = project(state)
  const r = computeRunway(state, { actuals, currentMonth: '2026-07', netAvailableCents: proj.netAvailableCents })
  // mois nets : enc - (serveurs 1200 + rém 3000 + URSSAF 1200 = 5400)
  //  jan +2600, fév -3400, mar +3600, avr -3900, mai +3100, juin -4400
  // déficits : 3400, 3900, 4400 -> moyenne = 3900 (390 000 cents)
  assert.equal(r.monthlyBurnNetCents, 390_000)
  // runway = net / burn, arrondi 1 décimale, > 0
  assert.ok(r.runwayMonths > 0)
  assert.equal(r.runwayMonths, Math.round((proj.netAvailableCents / 390_000) * 10) / 10)
  // worst-case (charges fixes 5 400 / mois) <= runway lissé (burn plus petit que charges fixes ? non)
  assert.ok(r.runwayWorstCaseMonths > 0)
})

test('runway : aucun mois déficitaire -> burn 0 et runwayMonths null (pas d\'infini inventé)', () => {
  const state = DECISION_FIXTURE()
  // on rend tous les mois excédentaires : encaissements hauts partout
  state.transactions = state.transactions.map((t) =>
    t.categoryId === 'enc_presta' ? { ...t, amountCents: 900_000 } : t,
  )
  const actuals = actualsByMonth(state.transactions)
  const proj = project(state)
  const r = computeRunway(state, { actuals, currentMonth: '2026-07', netAvailableCents: proj.netAvailableCents })
  assert.equal(r.monthlyBurnNetCents, 0)
  assert.equal(r.runwayMonths, null)
})

test('runway exposé dans kpis et project', () => {
  const state = DECISION_FIXTURE()
  const proj = project(state)
  const k = kpis(state, proj)
  assert.equal(k.runwayMonths, proj.runwayMonths)
  assert.equal(k.monthlyBurnNetCents, proj.monthlyBurnNetCents)
  assert.equal(typeof k.runwayWorstCaseMonths, typeof proj.runwayWorstCaseMonths)
})

test('point mort : somme des charges fixes HT moyennées (cat.fixed)', () => {
  const state = DECISION_FIXTURE()
  const actuals = actualsByMonth(state.transactions)
  const be = breakEvenMonthly(state, actuals, '2026-07')
  // charges fixes : serveurs 1200 TTC à 20% -> HT 1000 ; rém 3000 (taux 0) ; URSSAF 1200 (taux 0)
  // total HT = 1000 + 3000 + 1200 = 5200 EUR -> 520 000 cents
  assert.equal(be.breakEvenHTCents, 520_000)
  assert.deepEqual(be.fixedCategoryIds.sort(), ['dec_rem', 'dec_serveurs', 'dec_urssaf'])
  assert.equal(be.byCategory.dec_serveurs, 100_000) // 1 000 HT
})

test('IS : barème 15% jusqu\'au seuil puis 25% au-delà (paramétrable)', () => {
  const is = { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 }
  // bénéfice 30 000 EUR < seuil 42 500 -> 15% = 4 500 EUR
  assert.deepEqual(estimateIS(3_000_000, is), { isCents: 450_000, bracket: 'réduit' })
  // bénéfice 50 000 EUR -> 15% sur 42 500 (6 375) + 25% sur 7 500 (1 875) = 8 250 EUR
  assert.deepEqual(estimateIS(5_000_000, is), { isCents: 825_000, bracket: 'réduit+normal' })
  // bénéfice nul ou négatif -> 0
  assert.deepEqual(estimateIS(0, is), { isCents: 0, bracket: 'aucun' })
  assert.deepEqual(estimateIS(-100, is), { isCents: 0, bracket: 'aucun' })
  // is absent -> pas d'hypothèse inventée
  assert.deepEqual(estimateIS(5_000_000, undefined), { isCents: 0, bracket: 'aucun' })
})

test('résultat prévisionnel : produits HT - charges HT - IS, exclut la TVA', () => {
  const state = DECISION_FIXTURE()
  const actuals = actualsByMonth(state.transactions)
  const forecasts = forecastByMonth(state.forecast)
  state.company.fiscal.is = { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 }
  const r = resultatPrevisionnel(state, { actuals, forecasts, currentMonth: '2026-07' }, '2026')
  // produits : 6 mois d'encaissements TTC à 20% -> HT. enc total TTC = 3 000 000 -> HT 2 500 000
  assert.equal(r.productsHTCents, 2_500_000)
  // charges : serveurs 6x1200 TTC -> HT 6 000 (-600 000) ; rém 6x3000 (-1 800 000) ; URSSAF 6x1200 (-720 000)
  // total charges HT = -(600 000 + 1 800 000 + 720 000) = -3 120 000
  assert.equal(r.chargesHTCents, -3_120_000)
  assert.equal(r.resultatAvantISCents, 2_500_000 - 3_120_000) // déficitaire
  // résultat négatif -> IS 0
  assert.equal(r.isProvisionCents, 0)
  assert.equal(r.resultatApresISCents, r.resultatAvantISCents)
})

test('résultat prévisionnel exposé dans kpis', () => {
  const state = DECISION_FIXTURE()
  state.company.fiscal.is = { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 }
  const proj = project(state)
  const k = kpis(state, proj)
  assert.equal(k.resultatPrevisionnel.exerciseYear, '2026')
  assert.ok(typeof k.resultatPrevisionnel.resultatApresISCents === 'number')
  assert.ok(typeof k.breakEvenHTCents === 'number')
})

test('compte de résultat mensuel : somme des mois = total annuel + cohérent avec resultatPrevisionnel', async () => {
  const state = await loadState()
  const currentMonth = monthOf(state.company.demoToday)
  const year = currentMonth.slice(0, 4)
  const ctx = {
    actuals: actualsByMonth(state.transactions),
    forecasts: forecastByMonth(state.forecast),
    currentMonth,
  }
  const m = compteResultatMensuel(state, ctx, year)
  assert.equal(m.months.length, 12)
  // réconciliation : la somme des mois égale le total annuel, au centime
  assert.equal(m.months.reduce((s, ym) => s + m.parMois[ym].produitsHTCents, 0), m.totalProduitsHTCents)
  assert.equal(m.months.reduce((s, ym) => s + m.parMois[ym].chargesHTCents, 0), m.totalChargesHTCents)
  assert.equal(m.totalProduitsHTCents + m.totalChargesHTCents, m.resultatAvantISCents)
  // une seule vérité : l'agrégat annuel (PDF banquier, assistant) lit le même calcul
  const annuel = resultatPrevisionnel(state, ctx, year)
  assert.equal(annuel.productsHTCents, m.totalProduitsHTCents)
  assert.equal(annuel.chargesHTCents, m.totalChargesHTCents)
  assert.equal(annuel.resultatApresISCents, m.resultatApresISCents)
})

test('compte de résultat : rému attribuée en CCA comptée en charge même sans flux cash', () => {
  // État minimal autonome (indépendant du jeu de démo) : rému en CCA, aucun flux cash.
  const state = {
    company: {
      demoToday: '2026-06-15',
      fiscal: {
        amountsAreTTC: true,
        is: { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 },
        tva: { autoCompute: true, categoryId: 'dec_tva' },
        tns: {
          autoCompute: true,
          remunerationCategoryId: 'dec_rem',
          provisionCategoryId: 'dec_urssaf',
          remunerationMensuelleBruteCents: 150_000,
          remunerationEnCcaJusquau: '2026-12',
          cotisationTauxPct: 40,
        },
      },
    },
    accounts: [{ openingBalanceCents: 0, openingDate: '2026-01-01' }],
    categories: [
      { id: 'enc_presta', label: 'Prestations', direction: 'in', vatRatePct: 20 },
      { id: 'enc_apport', label: 'Apport capital', direction: 'in', vatRatePct: 0, excludeFromResultat: true },
      { id: 'dec_rem', label: 'Rémunération gérant', direction: 'out', fixed: true, vatRatePct: 0 },
      { id: 'dec_urssaf', label: 'URSSAF', direction: 'out', fixed: true, vatRatePct: 0 },
      { id: 'dec_tva', label: 'TVA', direction: 'out', fixed: false, vatRatePct: 0 },
    ],
    transactions: [], // aucun réalisé
    forecast: [
      { month: '2026-08', categoryId: 'enc_presta', amountCents: 600_000 }, // produit (600 TTC -> 500 HT)
      { month: '2026-08', categoryId: 'enc_apport', amountCents: 500_000 }, // financement : hors résultat
    ],
  }
  const ctx = {
    actuals: actualsByMonth(state.transactions),
    forecasts: forecastByMonth(state.forecast),
    currentMonth: '2026-06',
  }
  const m = compteResultatMensuel(state, ctx, '2026')
  const remLine = m.charges.find((l) => l.categoryId === 'dec_rem')
  assert.ok(remLine, 'la rému doit apparaître comme charge')
  // août 2026 (futur, en CCA) : la rému attribuée pèse au résultat sans aucune sortie cash
  assert.equal(remLine.parMois['2026-08'], -150_000)
  // URSSAF dérivée à 40 % de la base attribuée
  const ursLine = m.charges.find((l) => l.categoryId === 'dec_urssaf')
  assert.equal(ursLine.parMois['2026-08'], -60_000)
  // la TVA n'entre jamais au résultat
  assert.ok(!m.charges.some((l) => l.categoryId === 'dec_tva'))
  // un apport en capital (excludeFromResultat) n'est pas un produit : seul reste la presta HT
  assert.ok(!m.produits.some((l) => l.categoryId === 'enc_apport'))
  assert.equal(m.totalProduitsHTCents, 500_000)
})

test('compte de résultat : achat immobilisé amorti (dotation étalée), pas en charge directe', () => {
  const state = {
    company: {
      demoToday: '2026-06-15',
      fiscal: { amountsAreTTC: true, is: { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 } },
    },
    accounts: [{ openingBalanceCents: 0, openingDate: '2026-01-01' }],
    categories: [
      { id: 'enc_presta', label: 'Prestations', direction: 'in', vatRatePct: 20 },
      { id: 'dec_invest', label: 'Investissement', direction: 'out', vatRatePct: 0, excludeFromResultat: true, amortissementMois: 36 },
    ],
    transactions: [{ id: 't1', date: '2026-01-15', categoryId: 'dec_invest', amountCents: -360_000 }],
    forecast: [],
  }
  const ctx = {
    actuals: actualsByMonth(state.transactions),
    forecasts: forecastByMonth(state.forecast),
    currentMonth: '2026-06',
  }
  const m = compteResultatMensuel(state, ctx, '2026')
  // l'achat immobilisé n'est PAS une charge directe (il sort en trésorerie, hors résultat)
  assert.ok(!m.charges.some((l) => l.categoryId === 'dec_invest'))
  // dotation linéaire : 3 600 € / 36 mois = 100 €/mois, sur les 12 mois de 2026
  const dot = m.charges.find((l) => l.categoryId === 'dotation_amortissement')
  assert.ok(dot, 'ligne dotation aux amortissements présente')
  assert.equal(dot.parMois['2026-01'], -10_000)
  assert.equal(dot.parMois['2026-12'], -10_000)
  assert.equal(dot.totalCents, -120_000)
})

test('feu vert : petit versement -> vert, gros versement -> rouge, couplage cotisations', () => {
  const state = DECISION_FIXTURE()
  // un bon mois pour avoir de la marge : on rehausse l'encaissement de juin et juillet
  state.transactions.push({ id: 'big', date: '2026-07-05', categoryId: 'enc_presta', amountCents: 3_000_000 })
  const small = remunerationCheck(state, { amountCents: 100_000, month: '2026-07' })
  // couplage cotisations à 40% (ACRE active en juillet, fin 2026-09) : 40 000
  assert.equal(small.couplingRatePct, 40)
  assert.equal(small.couplingCents, 40_000)
  assert.equal(small.totalCostCents, 140_000)
  assert.equal(small.verdict, 'vert')
  // un versement futur n'entame PAS le cash d'aujourd'hui (le NET « aujourd'hui » ne
  // bouge pas), mais il entame le POINT BAS projeté de la fenêtre : c'est là qu'on
  // mesure le coût total (140 000 sous le solde d'aujourd'hui).
  assert.equal(small.lowPointNextCents, small.netBeforeCents - 140_000)
  // un versement énorme fait passer le point bas projeté sous 0 -> rouge
  const huge = remunerationCheck(state, { amountCents: 50_000_000, month: '2026-07' })
  assert.equal(huge.verdict, 'rouge')
  assert.ok(huge.lowPointNextCents < 0)
})

test('feu vert : montant invalide -> throw', () => {
  const state = DECISION_FIXTURE()
  assert.throws(() => remunerationCheck(state, { amountCents: 0 }))
  assert.throws(() => remunerationCheck(state, { amountCents: -100 }))
  assert.throws(() => remunerationCheck(state, { amountCents: 100.5 }))
})

test('feu vert : couplage absent si TNS non piloté', () => {
  const state = DECISION_FIXTURE()
  state.company.fiscal.tns.autoCompute = false
  const r = remunerationCheck(state, { amountCents: 100_000, month: '2026-07' })
  assert.equal(r.couplingCents, 0)
  assert.equal(r.totalCostCents, 100_000)
})

// ------------------------------------------------------------------ Aperçu d'impact (verdict ProposalCard)
test('impact : une grosse sortie future fait passer le point bas sous le seuil', () => {
  const state = DECISION_FIXTURE()
  const before = project(state)
  // sortie ponctuelle énorme en août -> le point bas projeté plonge
  const r = forecastImpact(state, { month: '2026-08', categoryId: 'dec_achats', amountCents: -3_000_000 })
  assert.equal(r.month, '2026-08')
  assert.equal(r.categoryId, 'dec_achats')
  assert.equal(r.amountCents, -3_000_000)
  assert.equal(r.thresholdCents, state.company.lowCashThresholdCents)
  assert.equal(r.lowPointBeforeCents, before.lowPoint.cents)
  // le point bas après est strictement plus bas qu'avant et passe sous le seuil
  assert.ok(r.lowPointAfterCents < r.lowPointBeforeCents)
  assert.equal(r.crossesThreshold, r.lowPointAfterCents < r.thresholdCents)
  assert.ok(r.crossesThreshold)
})

test('impact : une entrée future améliore (ou ne dégrade pas) le point bas, pas de croisement', () => {
  const state = DECISION_FIXTURE()
  const r = forecastImpact(state, { month: '2026-08', categoryId: 'enc_presta', amountCents: 1_000_000 })
  // une entrée ne fait jamais BAISSER le point bas
  assert.ok(r.lowPointAfterCents >= r.lowPointBeforeCents)
})

test('impact : runwayDeltaMonths null si le burn est nul (aucun mois clos déficitaire)', () => {
  const state = DECISION_FIXTURE()
  // tous les mois clos deviennent excédentaires (enc 900k > charges 540k) -> burn 0
  // -> runwayMonths null des deux côtés (pas d'infini inventé) -> delta null.
  for (const t of state.transactions) {
    if (t.categoryId === 'enc_presta') t.amountCents = 900_000
  }
  const r = forecastImpact(state, { month: '2026-08', categoryId: 'dec_achats', amountCents: -100_000 })
  assert.equal(r.runwayBeforeMonths, null)
  assert.equal(r.runwayAfterMonths, null)
  assert.equal(r.runwayDeltaMonths, null)
})

test('impact : payload invalide -> throw (montant non entier, catégorie inconnue, champs manquants)', () => {
  const state = DECISION_FIXTURE()
  assert.throws(() => forecastImpact(state, { month: '2026-08', categoryId: 'dec_achats', amountCents: 100.5 }))
  assert.throws(() => forecastImpact(state, { month: '2026-08', categoryId: 'inconnu', amountCents: -100_000 }))
  assert.throws(() => forecastImpact(state, { categoryId: 'dec_achats', amountCents: -100_000 }))
  assert.throws(() => forecastImpact(state, { month: '2026-08', amountCents: -100_000 }))
})

// ------------------------------------------------------------------ Arbitrage rému/dividendes (lot 3)
test('arbitrage : voie rémunération = brut + cotisations = enveloppe (taux effectif du mois)', () => {
  const fiscal = {
    is: { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 },
    flatTaxPct: 31.4,
  }
  const tns = {
    cotisationTauxPct: 40, cotisationTauxApresAcrePct: 45, dividendesTauxPct: 45,
    acre: { actif: true, finMois: '2026-09' },
  }
  // ACRE active en juillet -> 40%. Enveloppe 1 400 000 = brut x 1,40 -> brut 1 000 000, cotis 400 000.
  const r = remunerationVsDividendes({ fiscal, tns, capitalSocialCents: 500_000, grossCostCents: 1_400_000, month: '2026-07' })
  assert.equal(r.remuneration.cotisationRatePct, 40)
  assert.equal(r.remuneration.brutCents, 1_000_000)
  assert.equal(r.remuneration.cotisationsCents, 400_000)
  assert.equal(r.remuneration.brutCents + r.remuneration.cotisationsCents, r.grossCostCents)
  assert.equal(r.remuneration.isCents, 0) // rému déductible de l'IS
})

test('arbitrage : voie dividendes = IS puis découpe au seuil de 10% du capital', () => {
  const fiscal = {
    is: { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 },
    flatTaxPct: 31.4, // 12,8 IR + 18,6 PS
  }
  const tns = { cotisationTauxPct: 40, dividendesTauxPct: 45, acre: { actif: false } }
  // Enveloppe 1 000 000, capital 500 000 -> seuil 10% = 50 000. bénéfice déjà réalisé 0 -> IS 15%.
  const r = remunerationVsDividendes({
    fiscal, tns, capitalSocialCents: 500_000, grossCostCents: 1_000_000, month: '2026-10', beneficeAvantISCents: 0,
  })
  // IS marginal 15% sur 1 000 000 = 150 000 -> dividende 850 000
  assert.equal(r.dividendes.isRatePct, 15)
  assert.equal(r.dividendes.isCents, 150_000)
  assert.equal(r.dividendes.dividendeBrutCents, 850_000)
  // seuil 10% du capital = 50 000 : fraction <= seuil 50 000 (PS 18,6%), fraction > seuil 800 000 (cotis TNS 45%)
  assert.equal(r.seuil10Cents, 50_000)
  assert.equal(r.dividendes.fractionSousSeuilCents, 50_000)
  assert.equal(r.dividendes.fractionSurSeuilCents, 800_000)
  assert.equal(r.dividendes.prelevementsSociauxCents, Math.round(50_000 * 18.6 / 100)) // 9 300
  assert.equal(r.dividendes.cotisationsTnsCents, Math.round(800_000 * 45 / 100)) // 360 000
  assert.equal(r.dividendes.irCents, Math.round(850_000 * 12.8 / 100)) // 108 800
  // net = dividende - PS - cotis - IR
  assert.equal(r.dividendes.netCents, 850_000 - 9_300 - 360_000 - 108_800)
})

test('arbitrage : IS marginal passe à 25% au-delà du seuil de bénéfice déjà réalisé', () => {
  const fiscal = { is: { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 }, flatTaxPct: 31.4 }
  const tns = { cotisationTauxPct: 40, dividendesTauxPct: 45, acre: { actif: false } }
  // bénéfice déjà réalisé 5 000 000 > seuil 42 500 EUR -> l'euro marginal tombe à 25%.
  const r = remunerationVsDividendes({
    fiscal, tns, capitalSocialCents: 500_000, grossCostCents: 1_000_000, month: '2026-10', beneficeAvantISCents: 5_000_000,
  })
  assert.equal(r.dividendes.isRatePct, 25)
  assert.equal(r.dividendes.isCents, 250_000)
})

test('arbitrage : tous les montants sont des centimes entiers, montant invalide throw', () => {
  const fiscal = { is: { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 }, flatTaxPct: 31.4 }
  const tns = { cotisationTauxPct: 40, dividendesTauxPct: 45, acre: { actif: false } }
  const r = remunerationVsDividendes({ fiscal, tns, capitalSocialCents: 500_000, grossCostCents: 999_999, month: '2026-10' })
  const allInts = [
    r.remuneration.brutCents, r.remuneration.cotisationsCents,
    r.dividendes.isCents, r.dividendes.dividendeBrutCents, r.dividendes.prelevementsSociauxCents,
    r.dividendes.cotisationsTnsCents, r.dividendes.irCents, r.dividendes.netCents,
  ]
  assert.ok(allInts.every(Number.isInteger), 'tous les montants doivent être entiers')
  assert.throws(() => remunerationVsDividendes({ fiscal, tns, grossCostCents: 0 }))
  assert.throws(() => remunerationVsDividendes({ fiscal, tns, grossCostCents: -100 }))
  assert.throws(() => remunerationVsDividendes({ fiscal, tns, grossCostCents: 100.5 }))
})

test('arbitrage via decision : alimente le bénéfice réalisé et expose les avertissements', () => {
  const state = DECISION_FIXTURE()
  state.company.capitalSocialCents = 500_000
  state.company.fiscal.is = { seuilReduitCents: 4_250_000, tauxReduitPct: 15, tauxNormalPct: 25 }
  const r = compareRemunerationDividendes(state, { grossCostCents: 1_000_000, month: '2026-10' })
  assert.equal(r.grossCostCents, 1_000_000)
  assert.ok(typeof r.beneficeAvantISCents === 'number')
  assert.ok(r.beneficeAvantISCents >= 0) // jamais négatif (max(0, ...))
  assert.ok(Array.isArray(r.avertissements) && r.avertissements.length >= 1)
  assert.ok(r.remuneration && r.dividendes)
})

// ------------------------------------------------------------------ Saisonnalité (lot 3)
test('saisonnalité : désactivée -> aucun delta (additif et réversible)', () => {
  const state = FISCAL_FIXTURE()
  state.company.seasonality = { enabled: false, monthly: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }
  assert.deepEqual(seasonalityDeltas(state, '2026-05'), {})
})

test('saisonnalité : module les encaissements futurs par le coefficient mensuel, jamais les sorties', () => {
  const state = FISCAL_FIXTURE()
  // coef 0,5 sur juin (mois 6), 1 ailleurs. Forecast juin enc_presta 1 200 000 -> delta -600 000.
  const monthly = Array(12).fill(1)
  monthly[5] = 0.5 // juin
  state.company.seasonality = { enabled: true, monthly }
  const d = seasonalityDeltas(state, '2026-05')
  // delta = retenu x (coef - 1) = 1 200 000 x (-0,5) = -600 000 sur enc_presta
  assert.equal(d['2026-06'].enc_presta, -600_000)
  // aucune catégorie de sortie touchée
  assert.equal(d['2026-06'].dec_achats, undefined)
  assert.equal(d['2026-06'].dec_rem, undefined)
  // tous les deltas restent des centimes entiers
  assert.ok(Object.values(d).flatMap((m) => Object.values(m)).every(Number.isInteger))
})

test('saisonnalité : appliquée dans project() abaisse le solde projeté (creux)', () => {
  const state = FISCAL_FIXTURE()
  const base = project(state)
  const monthly = Array(12).fill(1)
  monthly[5] = 0.5 // creux en juin
  state.company.seasonality = { enabled: true, monthly }
  const seasoned = project(state)
  const baseEnd = base.series.at(-1).projectedCents
  const seasonedEnd = seasoned.series.at(-1).projectedCents
  assert.ok(seasonedEnd < baseEnd, 'un creux saisonnier doit abaisser le solde projeté')
})

// ------------------------------------------------------------------ Scénarios lot 3
test('scénario dividendes : décaisse l\'enveloppe le mois choisi', () => {
  const state = FISCAL_FIXTURE()
  state.scenarios = [{ id: 'sc_dividendes', params: { month: '2026-07', grossCostCents: 500_000 } }]
  // pas de dec_divers ni dividendesCategoryId -> fallback dec_remuneration (= remunerationCategoryId dec_rem)
  state.company.fiscal.tns.dividendesCategoryId = 'dec_rem'
  const d = scenarioDeltas(state.scenarios, ['sc_dividendes'], state)
  assert.equal(d['2026-07'].dec_rem, -500_000)
})

test('scénario arrêt maladie : annule la facturation N mois + indemnités journalières', () => {
  const state = DECISION_FIXTURE()
  // juillet est le mois courant : on prend un arrêt août-septembre (mois futurs, prévus 0
  // dans la fixture -> mais retainedFor renvoie le prévu = 0 ; testons sur des mois avec flux).
  // La fixture n'a pas de forecast : on ajoute un encaissement prévu en août pour tester l'annulation.
  state.forecast = [{ id: 'f', month: '2026-08', categoryId: 'enc_presta', amountCents: 1_000_000 }]
  state.scenarios = [{ id: 'sc_arret_maladie', params: { startMonth: '2026-08', durationMonths: 2, dailyAllowanceCents: 5000, waitingDays: 3 } }]
  const d = scenarioDeltas(state.scenarios, ['sc_arret_maladie'], state)
  // août (mois 1 de l'arrêt) : annulation de l'encaissement prévu (-1 000 000) PUIS IJ
  // ajoutées sur la même catégorie d'entrée (pas de enc_divers dans la fixture -> 1re
  // catégorie in = enc_presta). IJ mois 1 = (30 - 3 jours de carence) x 5000 = 135 000.
  // delta net août = -1 000 000 + 135 000 = -865 000.
  assert.equal(d['2026-08'].enc_presta, -1_000_000 + 27 * 5000)
  // septembre : pas de forecast -> rien à annuler, mais IJ 30 jours x 5000 = 150 000
  assert.equal(d['2026-09'].enc_presta, 30 * 5000)
})

test('scénario arrêt maladie : indemnités nulles par défaut (dailyAllowanceCents 0)', () => {
  const state = DECISION_FIXTURE()
  state.forecast = [{ id: 'f', month: '2026-08', categoryId: 'enc_presta', amountCents: 1_000_000 }]
  state.scenarios = [{ id: 'sc_arret_maladie', params: { startMonth: '2026-08', durationMonths: 2 } }]
  const d = scenarioDeltas(state.scenarios, ['sc_arret_maladie'], state)
  // août : annulation seule (pas d'IJ)
  assert.equal(d['2026-08'].enc_presta, -1_000_000)
  // septembre : rien (pas de flux à annuler, pas d'IJ)
  assert.equal(d['2026-09'], undefined)
})

// ------------------------------------------------------------------ Export dossier banquier (lot 3)
test('export dossier : HTML print-ready contenant chiffres clés et charte', () => {
  const state = FISCAL_FIXTURE()
  state.company.name = 'Test SARL'
  state.company.sector = 'Conseil'
  state.company.location = 'Manosque'
  state.company.businessAssumptions = ['Hypothèse test métier']
  const html = buildDossierHTML(state)
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('Dossier de trésorerie'))
  assert.ok(html.includes('Test SARL'))
  // mise en page imprimable : fond crème
  assert.ok(html.includes('#FAFAF7'))
  // courbe SVG inline (pas de dépendance JS)
  assert.ok(html.includes('<svg'))
  // ratios clés présents
  assert.ok(html.includes('Autonomie (runway)'))
  assert.ok(html.includes('Point mort mensuel'))
  // hypothèse métier reprise
  assert.ok(html.includes('Hypothèse test métier'))
  // pas d'emoji (consigne)
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html), 'aucun emoji dans le dossier')
})

// ------------------------------------------------------------------ Réconciliation bancaire (lot 2 fiabilité)
test('réconciliation : status ok quand le reconstruit colle au relevé (dans la tolérance)', () => {
  const state = FISCAL_FIXTURE()
  // solde reconstruit au 2026-04-30 = ouverture 1 000 000 + t1 +1 200 000 = 2 200 000
  state.accounts[0].expectedBalanceCents = 2_200_000
  state.accounts[0].expectedBalanceDate = '2026-04-30'
  const r = reconciliation(state)
  assert.equal(r.status, 'ok')
  assert.equal(r.reconstructedCents, 2_200_000)
  assert.equal(r.expectedCents, 2_200_000)
  assert.equal(r.deltaCents, 0)
})

test('réconciliation : status mismatch au-delà de la tolérance', () => {
  const state = FISCAL_FIXTURE()
  // relevé annoncé loin du reconstruit (transaction oubliée / doublon)
  state.accounts[0].expectedBalanceCents = 2_300_000
  state.accounts[0].expectedBalanceDate = '2026-04-30'
  const r = reconciliation(state)
  assert.equal(r.status, 'mismatch')
  assert.equal(r.deltaCents, 2_200_000 - 2_300_000) // reconstruit - attendu
  assert.ok(Math.abs(r.deltaCents) > r.toleranceCents)
})

test('réconciliation : un petit écart sous la tolérance reste ok (frais bancaires, arrondis)', () => {
  const state = FISCAL_FIXTURE()
  state.accounts[0].expectedBalanceCents = 2_200_000 - 3_000 // 30 EUR d'écart < 50 EUR tolérance
  state.accounts[0].expectedBalanceDate = '2026-04-30'
  assert.equal(reconciliation(state).status, 'ok')
})

test('réconciliation : pas de relevé renseigné -> unknown (aucune fausse alerte)', () => {
  const state = FISCAL_FIXTURE()
  const r = reconciliation(state)
  assert.equal(r.status, 'unknown')
  // computeAlerts ne doit PAS émettre d'alerte de réconciliation sans relevé
  const proj = project(state)
  assert.equal(computeAlerts(state, proj).some((a) => a.kind === 'reconciliation'), false)
})

test('réconciliation : alerte émise sur mismatch via computeAlerts', () => {
  const state = FISCAL_FIXTURE()
  state.accounts[0].expectedBalanceCents = 9_999_999 // très loin du reconstruit
  state.accounts[0].expectedBalanceDate = '2026-04-30'
  const proj = project(state)
  const alert = computeAlerts(state, proj).find((a) => a.kind === 'reconciliation')
  assert.ok(alert, 'une alerte reconciliation doit être émise')
  assert.equal(alert.severity, 'warning')
})

// ------------------------------------------------------------------ Données réelles seedées
test('données seedées : cohérence avec le rapport de génération', async () => {
  const state = await loadState()
  assert.equal(state.company.demoToday, '2026-06-10')

  // tous les montants sont des centimes entiers
  assert.ok(state.transactions.every((t) => Number.isInteger(t.amountCents)))
  assert.ok(state.forecast.every((f) => Number.isInteger(f.amountCents)))

  const proj = project(state)
  // solde du jour ~46 000 EUR (tolérance du générateur : 2 000 EUR)
  assert.ok(Math.abs(proj.balanceTodayCents - 4_600_000) <= 200_000, `solde: ${proj.balanceTodayCents}`)
  assert.equal(proj.balanceTodayCents, balanceAt(state, state.company.demoToday))

  // point bas (solde BRUT) fin août, positif. Avec la TVA dérivée (lot 2) le creux
  // brut remonte légèrement au-dessus du seuil de 15 000 EUR : c'est désormais le solde
  // NET disponible qui révèle la tension (cf. assertions NET ci-dessous).
  assert.ok(proj.lowPoint.date.startsWith('2026-08'), `point bas: ${proj.lowPoint.date}`)
  assert.ok(proj.lowPoint.cents > 0)

  // Coeur comptable : la TVA est dérivée des flux (tva.autoCompute=true sur la démo).
  // Le solde brut couvre le seuil, mais le NET disponible (brut - TVA à reverser à
  // horizon court) passe SOUS le seuil -> c'est le mensonge corrigé par le lot 2.
  assert.ok(proj.vatDueCents > 0, `TVA dérivée attendue: ${proj.vatDueCents}`)
  assert.equal(proj.committedCents, proj.vatDueCents + proj.socialProvisionCents)
  assert.equal(proj.netAvailableCents, proj.balanceTodayCents - proj.committedCents)
  assert.ok(proj.balanceTodayCents >= state.company.lowCashThresholdCents, 'le brut couvre le seuil')
  assert.ok(proj.netAvailableCents < state.company.lowCashThresholdCents, `net sous seuil attendu: ${proj.netAvailableCents}`)
  // l'alerte dédiée doit être levée
  const netAlert = computeAlerts(state, proj).find((a) => a.kind === 'net_below_threshold')
  assert.ok(netAlert, 'alerte net_below_threshold attendue sur la démo')

  // Réconciliation : la démo seede un solde de relevé = reconstruit -> status 'ok',
  // donc PAS d'alerte de réconciliation trompeuse.
  const reco = reconciliation(state)
  assert.equal(reco.status, 'ok', `réconciliation démo: delta ${reco.deltaCents}`)
  assert.equal(computeAlerts(state, proj).some((a) => a.kind === 'reconciliation'), false)

  // le scénario retard Durance Logis à 90 j pousse l'encaissement après l'été :
  // le creux d'août perd les 38 400 EUR et passe largement négatif.
  // (à 30 j, l'encaissement reste avant août : le point bas ne bouge pas, c'est voulu)
  const scenarios90 = state.scenarios.map((s) =>
    s.id === 'sc_retard' ? { ...s, params: { ...s.params, delayDays: 90 } } : s,
  )
  const deltas = scenarioDeltas(scenarios90, ['sc_retard'], state)
  const delayed = project(state, { deltas })
  assert.ok(delayed.lowPoint.cents < proj.lowPoint.cents - 3_000_000, `point bas retardé: ${delayed.lowPoint.cents}`)
  const deltas30 = scenarioDeltas(state.scenarios, ['sc_retard'], state)
  const delayed30 = project(state, { deltas: deltas30 })
  assert.equal(delayed30.lowPoint.cents, proj.lowPoint.cents)
})

test('grille prévisionnel : structure et solde de pied cohérent avec la projection', async () => {
  const state = await loadState()
  const grid = forecastGrid(state)
  assert.equal(grid.rows.length, state.categories.length)
  assert.equal(grid.currentMonth, '2026-06')
  // le solde de clôture de chaque mois du pied de grille = table mensuelle de la projection
  const proj = project(state)
  for (const c of grid.closings) {
    const m = proj.monthly.find((m) => m.month === c.month)
    assert.equal(c.closingCents, m.closingCents, c.month)
  }
  // cellules : mois passés non éditables, mois courant et futurs éditables
  const row = grid.rows[0]
  assert.equal(row.cells.find((c) => c.month === '2026-05').editable, false)
  assert.equal(row.cells.find((c) => c.month === '2026-06').editable, true)
})
