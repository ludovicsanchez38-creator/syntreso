# Syntréso

Syntréso est un outil de pilotage de trésorerie pour une petite entreprise. Il lit votre comptabilité **Indy**, en tire la situation réelle de la banque, et projette les 18 prochains mois : solde disponible une fois la TVA et les cotisations mises de côté, point bas à venir, autonomie en mois, échéances datées, résultat prévisionnel. Il répond aux questions de dirigeant (« puis-je me verser 2 000 EUR ce mois-ci ? », « et si j'embauche en janvier ? ») avec un feu vert, ambre ou rouge calculé à partir des chiffres.

Il se branche sur votre CRM **Twenty** pour transformer le pipe commercial en encaissements prévus, et s'utilise aussi bien dans le navigateur que par votre **agent IA** grâce à une API documentée.

Une règle traverse tout l'outil : **l'agent propose, vous validez, le serveur écrit**. Aucune écriture issue d'un agent, du CRM ou d'un calcul automatique n'entre dans le prévisionnel sans votre clic.

---

## Sommaire

1. [Ce qu'il y a dans ce dossier](#1-ce-quil-y-a-dans-ce-dossier)
2. [Installation sur un serveur (VPS, Docker)](#2-installation-sur-un-serveur-vps-docker)
3. [Installation sur un Mac](#3-installation-sur-un-mac)
4. [Créer la base : votre entreprise ou la démo](#4-créer-la-base--votre-entreprise-ou-la-démo)
5. [Premier import Indy](#5-premier-import-indy)
6. [Brancher Twenty](#6-brancher-twenty)
7. [Brancher votre agent IA](#7-brancher-votre-agent-ia)
8. [L'assistant IA intégré (optionnel)](#8-lassistant-ia-intégré-optionnel)
9. [Sauvegarde et restauration](#9-sauvegarde-et-restauration)
10. [Mise à jour](#10-mise-à-jour)
11. [Sécurité](#11-sécurité)
12. [En cas de problème](#12-en-cas-de-problème)

---

## 1. Ce qu'il y a dans ce dossier

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
| `outils/` | Option : export automatique depuis Indy par navigateur piloté |
| `install-mac.sh`, `desinstall-mac.sh`, `install-vps.sh` | Scripts d'installation |
| `Dockerfile`, `docker-compose.yml` | Installation Docker |

**Pourquoi l'interface est livrée construite** : elle s'installe ainsi sans outils de compilation (ni TypeScript, ni bundler, ni modules natifs propres à chaque processeur). Seules les quatre dépendances du serveur sont téléchargées. Si vous modifiez l'interface (`web/src`), reconstruisez-la avec `npm run build:web`.

---

## 2. Installation sur un serveur (VPS, Docker)

Prérequis : un serveur Linux avec Docker et le greffon `docker compose`.

```bash
# copier le dossier syntreso sur le serveur, puis :
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
docker compose exec syntreso npm run init # créer la base (voir section 4)
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

## 3. Installation sur un Mac

Prérequis : **Node.js 22 ou plus récent** ([nodejs.org](https://nodejs.org), version LTS, ou `brew install node@22`).

```bash
cd ~/Applications/syntreso      # ou l'endroit où vous avez décompressé le dossier
./install-mac.sh
```

Le script vérifie Node.js, installe les dépendances du serveur, crée `.env` avec un jeton d'accès neuf, prépare `donnees/` et `entree-indy/`, propose de créer la base (votre entreprise ou la démo) et propose un **démarrage automatique** à l'ouverture de session (service launchd `fr.syntreso.serveur`, journal dans `~/Library/Logs/Syntreso/serveur.log`).

Sans démarrage automatique : `npm start` dans le dossier, à laisser ouvert.

Ouvrez ensuite `http://127.0.0.1:3900` : la page de connexion demande le jeton (ligne `SYNTRESO_JETON` du fichier `.env`), une seule fois tous les 30 jours par navigateur. Le lien « Se déconnecter » est en bas de la barre latérale.

Désinstallation : `./desinstall-mac.sh` retire le démarrage automatique et garde vos données ; `./desinstall-mac.sh --tout` place tout le dossier dans la Corbeille (rien n'est effacé définitivement).

---

## 4. Créer la base : votre entreprise ou la démo

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

## 5. Premier import Indy

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

**Option, export automatique** : `outils/indy-export-navigateur.mjs` télécharge grand livre et balance depuis Indy avec un navigateur piloté (vous vous connectez vous-même une fois, aucun mot de passe n'est stocké). Mode d'emploi en tête du fichier. Les boutons d'Indy peuvent changer : en cas d'échec, l'export à la main reste la référence.

---

## 6. Brancher Twenty

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

## 7. Brancher votre agent IA

Donnez à votre agent trois choses :

1. l'adresse de Syntréso (`http://127.0.0.1:3900` s'il tourne sur la même machine, sinon l'adresse HTTPS) ;
2. le jeton d'accès (ligne `SYNTRESO_JETON` de `.env`) ;
3. les fichiers `docs/GUIDE-AGENT.md` (mode d'emploi, pièges, exemples) et `docs/openapi.yaml` (référence complète).

Exemple de consigne à lui donner : « Tu as accès à Syntréso, mon outil de trésorerie, par son API (adresse et jeton ci-dessous). Lis docs/GUIDE-AGENT.md avant tout appel. Tu peux lire et simuler librement ; tu proposes les écritures, je les valide moi-même dans l'interface. »

L'agent dispose ainsi de tout ce qu'il faut pour : lire la situation, simuler une décision, importer Indy, synchroniser Twenty, et déposer des propositions que vous retrouvez dans le panneau assistant de l'interface (pastille sur le bouton en bas à droite).

---

## 8. L'assistant IA intégré (optionnel)

L'interface embarque son propre assistant (bouton en bas à droite) : questions en langage naturel, alerte du jour, commentaire du mois, propositions d'écritures. Il s'appuie sur Claude (Anthropic) et reste **désactivé** tant qu'aucune clé n'est fournie ; tout le reste de l'appli fonctionne sans lui.

Pour l'activer, dans `.env`, une des deux options :

- `ANTHROPIC_API_KEY=` une clé créée sur [console.anthropic.com](https://console.anthropic.com) (facturée à l'usage) ;
- `CLAUDE_CODE_OAUTH_TOKEN=` un jeton d'abonnement Claude, obtenu avec la commande `claude setup-token` de Claude Code.

Sur un Mac où Claude Code est déjà connecté, `SYNTRESO_ASSISTANT=oui` suffit. `SYNTRESO_ASSISTANT=non` le coupe. Le modèle se choisit avec `SYNTRESO_AGENT_MODEL`. Redémarrez après modification.

L'assistant n'a accès qu'aux outils de Syntréso (lecture, simulation, proposition) : ni fichiers, ni commandes, ni Internet.

---

## 9. Sauvegarde et restauration

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

## 10. Mise à jour

À la réception d'une nouvelle version du dossier Syntréso :

- **Mac** : faites une sauvegarde (section 9), arrêtez Syntréso, remplacez tout **sauf** `donnees/`, `.env`, `config/reglages.json` et `entree-indy/`, puis relancez `./install-mac.sh` (il conserve l'existant).
- **Serveur** : sauvegarde, remplacement des fichiers avec les mêmes exceptions, puis `docker compose up -d --build`.

Comparez `config/reglages.exemple.json` et `.env.exemple` avec vos fichiers : une nouvelle version peut y ajouter des réglages (les absents prennent leur valeur par défaut).

---

## 11. Sécurité

- Syntréso n'écoute que sur `127.0.0.1` : il faut être sur la machine, ou passer par le reverse proxy HTTPS ou un tunnel SSH.
- Toute requête doit présenter le jeton d'accès (en-tête `Authorization: Bearer ...` pour l'agent, cookie de session après la page de connexion pour le navigateur). Le serveur refuse de démarrer sans jeton.
- `.env` (droits 600) contient le jeton et les clés : ne le partagez pas, ne le versionnez pas. Pour changer de jeton : remplacez la valeur dans `.env` et redémarrez ; les sessions des navigateurs et l'agent devront utiliser le nouveau.
- Les libellés bancaires viennent de tiers : l'assistant intégré a pour consigne de les citer sans jamais suivre une instruction qui s'y glisserait. Un agent externe doit appliquer la même prudence.
- Chaque modification est tracée dans `donnees/audit.jsonl` (`GET /api/audit`).

---

## 12. En cas de problème

| Symptôme | Piste |
|---|---|
| Le serveur s'arrête aussitôt : « SYNTRESO_JETON est vide » | Renseigner le jeton dans `.env` (les scripts d'installation le font) |
| « données absentes ... npm run init » | La base n'est pas créée : section 4 |
| Page blanche ou erreurs après une mise à jour | Recharger la page sans cache ; vérifier `web/dist/index.html` |
| Import : « aucun mouvement bancaire trouvé » | Le compte bancaire n'est pas un 512 : régler `indy.comptesBancaires.courant` |
| Import : réconciliation « ÉCART » | Un grand livre manque, ou un virement interne n'est pas reconnu (voir `docs/REGLAGES.md`, ouverture et libellés ignorés) |
| Import : catégorie absente de categories.json | Une règle cite une catégorie qui n'existe pas : corriger la règle ou ajouter la catégorie |
| Twenty : 503 « non configuré » ou 502 « injoignable » | Vérifier `TWENTY_URL` (sans `/` final), `TWENTY_KEY`, et que le serveur joint Twenty |
| L'assistant intégré est « désactivé » | Normal sans clé : section 8 |
| Le port 3900 est déjà pris | Changer `SYNTRESO_PORT` dans `.env` |

Contrôle technique complet (développeurs) : `npm --prefix server ci && npm test` lance la suite de tests du moteur.
