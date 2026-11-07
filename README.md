# Syntréso

**Pilotage de trésorerie pour TPE, en logiciel libre.** Conçue par Ludo Sanchez (Synoptïa). Licence [AGPL-3.0](LICENSE).

Syntréso lit votre comptabilité **Indy**, en tire la situation réelle de la banque et projette les 18 prochains mois : solde disponible une fois la TVA et les cotisations mises de côté, point bas à venir, autonomie en mois, échéances datées, résultat prévisionnel. Elle répond aux questions de dirigeant (« puis-je me verser 2 000 EUR ce mois-ci ? », « et si j'embauche en janvier ? ») avec un feu vert, ambre ou rouge calculé à partir des chiffres.

Elle se branche sur votre CRM **Twenty** pour transformer le pipe commercial en encaissements prévus, et s'utilise aussi bien dans le navigateur que par votre **agent IA** grâce à une API documentée.

Une règle traverse tout l'outil : **l'agent propose, vous validez, le serveur écrit**. Aucune écriture issue d'un agent, du CRM ou d'un calcul automatique n'entre dans le prévisionnel sans votre clic.

Syntréso s'installe chez vous (serveur Linux avec Docker, ou Mac) et vos données restent sur votre machine. Elle est fournie telle quelle, sans garantie ni assistance due (voir [Licence](#16-licence)).

---

## Sommaire

1. [Ce que fait Syntréso](#1-ce-que-fait-syntréso)
2. [Essayer sur la démonstration (données fictives)](#2-essayer-sur-la-démonstration-données-fictives)
3. [Ce qu'il y a dans ce dépôt](#3-ce-quil-y-a-dans-ce-dépôt)
4. [Installation sur un serveur (Docker)](#4-installation-sur-un-serveur-docker)
5. [Installation sur un Mac](#5-installation-sur-un-mac)
6. [Créer la base : votre entreprise ou la démo](#6-créer-la-base--votre-entreprise-ou-la-démo)
7. [Premier import Indy](#7-premier-import-indy)
8. [Brancher Twenty](#8-brancher-twenty)
9. [Brancher votre agent IA](#9-brancher-votre-agent-ia)
10. [L'assistant IA intégré (optionnel, clé d'API)](#10-lassistant-ia-intégré-optionnel-clé-dapi)
11. [Sauvegarde et restauration](#11-sauvegarde-et-restauration)
12. [Mise à jour](#12-mise-à-jour)
13. [Sécurité](#13-sécurité)
14. [Limites](#14-limites)
15. [En cas de problème](#15-en-cas-de-problème)
16. [Licence](#16-licence)

---

## 1. Ce que fait Syntréso

- **Tableau de bord** : une phrase sur les 90 prochains jours (point bas, disponible net sous le seuil), le compte courant, ce qui est mis de côté pour la TVA et les cotisations, la trésorerie projetée en fin d'année, la courbe du solde réalisé puis projeté, les échéances datées et ce qui sort de l'ordinaire (factures en retard, dépense inhabituelle, écart de réconciliation).
- **Prévisionnel** sur 18 mois, catégorie par catégorie, alimenté par la médiane de vos mois récents et corrigé à la main. La TVA, les cotisations et l'impôt sur les sociétés sont recalculés à partir des flux.
- **Décider** : « puis-je me verser ? » et, selon votre situation, rémunération ou dividendes et remboursement du compte courant d'associé, chacun avec son verdict et ses hypothèses.
- **Scénarios** : embauche, investissement, prêt, retard d'un gros encaissement, arrêt maladie du dirigeant, dividendes et quelques autres, dont on voit l'effet sur la courbe avant de décider.
- **Dossier banquier** imprimable, journal de toutes les modifications.
- **Import Indy** (grand livre et balance exportés à la main), **Twenty** en option, **API** pour votre agent, **assistant IA intégré** en option avec votre clé d'API Anthropic.

---

## 2. Essayer sur la démonstration (données fictives)

La démonstration installe une entreprise fictive du bâtiment, Bâti Provence, avec une date figée au 10 juin 2026. Aucune donnée réelle, aucun compte à créer, assistant coupé.

Sur Linux ou Mac, avec **Node.js 22 ou plus récent** :

```bash
git clone <adresse-du-dépôt> syntreso && cd syntreso
npm --prefix server ci --omit=dev
JETON=$(openssl rand -hex 32)
sed "s/^SYNTRESO_JETON=.*/SYNTRESO_JETON=$JETON/; s/^SYNTRESO_ASSISTANT=.*/SYNTRESO_ASSISTANT=non/" .env.exemple > .env && chmod 600 .env
npm run demo
npm start
```

Ouvrez `http://127.0.0.1:3900` et collez le jeton (`grep SYNTRESO_JETON .env`). Avec Docker, la même démonstration : `./install-vps.sh` puis `docker compose exec syntreso npm run demo`.

Pour essayer l'import Indy sans vos données, `exemples/indy-fictif/` contient des exports fictifs et leur mode d'emploi.

---

## 3. Ce qu'il y a dans ce dépôt

| Élément | Rôle |
|---|---|
| `server/` | Le serveur (Node.js) : API, moteur de calcul, import Indy, connecteur Twenty |
| `web/` | L'interface. `web/dist/` est **déjà construite** : rien à compiler à l'installation |
| `config/reglages.exemple.json` | Modèle des réglages (comptes Indy, règles de classement, Twenty). Copié en `config/reglages.json` à l'installation |
| `.env.exemple` | Modèle de configuration (jeton d'accès, clés). Copié en `.env` à l'installation |
| `entree-indy/` | Le dossier où déposer les exports Indy avant un import |
| `donnees/` | Vos données (créé à l'installation sur Mac ; volume Docker sur un serveur) |
| `modeles/base-vide/` | Base de départ neutre (catégories, scénarios, réglages fiscaux) |
| `exemples/indy-fictif/` | Petits exports Indy **fictifs**, pour essayer l'import sans vos données |
| `docs/GUIDE-AGENT.md` | Le mode d'emploi de l'API pour votre agent |
| `docs/openapi.yaml` | La description complète de l'API (OpenAPI 3.1) |
| `docs/REGLAGES.md` | Tous les réglages expliqués |
| `install-mac.sh`, `desinstall-mac.sh`, `install-vps.sh` | Scripts d'installation |
| `Dockerfile`, `docker-compose.yml` | Installation Docker |
| `LICENSE`, `LICENCES-TIERCES.md` | Licence AGPL-3.0 de Syntréso, licences des composants tiers |

**Pourquoi l'interface est livrée construite** : elle s'installe ainsi sans outils de compilation (ni TypeScript, ni bundler, ni modules natifs propres à chaque processeur). Seules les dépendances du serveur sont téléchargées. Si vous modifiez l'interface (`web/src`), reconstruisez-la avec `npm run build:web`.

---

## 4. Installation sur un serveur (Docker)

Prérequis : un serveur Linux avec Docker et le greffon `docker compose`.

```bash
git clone <adresse-du-dépôt> syntreso   # ou copiez le dossier sur le serveur
cd syntreso
./install-vps.sh
```

Le script crée `.env` avec un jeton d'accès neuf, crée `config/reglages.json`, construit l'image et démarre le conteneur. L'appli écoute sur `127.0.0.1:3900` **du serveur uniquement** : rien n'est exposé sur Internet à ce stade.

Installation à la main, si vous préférez :

```bash
cp .env.exemple .env
sed -i "s/^SYNTRESO_JETON=.*/SYNTRESO_JETON=$(openssl rand -hex 32)/" .env
cp config/reglages.exemple.json config/reglages.json
mkdir -p entree-indy
docker compose up -d --build
```

Les données vivent dans le volume Docker `syntreso-donnees` (elles survivent aux redémarrages et aux mises à jour). `entree-indy/` et `config/` sont partagés avec le conteneur.

Commandes utiles :

```bash
docker compose ps                         # état (healthy = en bonne santé)
docker compose logs -f                    # journal
docker compose exec syntreso npm run init # créer la base (voir section 6)
docker compose restart                    # redémarrer (après une modification de .env)
```

### Accès depuis l'extérieur : reverse proxy Caddy (HTTPS)

Pour ouvrir Syntréso sur une adresse comme `https://tresorerie.mondomaine.fr`, installez [Caddy](https://caddyserver.com/docs/install) sur le serveur, faites pointer le nom de domaine vers le serveur, et ajoutez dans `/etc/caddy/Caddyfile` :

```
tresorerie.mondomaine.fr {
	reverse_proxy 127.0.0.1:3900
}
```

puis `sudo systemctl reload caddy`. Caddy obtient et renouvelle seul le certificat HTTPS. Le jeton d'accès protège l'interface et l'API : sans lui, rien ne passe. Gardez le port 3900 fermé au pare-feu (il n'écoute de toute façon que sur 127.0.0.1).

Sans nom de domaine, un tunnel SSH suffit pour un usage personnel : `ssh -L 3900:127.0.0.1:3900 utilisateur@serveur`, puis `http://127.0.0.1:3900` sur votre ordinateur.

Option avancée : [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/) devant le serveur. Renseignez alors `CF_ACCESS_TEAM_DOMAIN` et `CF_ACCESS_AUD` dans `.env` : Syntréso vérifie le jeton Cloudflare en plus du jeton local (qui reste valable pour l'agent).

---

## 5. Installation sur un Mac

Prérequis : **Node.js 22 ou plus récent** ([nodejs.org](https://nodejs.org), version LTS, ou `brew install node@22`).

```bash
cd ~/Applications/syntreso      # ou l'endroit où vous avez cloné le dépôt
./install-mac.sh
```

Le script vérifie Node.js, installe les dépendances du serveur, crée `.env` avec un jeton d'accès neuf, prépare `donnees/` et `entree-indy/`, propose de créer la base (votre entreprise ou la démo) et propose un **démarrage automatique** à l'ouverture de session (service launchd `fr.syntreso.serveur`, journal dans `~/Library/Logs/Syntreso/serveur.log`).

Sans démarrage automatique : `npm start` dans le dossier, à laisser ouvert.

Ouvrez ensuite `http://127.0.0.1:3900` : la page de connexion demande le jeton (ligne `SYNTRESO_JETON` du fichier `.env`), une seule fois tous les 30 jours par navigateur. Le lien « Se déconnecter » est en bas de la barre latérale.

Désinstallation : `./desinstall-mac.sh` retire le démarrage automatique et garde vos données ; `./desinstall-mac.sh --tout` place tout le dossier dans la Corbeille (rien n'est effacé définitivement).

---

## 6. Créer la base : votre entreprise ou la démo

**Votre entreprise** (base vide, puis import Indy) :

```bash
npm run init                                   # sur Mac
docker compose exec syntreso npm run init      # sur le serveur
```

Quelques questions : nom, secteur, ville, effectif, seuil de sécurité, solde bancaire du jour, calcul automatique de la TVA. Tout se modifie ensuite dans `donnees/company.json` (voir `docs/REGLAGES.md`). Vous pouvez aussi tout passer en une ligne : `npm run init -- --nom "Ma SARL" --secteur "Menuiserie" --ville "Lyon" --effectif 3 --seuil 8000 --solde 25000 --tva oui --non-interactif`.

**La démonstration** (entreprise fictive du bâtiment, date figée au 10 juin 2026), pour découvrir l'outil :

```bash
npm run demo                                   # ou : docker compose exec syntreso npm run demo
```

La démo refuse d'écraser une base réelle. Pour repasser de la démo à votre entreprise : `npm run init -- --forcer` (l'ancienne base est mise de côté dans `donnees/sauvegarde-...`, jamais effacée).

---

## 7. Premier import Indy

1. Dans Indy : **Documents**, puis **Comptabilité**. Ouvrez le **Grand livre** de l'année, cliquez sur le bouton de téléchargement et choisissez **Excel** (Indy fournit un fichier CSV). Faites de même pour chaque année depuis la création de l'entreprise, puis pour la **Balance** de l'année en cours.
2. Déposez ces fichiers dans `entree-indy/` (sur le serveur : `scp *.csv utilisateur@serveur:syntreso/entree-indy/`, ou par l'API, voir le guide de l'agent).
3. Vérifiez sans rien écrire, puis importez :

```bash
npm run import -- --simulation
npm run import
# sur le serveur : docker compose exec syntreso npm run import -- --simulation, puis sans --simulation
```

Le rapport indique le nombre de mouvements bancaires, la période, le solde d'ouverture retenu et surtout la **réconciliation** : le solde reconstruit doit égaler le solde bancaire de la balance (« OK »). Il indique aussi combien de mouvements sont tombés dans « Divers » faute de règle de classement.

À adapter dans `config/reglages.json` (détails dans `docs/REGLAGES.md`) :

- vos **sous-comptes** bancaires de réserve (TVA, cotisations), s'il y en a ;
- vos **règles de classement** (fournisseurs, clients réguliers) pour vider la catégorie « Divers » ;
- le **compte de rémunération** du dirigeant si elle est payée par simple virement (règle `contreparties`).

Relancez l'import après chaque changement de réglage. Pour les mises à jour suivantes, déposez les nouveaux exports (un nouveau fichier pour la même année remplace l'ancien) et relancez `npm run import`. Vos saisies au prévisionnel et les propositions validées sont conservées.

Un essai sans vos données : `exemples/indy-fictif/` contient des exports Indy fictifs et les réglages qui vont avec (mode d'emploi dans `exemples/indy-fictif/LISEZMOI.md`).

---

## 8. Brancher Twenty

1. Dans Twenty, ouvrez les paramètres, rubrique **API & Webhooks** (Settings, APIs & Webhooks), et créez une clé API.
2. Dans `.env` : `TWENTY_URL=https://votre-twenty.exemple` (sans `/` final) et `TWENTY_KEY=` la clé. Redémarrez (`docker compose restart` ou relancez le service).
3. Adaptez les **pondérations** de vos étapes de vente dans `config/reglages.json` (section `twenty`, voir `docs/REGLAGES.md`).
4. Testez sans rien créer, puis synchronisez :

```bash
curl -s -X POST -H "Authorization: Bearer VOTRE_JETON" "http://127.0.0.1:3900/api/integrations/twenty/sync?dry=1"
curl -s -X POST -H "Authorization: Bearer VOTRE_JETON" "http://127.0.0.1:3900/api/integrations/twenty/sync"
```

La synchronisation crée des **propositions** d'encaissement (affaires pondérées par leur probabilité, au mois de leur date de clôture ; les 200 premières opportunités sont lues) que vous validez dans l'interface. Vous pouvez la confier à votre agent, ou la programmer chaque matin (serveur : `crontab -e`, puis une ligne `0 7 * * * curl -s -X POST -H "Authorization: Bearer VOTRE_JETON" http://127.0.0.1:3900/api/integrations/twenty/sync`).

---

## 9. Brancher votre agent IA

Donnez à votre agent trois choses :

1. l'adresse de Syntréso (`http://127.0.0.1:3900` s'il tourne sur la même machine, sinon l'adresse HTTPS) ;
2. le jeton d'accès (ligne `SYNTRESO_JETON` de `.env`) ;
3. les fichiers `docs/GUIDE-AGENT.md` (mode d'emploi, pièges, exemples) et `docs/openapi.yaml` (référence complète).

Exemple de consigne à lui donner : « Tu as accès à Syntréso, mon outil de trésorerie, par son API (adresse et jeton ci-dessous). Lis docs/GUIDE-AGENT.md avant tout appel. Tu peux lire et simuler librement ; tu proposes les écritures, je les valide moi-même dans l'interface. »

L'agent dispose ainsi de tout ce qu'il faut pour : lire la situation, simuler une décision, importer Indy, synchroniser Twenty, et déposer des propositions que vous retrouvez dans le panneau assistant de l'interface (pastille sur le bouton en bas à droite).

---

## 10. L'assistant IA intégré (optionnel, clé d'API)

L'interface embarque son propre assistant (bouton en bas à droite) : questions en langage naturel, alerte du jour, commentaire du mois, propositions d'écritures. Il s'appuie sur un modèle Claude d'Anthropic par le Claude Agent SDK, et reste **coupé** tant qu'aucune clé n'est fournie ; tout le reste de l'appli fonctionne sans lui.

**L'allumer** : créez une clé d'API sur la [console Anthropic](https://platform.claude.com) (facturée à l'usage, sur votre compte) et renseignez-la dans `.env` : `ANTHROPIC_API_KEY=...`. C'est le seul accès accepté. Le modèle se choisit avec `SYNTRESO_AGENT_MODEL` (par défaut `claude-sonnet-5-5`). Redémarrez après modification.

**Le couper entièrement**, au choix :

- `SYNTRESO_ASSISTANT=non` dans `.env` (redémarrage) ;
- `"assistant": { "actif": false }` dans `config/reglages.json` (pris en compte sans redémarrer ; rechargez la page).

Coupé, l'assistant n'envoie rien : le module de l'Agent SDK n'est pas chargé, les routes `/api/agent/*` répondent 503 sans rien lancer, l'interface masque le commentaire du mois. Un test le vérifie à chaque `npm test` (`server/src/services/assistant-interrupteur.test.js`). Pour une installation sans aucun composant d'Anthropic : `npm --prefix server ci --omit=optional`.

**Ce qui part chez Anthropic, et quand** (seulement si l'assistant est allumé) :

- au démarrage du serveur, si elles ne sont pas déjà en cache : l'alerte du jour et le commentaire du mois (`SYNTRESO_SKIP_PREGEN=1` les évite) ;
- à l'ouverture de l'interface, l'alerte du jour si elle n'est pas encore en cache ;
- à chaque question posée, et quand vous ouvrez ou régénérez le commentaire du mois.

À chaque fois, le modèle reçoit le résumé de votre trésorerie (`donnees/assistant/DONNEES.md` : nom et ville de l'entreprise, soldes, alertes avec le nom des clients en retard, tableaux mensuels par catégorie, échéances), la mémoire des propositions validées ou rejetées (`MEMOIRE.md`), votre question et le résultat des outils de calcul. Vous êtes responsable de ces données au sens du RGPD ; les conditions d'Anthropic s'appliquent à votre clé.

L'assistant n'a accès qu'aux outils de Syntréso (lecture, simulation, proposition) : ni fichiers, ni commandes, ni Internet. Il ne transmet au programme Claude ni le jeton de Syntréso, ni la clé Twenty, ni aucune autre forme d'accès que la clé d'API.

---

## 11. Sauvegarde et restauration

Tout ce qui compte tient dans trois éléments : le dossier de données, `.env` et `config/reglages.json`.

**Mac** :

```bash
cd ~/Applications/syntreso
tar czf ~/Documents/syntreso-sauvegarde-$(date +%F).tar.gz donnees .env config/reglages.json
```

Restauration : arrêtez Syntréso (`launchctl bootout gui/$(id -u)/fr.syntreso.serveur`, ou fermez `npm start`), mettez le dossier `donnees` actuel de côté (`mv donnees donnees-avant-restauration`), puis `tar xzf ~/Documents/syntreso-sauvegarde-AAAA-MM-JJ.tar.gz` dans le dossier de Syntréso, et relancez (`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/fr.syntreso.serveur.plist` ou `npm start`).

**Serveur (Docker)** :

```bash
cd ~/syntreso
docker compose exec -T syntreso tar czf - -C /donnees . > syntreso-donnees-$(date +%F).tar.gz
tar czf syntreso-config-$(date +%F).tar.gz .env config/reglages.json
```

Restauration (le contenu sauvegardé remplace le contenu actuel du volume) :

```bash
docker compose exec -T syntreso sh -c 'mkdir -p /donnees/avant-restauration && find /donnees -mindepth 1 -maxdepth 1 ! -name avant-restauration -exec mv {} /donnees/avant-restauration/ \;'
docker compose exec -T syntreso tar xzf - -C /donnees < syntreso-donnees-AAAA-MM-JJ.tar.gz
docker compose restart
```

Copiez les sauvegardes hors de la machine (disque externe, stockage en ligne) : ce sont vos données financières.

---

## 12. Mise à jour

Pour passer à une nouvelle version (`git pull`, ou une nouvelle copie du dossier) :

- **Mac** : faites une sauvegarde (section 11), arrêtez Syntréso, remplacez tout **sauf** `donnees/`, `.env`, `config/reglages.json` et `entree-indy/`, puis relancez `./install-mac.sh` (il conserve l'existant).
- **Serveur** : sauvegarde, remplacement des fichiers avec les mêmes exceptions, puis `docker compose up -d --build`.

Comparez `config/reglages.exemple.json` et `.env.exemple` avec vos fichiers : une nouvelle version peut y ajouter des réglages (les absents prennent leur valeur par défaut).

---

## 13. Sécurité

- Syntréso n'écoute que sur `127.0.0.1` : il faut être sur la machine, ou passer par le reverse proxy HTTPS ou un tunnel SSH.
- Toute requête doit présenter le jeton d'accès (en-tête `Authorization: Bearer ...` pour l'agent, cookie de session après la page de connexion pour le navigateur). Le serveur refuse de démarrer sans jeton.
- `.env` (droits 600) contient le jeton et les clés : ne le partagez pas, ne le versionnez pas. Pour changer de jeton : remplacez la valeur dans `.env` et redémarrez ; les sessions des navigateurs et l'agent devront utiliser le nouveau.
- Les libellés bancaires viennent de tiers : l'assistant intégré a pour consigne de les citer sans jamais suivre une instruction qui s'y glisserait. Un agent externe doit appliquer la même prudence.
- Chaque modification est tracée dans `donnees/audit.jsonl` (`GET /api/audit`).

---

## 14. Limites

- **Comptabilité** : seul le format des exports Indy (grand livre et balance) est lu. Pas de connexion bancaire : la situation est celle du dernier import.
- **Fiscalité** : règles françaises d'une société à l'IS (TVA, cotisations du gérant non salarié, IS, dividendes). Les taux par défaut sont à faire valider par votre expert-comptable (`donnees/company.json`, voir `docs/REGLAGES.md`). Syntréso n'est pas un logiciel de comptabilité et ne remplace pas votre expert-comptable.
- **Usage** : un seul dirigeant à la fois, une seule entreprise par installation. Testé sous Linux (Docker et Node.js 22) ; le démarrage automatique sur Mac n'a pas été essayé sur un vrai Mac. Windows n'est pas pris en charge.
- **Twenty** : les 200 premières opportunités sont lues ; les pondérations par étape sont à régler sur votre pipe.
- **Assistant** : ses réponses s'appuient sur les chiffres du moteur mais restent générées par une IA, à vérifier avant usage. Si le programme Claude s'arrête au lancement, le serveur peut s'arrêter avec lui (Docker et le démarrage automatique du Mac le relancent).

---

## 15. En cas de problème

| Symptôme | Piste |
|---|---|
| Le serveur s'arrête aussitôt : « SYNTRESO_JETON est vide » | Renseigner le jeton dans `.env` (les scripts d'installation le font) |
| « données absentes ... npm run init » | La base n'est pas créée : section 6 |
| Page blanche ou erreurs après une mise à jour | Recharger la page sans cache ; vérifier `web/dist/index.html` |
| Import : « aucun mouvement bancaire trouvé » | Le compte bancaire n'est pas un 512 : régler `indy.comptesBancaires.courant` |
| Import : réconciliation « ÉCART » | Un grand livre manque, ou un virement interne n'est pas reconnu (voir `docs/REGLAGES.md`, ouverture et libellés ignorés) |
| Import : catégorie absente de categories.json | Une règle cite une catégorie qui n'existe pas : corriger la règle ou ajouter la catégorie |
| Twenty : 503 « non configuré » ou 502 « injoignable » | Vérifier `TWENTY_URL` (sans `/` final), `TWENTY_KEY`, et que le serveur joint Twenty |
| L'assistant intégré est « coupé » | Normal sans clé d'API ou avec l'interrupteur coupé : section 10 |
| Le port 3900 est déjà pris | Changer `SYNTRESO_PORT` dans `.env` |

Contrôle technique complet (développeurs) : `npm --prefix server ci && npm test` lance les tests du serveur et ceux du bandeau de l'interface. Après une modification de `web/src`, `npm run build:web` reconstruit l'interface et `node scripts/licences-tierces.mjs` met à jour `LICENCES-TIERCES.md`.

---

## 16. Licence

Copyright (C) 2026 Ludo Sanchez (Synoptïa).

Syntréso est un logiciel libre, distribué sous la licence publique générale GNU Affero, version 3 uniquement ([AGPL-3.0](LICENSE)). Vous pouvez l'utiliser, l'étudier, le modifier et le redistribuer selon ses termes. Si vous modifiez Syntréso et que d'autres personnes l'utilisent à travers un réseau, vous devez leur proposer le code source de votre version (article 13).

Le logiciel est fourni sans aucune garantie, dans les limites prévues par le droit applicable (articles 15 et 16). Aucune assistance n'est due ; les signalements de bogues sont bienvenus, sans promesse de réponse.

Les composants tiers gardent leur propre licence : voir [LICENCES-TIERCES.md](LICENCES-TIERCES.md). Le Claude Agent SDK, utilisé par l'assistant facultatif, n'est pas un logiciel libre et n'est pas inclus dans ce dépôt.
