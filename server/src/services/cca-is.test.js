import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ccaStatus, compteResultatMensuel, derivedFiscalDeltas, resultatPrevisionnel } from './fiscal.js'
import { ccaRepaymentCheck } from './decision.js'
import { actualsByMonth, forecastByMonth } from './projection.js'
import { cashCalendar } from './echeances.js'

// Fixture fictive, dirigeant TNS seul : mois courant juillet 2026, rému 1 500/mois versée
// en mai (cash), puis en CCA de juin à décembre (fenêtre bornée depuis/jusquau).
// vatRatePct absent partout -> montants HT = TTC (assertions simples).
function makeState() {
  return {
    company: {
      demoToday: '2026-07-10',
      lowCashThresholdCents: 300_000,
      fiscal: {
        tns: {
          autoCompute: true,
          remunerationCategoryId: 'dec_remuneration',
          provisionCategoryId: 'dec_urssaf',
          cotisationTauxPct: 45,
          remunerationMensuelleBruteCents: 150_000,
          remunerationEnCcaDepuis: '2026-06',
          remunerationEnCcaJusquau: '2026-12',
        },
        is: { autoDecaissement: true, categoryId: 'dec_is' },
      },
    },
    categories: [
      { id: 'enc_p', label: 'Prestations', direction: 'in', order: 1 },
      { id: 'dec_remuneration', label: 'Rémunération gérant', direction: 'out', order: 2 },
      { id: 'dec_urssaf', label: 'Cotisations URSSAF', direction: 'out', order: 3 },
      { id: 'dec_is', label: 'Impôt sur les sociétés', direction: 'out', order: 4 },
      { id: 'dec_tva', label: 'TVA', direction: 'out', order: 5 },
    ],
    transactions: [
      // encaissements réalisés jan-juin : 10 000 EUR/mois -> produits 2026 réalisés 60 000
      ...['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'].map((ym, i) => ({
        id: `t_in_${i}`, date: `${ym}-15`, categoryId: 'enc_p', amountCents: 1_000_000, label: 'presta',
      })),
      // rému versée en mai (cash), rien en juin (CCA)
      { id: 't_rem_mai', date: '2026-05-28', categoryId: 'dec_remuneration', amountCents: -150_000, label: 'rému mai' },
    ],
    invoices: [],
    forecast: [],
    scenarios: [],
    accounts: [{ id: 'acc', openingBalanceCents: 2_000_000, openingDate: '2026-01-01' }],
  }
}

const ctxOf = (state) => ({
  actuals: actualsByMonth(state.transactions),
  forecasts: forecastByMonth(state.forecast),
  currentMonth: '2026-07',
})

test('ccaStatus : dû accumulé sur les mois clos de la fenêtre, projection à fin de fenêtre', () => {
  const state = makeState()
  const cca = ccaStatus(state)
  // juin clos non versé -> 1 500 ; juillet en cours pas encore compté dans accrued
  assert.equal(cca.accruedCents, 150_000)
  // juin -> décembre : 7 mois x 1 500 = 10 500
  assert.equal(cca.projectedEndCents, 1_050_000)
  assert.equal(cca.sinceMonth, '2026-06')
})

test('compte de résultat : la rému CCA d\'un mois PASSÉ reste une charge (frontière de mois)', () => {
  const state = makeState()
  const cr = compteResultatMensuel(state, ctxOf(state), '2026')
  const juin = cr.parMois['2026-06']
  // rému attribuée 1 500 + provision 45 % = 675 -> 2 175 de charges en juin malgré 0 versé
  assert.equal(juin.chargesHTCents, -(150_000 + 67_500))
})

