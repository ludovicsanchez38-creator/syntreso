// Horizon glissant centralisé. Source unique de vérité pour les bornes de la
// projection et des grilles, à la place des '2026-12' / '2025-06' qui étaient
// dupliqués dans projection.js, agent.js, digest.js et forecastGrid.
//
// Toutes les bornes se calculent à partir du MOIS COURANT (company.demoToday en
// démo, date réelle en prod), jamais d'une date figée en dur : le proto reste
// juste quelle que soit la date du jour.

import { addMonths } from './dates.js'

// Nombre de mois projetés vers l'avant à partir du mois courant (inclus jusqu'à
// currentMonth + HORIZON_MONTHS). Aligné sur le brainstorm (addMonths(+18)).
export const HORIZON_MONTHS = 18

// Profondeur d'historique affiché : N mois clos avant le mois courant.
export const HISTORY_MONTHS = 12

/** Dernier mois 'YYYY-MM' de l'horizon de projection. */
export function horizonEnd(currentMonth) {
  return addMonths(currentMonth, HORIZON_MONTHS)
}

/** Premier mois 'YYYY-MM' de la grille (borne basse de l'historique affiché). */
export function gridStart(currentMonth) {
  return addMonths(currentMonth, -HISTORY_MONTHS)
}
