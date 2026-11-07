import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compteResultatMensuel, derivedFiscalDeltas, vatRestantDuMois } from './fiscal.js'
import { actualsByMonth, forecastByMonth } from './projection.js'

// Cas de contrôle (données fictives) : TVA en sortie de régime annuel, déficit
// reportable, cotisations dues sur le passé, frais avancés au compte courant d'associé.
function makeState() {
  return {
    company: {
      demoToday: '2026-10-03',
      lowCashThresholdCents: 300_000,
      fiscal: {
        amountsAreTTC: true,
        vatDueActualCents: 250_000,
        tva: { autoCompute: true, regime: 'annuel', dueDate: '2027-05-05', annuelJusquau: '2026-12', payDayOfMonth: 22 },
        tns: { autoCompute: true, remunerationCategoryId: 'dec_rem', provisionCategoryId: 'dec_urssaf', cotisationTauxPct: 45 },
        is: { autoDecaissement: true, categoryId: 'dec_is', deficitsReportablesCents: { 2026: 200_000 } },
      },
      fraisCCA: { reelParMoisCents: { '2026-09': 70_000 }, prevuParMoisCents: { '2026-11': 80_000 } },
    },
    categories: [
      { id: 'enc_p', label: 'Prestations', direction: 'in', order: 1, vatRatePct: 20 },
      { id: 'dec_rem', label: 'Rémunération', direction: 'out', order: 2, vatRatePct: 0 },
      { id: 'dec_urssaf', label: 'URSSAF', direction: 'out', order: 3, vatRatePct: 0 },
      { id: 'dec_tva', label: 'TVA', direction: 'out', order: 4, vatRatePct: 0 },
      { id: 'dec_is', label: 'IS', direction: 'out', order: 5, vatRatePct: 0, excludeFromResultat: true },
    ],
    transactions: [
      { id: 't1', date: '2026-09-10', categoryId: 'dec_rem', amountCents: -150_000, label: 'rému' },
      { id: 't2', date: '2026-09-12', categoryId: 'enc_p', amountCents: 1_200_000, label: 'facture' },
      { id: 't3', date: '2026-10-03', categoryId: 'enc_p', amountCents: 120_000, label: 'règlement déjà dans la balance' },
    ],
    invoices: [],
    forecast: [
      { id: 'f1', month: '2026-10', categoryId: 'enc_p', amountCents: 600_000, source: 'user' },
      { id: 'f2', month: '2027-01', categoryId: 'enc_p', amountCents: 1_200_000, source: 'user' },
    ],
    scenarios: [],
    accounts: [{ id: 'acc', openingBalanceCents: 1_000_000, openingDate: '2026-01-01' }],
  }
}
const ctxOf = (s) => ({ actuals: actualsByMonth(s.transactions), forecasts: forecastByMonth(s.forecast), currentMonth: '2026-10' })

test('TVA : le mois courant ne recompte pas la TVA des règlements déjà dans la balance', () => {
  const s = makeState()
  // prévu 6 000 TTC pour octobre, dont 1 200 déjà encaissés -> reste 4 800 TTC = 800 de TVA
  assert.equal(vatRestantDuMois('2026-10', s, ctxOf(s).actuals, ctxOf(s).forecasts, '2026-10'), 80_000)
})

test('TVA : après annuelJusquau, la TVA 2027 se paie le mois suivant au lieu de partir en 2028', () => {
  const s = makeState()
  const { deltas } = derivedFiscalDeltas(s, ctxOf(s))
  // activité de janvier 2027 : 12 000 TTC -> 2 000 de TVA payée en février 2027
  assert.equal(deltas['2027-02']?.dec_tva, -200_000)
  // la CA12 de mai 2027 ne contient pas l'activité 2027
  assert.equal(deltas['2027-05']?.dec_tva, -(250_000 + 80_000))
})

test('Résultat : cotisations dues à 45 % sur le passé, frais au CCA, déficit reportable', () => {
  const s = makeState()
  const cr = compteResultatMensuel(s, ctxOf(s), '2026')
  const urssaf = cr.charges.find((l) => l.categoryId === 'dec_urssaf')
  assert.equal(urssaf.parMois['2026-09'], -67_500)
  const frais = cr.charges.find((l) => l.categoryId === 'frais_cca')
  assert.equal(frais.parMois['2026-09'], -70_000)
  assert.equal(frais.parMois['2026-11'], -80_000)
  const sansDeficit = compteResultatMensuel({ ...s, company: { ...s.company, fiscal: { ...s.company.fiscal, is: { ...s.company.fiscal.is, deficitsReportablesCents: {} } } } }, ctxOf(s), '2026')
  assert.ok(cr.isProvisionCents < sansDeficit.isProvisionCents)
  assert.equal(sansDeficit.isProvisionCents - cr.isProvisionCents, 30_000)
})
