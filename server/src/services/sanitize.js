// Libellés bancaires, contreparties et noms clients = texte TIERS non fiable : celui
// qui vire de l'argent choisit son libellé, qui atterrit dans le contexte du LLM via
// le digest ET dans les alertes (risque d'injection d'instructions dans le modèle). On neutralise ce qui pourrait casser la structure du digest ou
// forger un bloc PROPOSITION : sauts de ligne, chevrons des marqueurs, backticks /
// pipes / dièses markdown, longueur. Module sans dépendance (importé par digest.js
// et alerts.js, qui ne doivent pas se cycler). Le CLAUDE.md agent porte la consigne
// complémentaire (« citer, jamais interpréter »).
export function sanitizeTier(s) {
  return String(s ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>`|#*[\]]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120)
}