test('ccaRepaymentCheck : plafonné par le CCA accumulé, zéro cotisation couplée', () => {
  const state = makeState()
  const over = ccaRepaymentCheck(state, { amountCents: 200_000 })
  assert.equal(over.verdict, 'rouge')
  assert.equal(over.exceedsCap, true)
  assert.equal(over.ccaAccruedCents, 150_000)

  const ok = ccaRepaymentCheck(state, { amountCents: 100_000 })
  assert.equal(ok.exceedsCap, false)
  assert.equal(ok.couplingCents, 0)
  assert.equal(ok.totalCostCents, 100_000)
  assert.ok(['vert', 'ambre', 'rouge'].includes(ok.verdict))
})

test('IS : le solde de l\'exercice N est décaissé au 15/05 N+1 dans la projection', () => {
  const state = makeState()
  const ctx = ctxOf(state)
  const is2026 = resultatPrevisionnel(state, ctx, '2026').isProvisionCents
  assert.ok(is2026 > 0, 'fixture bénéficiaire attendue')
  const { deltas } = derivedFiscalDeltas(state, ctx)
  assert.equal(deltas['2027-05']?.dec_is, -is2026)
})

test('IS : pas de décaissement si autoDecaissement off ou catégorie absente (additif/réversible)', () => {
  const state = makeState()
  state.company.fiscal.is.autoDecaissement = false
  const { deltas } = derivedFiscalDeltas(state, ctxOf(state))
  assert.equal(deltas['2027-05']?.dec_is, undefined)

  const state2 = makeState()
  state2.categories = state2.categories.filter((c) => c.id !== 'dec_is')
  const { deltas: d2 } = derivedFiscalDeltas(state2, ctxOf(state2))
  assert.equal(d2['2027-05']?.dec_is, undefined)
})

test('échéancier : le solde IS est daté au 15/05, la CFE paramétrée apparaît', async () => {
  const state = makeState()
  state.company.fiscal.cfe = { amountCents: 30_000 }
  const ctx = ctxOf(state)
  const cal = await cashCalendar(state, { horizonDays: 365, actuals: ctx.actuals, forecasts: ctx.forecasts })
  // NB : readJsonOr('echeances') lit le data dir par défaut (démo), qui peut contenir
  // des échéances saisies -> on cible les DÉRIVÉES, recalculées de la fixture.
  const is = cal.items.find((e) => e.kind === 'is' && e.source === 'derived')
  assert.ok(is, 'échéance IS dérivée attendue')
  assert.equal(is.dueDate, '2027-05-15')
  const cfe = cal.items.find((e) => e.id.endsWith('_cfe'))
  assert.ok(cfe, 'échéance CFE attendue')
  assert.equal(cfe.dueDate, '2026-12-15')
  assert.equal(cfe.amountCents, -30_000)
})

test('ccaStatus : le solde réel Indy (455) prime sur le calcul, rému prévue au forecast non ajoutée', () => {
  const state = makeState()
  state.company.ccaActual = { cents: 80_000, asOf: '2026-07-09' }
  // juillet à décembre prévus versés en cash, sauf novembre
  state.forecast = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-12'].map((month) => ({
    month, categoryId: 'dec_remuneration', amountCents: -150_000,
  }))
  const cca = ccaStatus(state)
  assert.equal(cca.source, 'indy')
  assert.equal(cca.accruedCents, 80_000)
  assert.equal(cca.projectedEndCents, 80_000 + 150_000)
  assert.equal(cca.asOfDate, '2026-07-09')
  // le plafond de remboursement suit le réel
  assert.equal(ccaRepaymentCheck(state, { amountCents: 100_000 }).exceedsCap, true)
})

test('ccaStatus Indy : la projection ne compte que les mois de la fenêtre CCA à venir', () => {
  const state = makeState()
  state.company.fiscal.tns.remunerationEnCcaDepuis = '2026-11'
  state.company.ccaActual = { cents: 80_000, asOf: '2026-07-09' }
  // rien de prévu au versement : seuls novembre et décembre entrent au CCA
  const cca = ccaStatus(state)
  assert.equal(cca.projectedEndCents, 80_000 + 300_000)
})
