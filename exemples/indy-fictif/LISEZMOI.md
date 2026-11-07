# Exports Indy fictifs

Trois fichiers au format des exports Indy (CSV point-virgule, bouton « Excel ») d'une entreprise **imaginaire** créée le 1er septembre 2025 :

- `grand-livre-2025.csv` et `grand-livre-2026.csv` : grands livres des deux exercices ;
- `balance-2026.csv` : balance au 28 septembre 2026.

Ils servent à essayer l'import sans toucher à vos vraies données, et aux tests automatiques (`server/src/services/import-indy.test.js`).

Essai complet sur un Mac, dans un dossier de données séparé :

```bash
export SYNTRESO_DATA_DIR=/tmp/syntreso-essai SYNTRESO_ENTREE_INDY=exemples/indy-fictif
export SYNTRESO_REGLAGES=exemples/indy-fictif/reglages-fictif.json
npm run init -- --nom "Essai" --non-interactif
npm run import
```

Résultat attendu : 68 mouvements bancaires, réconciliation « OK » (écart 0), solde des comptes bancaires 20 298,00 EUR (compte courant 17 798 EUR + réserve TVA 2 500 EUR).
