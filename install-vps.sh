#!/usr/bin/env bash
# Installation de Syntréso sur un serveur Linux avec Docker.
#
#   ./install-vps.sh
#
# Crée .env (jeton d'accès neuf) et config/reglages.json s'ils n'existent pas, prépare le
# dossier entree-indy/, construit l'image et démarre le conteneur. Relançable sans risque.
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RACINE"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "Docker et le greffon « docker compose » sont nécessaires : https://docs.docker.com/engine/install/"
  exit 1
fi

if [ -f .env ]; then
  echo ".env existe déjà : conservé."
else
  cp .env.exemple .env
  JETON="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  sed -i "s/^SYNTRESO_JETON=.*/SYNTRESO_JETON=$JETON/" .env
  echo ".env créé avec un jeton d'accès neuf."
fi
chmod 600 .env

if [ ! -f config/reglages.json ]; then
  cp config/reglages.exemple.json config/reglages.json
  echo "config/reglages.json créé à partir de l'exemple."
fi

mkdir -p entree-indy
# Le conteneur tourne avec l'utilisateur « node » (uid 1000) : il doit pouvoir écrire
# dans entree-indy/ pour le dépôt de fichiers par l'API.
if [ "$(id -u)" != "1000" ]; then
  chmod o+rwx entree-indy
  echo "Note : entree-indy/ ouvert en écriture au conteneur (votre uid n'est pas 1000)."
fi

docker compose up -d --build

# port publié : variable d'environnement si elle est posée (prioritaire pour docker compose), sinon .env
PORT="${SYNTRESO_PORT:-$(grep -E '^SYNTRESO_PORT=' .env | cut -d= -f2)}"
PORT="${PORT:-3900}"
printf 'Attente du démarrage'
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then echo ' : ok'; break; fi
  printf '.'; sleep 1
done

cat <<FIN

Syntréso tourne sur http://127.0.0.1:$PORT (accessible depuis ce serveur uniquement).
Étapes suivantes :
  - créer la base     : docker compose exec syntreso npm run init      (ou npm run demo)
  - importer Indy     : copier les exports dans entree-indy/ puis
                        docker compose exec syntreso npm run import
  - accès extérieur   : reverse proxy HTTPS (Caddy), voir README.md
  - jeton d'accès     : ligne SYNTRESO_JETON de $RACINE/.env
FIN
