// Bandeau de tête du tableau de bord. Lancé par « npm test » à la racine (Node lit le
// TypeScript sans compilation).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bandeauTresorerie, type IndicateursBandeau } from '../src/lib/bandeau.ts'

// Espaces insécables de l'Intl français remis en espaces simples pour lire les assertions.
const plat = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ')

const base: IndicateursBandeau = {
  lowCashThresholdCents: 1_500_000,
  lowPoint90: { date: '2026-08-31', cents: 1_607_200 },
  netAvailableCents: 1_339_247,
  committedCents: 3_261_100,
}

test('disponible net sous le seuil, point bas au-dessus : pas de « Pas de creux en vue »', () => {
  const b = bandeauTresorerie(base)
  assert.equal(b.tone, 'warning')
  assert.doesNotMatch(b.headline, /Pas de creux/)
  assert.equal(
    plat(b.headline),
    'Disponible net sous le seuil de sécurité : 13 392 €, une fois la TVA et les cotisations dues retranchées, pour un seuil de 15 000 €.',
  )
})

test('disponible net négatif : ton rouge', () => {
  assert.equal(bandeauTresorerie({ ...base, netAvailableCents: -50_000 }).tone, 'destructive')
})

test('sans trésorerie engagée, la phrase ne parle pas de TVA', () => {
  const b = bandeauTresorerie({ ...base, committedCents: 0 })
  assert.equal(plat(b.headline), 'Disponible net sous le seuil de sécurité : 13 392 €, pour un seuil de 15 000 €.')
})

test('tout au-dessus du seuil : « Pas de creux en vue »', () => {
  const b = bandeauTresorerie({ ...base, netAvailableCents: 2_000_000 })
  assert.equal(b.tone, 'positive')
  assert.equal(b.headline, 'Pas de creux en vue sur 90 jours, selon le prévisionnel.')
})

test('aucun point bas calculé et net confortable : « Pas de creux en vue »', () => {
  assert.equal(bandeauTresorerie({ ...base, lowPoint90: null, netAvailableCents: 2_000_000 }).tone, 'positive')
})

test('le point bas sous le seuil reste prioritaire sur le disponible net', () => {
  const b = bandeauTresorerie({ ...base, lowPoint90: { date: '2026-08-31', cents: 1_107_200 } })
  assert.equal(b.tone, 'warning')
  assert.equal(plat(b.headline), 'Point bas sous le seuil de sécurité dans les 90 jours : 11 072 € le 31 août.')
})

test('trésorerie projetée sous zéro : ton rouge, prioritaire sur tout', () => {
  const b = bandeauTresorerie({ ...base, lowPoint90: { date: '2026-09-15', cents: -120_000 } })
  assert.equal(b.tone, 'destructive')
  assert.match(plat(b.headline), /^La trésorerie projetée passe sous zéro dans les 90 jours : -1 200 € le 15 sept\.$/)
})
