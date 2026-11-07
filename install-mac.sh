#!/usr/bin/env bash
# Installation de Syntréso sur un Mac.
#
#   ./install-mac.sh                 installation guidée
#   ./install-mac.sh --sans-launchd  sans démarrage automatique (et sans question à ce sujet)
#   ./install-mac.sh --oui           répond oui aux questions (démarrage automatique compris)
#
# Ce que fait le script : vérifie Node.js 22 ou plus, installe les dépendances du serveur,
# crée le fichier .env avec un jeton d'accès neuf, prépare les dossiers, propose de créer
# la base (vide ou démo), et propose un démarrage automatique à l'ouverture de session.
# Il peut être relancé sans risque : il ne remplace ni .env, ni les réglages, ni les données.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RACINE"

SANS_LAUNCHD=0
OUI=0
for arg in "$@"; do
  case "$arg" in
    --sans-launchd) SANS_LAUNCHD=1 ;;
    --oui) OUI=1 ;;
    -h|--aide) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

LABEL="fr.syntreso.serveur"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/Syntreso"

info() { printf '\n== %s\n' "$1"; }
demander() {
  # demander "question" -> 0 si oui
  local reponse
  if [ "$OUI" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  read -r -p "$1 [o/N] " reponse
  case "$reponse" in o|O|oui|OUI|y|Y) return 0 ;; *) return 1 ;; esac
}

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Attention : ce script est prévu pour macOS (système détecté : $(uname -s))."
  if [ "$SANS_LAUNCHD" != 1 ]; then
    echo "Sur un serveur Linux, utilisez plutôt Docker (./install-vps.sh). Pour un essai : --sans-launchd."
    exit 1
  fi
fi

info "1/6 Vérification de Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js n'est pas installé. Installez la version 22 (ou plus récente) :"
  echo "  - téléchargement : https://nodejs.org (version LTS)"
  echo "  - ou avec Homebrew : brew install node@22"
  exit 1
fi
VERSION_NODE="$(node -p 'process.versions.node')"
MAJEURE="${VERSION_NODE%%.*}"
if [ "$MAJEURE" -lt 22 ]; then
  echo "Node.js $VERSION_NODE détecté : Syntréso demande la version 22 ou plus récente."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm est introuvable (il est normalement livré avec Node.js)."
  exit 1
fi
echo "Node.js $VERSION_NODE : ok"

info "2/6 Installation des dépendances du serveur"
npm --prefix server ci --omit=dev --no-audit --no-fund

info "3/6 Interface web"
if [ -f web/dist/index.html ]; then
  echo "Interface déjà construite (web/dist) : rien à faire."
else
  echo "Construction de l'interface (quelques minutes)..."
  npm --prefix web ci --no-audit --no-fund
  npm --prefix web run build
fi

info "4/6 Configuration"
if [ -f .env ]; then
  echo ".env existe déjà : conservé."
else
  cp .env.exemple .env
  JETON="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
  node -e "
    const fs = require('node:fs')
    const s = fs.readFileSync('.env', 'utf8').replace(/^SYNTRESO_JETON=.*$/m, 'SYNTRESO_JETON=' + process.argv[1])
    fs.writeFileSync('.env', s)
  " "$JETON"
  echo ".env créé avec un jeton d'accès neuf."
fi
chmod 600 .env
if [ -f config/reglages.json ]; then
  echo "config/reglages.json existe déjà : conservé."
else
  cp config/reglages.exemple.json config/reglages.json
  echo "config/reglages.json créé à partir de l'exemple (à adapter, voir docs/REGLAGES.md)."
fi
mkdir -p donnees entree-indy
chmod 700 donnees

info "5/6 Données"
if [ -f donnees/company.json ]; then
  echo "Une base existe déjà dans donnees/ : conservée."
elif [ -t 0 ] && [ "$OUI" != 1 ]; then
  echo "Que voulez-vous charger ?"
  echo "  1) Ma propre entreprise (base vide, puis import Indy)"
  echo "  2) La démonstration (entreprise fictive)"
  echo "  3) Rien pour l'instant"
  read -r -p "Votre choix [1] : " CHOIX
  case "${CHOIX:-1}" in
    1) node scripts/init-base.mjs ;;
    2) node scripts/demo.mjs ;;
    *) echo "Plus tard : npm run init (base vide) ou npm run demo." ;;
  esac
else
  echo "Aucune base. Plus tard : npm run init (base vide) ou npm run demo (démonstration)."
fi

info "6/6 Démarrage automatique"
NODE_BIN="$(command -v node)"
if [ "$SANS_LAUNCHD" = 1 ]; then
  echo "Ignoré (--sans-launchd). Lancement manuel : npm start"
elif demander "Démarrer Syntréso automatiquement à l'ouverture de session ?"; then
  mkdir -p "$(dirname "$PLIST")" "$LOGS"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$RACINE/server/src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$RACINE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/serveur.log</string>
  <key>StandardErrorPath</key><string>$LOGS/serveur.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    launchctl load -w "$PLIST"
  fi
  echo "Service installé ($PLIST). Journal : $LOGS/serveur.log"
else
  echo "Pas de démarrage automatique. Lancement manuel : npm start"
fi

PORT="$(grep -E '^SYNTRESO_PORT=' .env | cut -d= -f2)"
PORT="${PORT:-3900}"
cat <<FIN

Syntréso est installé.
  Adresse        : http://127.0.0.1:$PORT
  Jeton d'accès  : ligne SYNTRESO_JETON du fichier $RACINE/.env
                   (à coller une fois dans la page de connexion, et à donner à votre agent)
  Import Indy    : déposez les exports dans entree-indy/ puis : npm run import
  Documentation  : README.md, docs/GUIDE-AGENT.md
FIN
