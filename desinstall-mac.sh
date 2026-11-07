#!/usr/bin/env bash
# Désinstallation de Syntréso sur un Mac.
#
#   ./desinstall-mac.sh          arrête le service et retire le démarrage automatique ;
#                                les données (donnees/), le .env et les réglages restent en place
#   ./desinstall-mac.sh --tout   en plus, place le dossier Syntréso entier dans la Corbeille
#
# Rien n'est effacé définitivement : ce qui est retiré part dans la Corbeille (~/.Trash).
set -euo pipefail

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="fr.syntreso.serveur"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CORBEILLE="$HOME/.Trash"
HORODATAGE="$(date +%Y%m%d-%H%M%S)"

TOUT=0
for arg in "$@"; do
  case "$arg" in
    --tout) TOUT=1 ;;
    -h|--aide) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$CORBEILLE"

echo "== Arrêt du service"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
if [ -f "$PLIST" ]; then
  mv "$PLIST" "$CORBEILLE/$LABEL-$HORODATAGE.plist"
  echo "Démarrage automatique retiré (fichier placé dans la Corbeille)."
else
  echo "Aucun démarrage automatique installé."
fi

if [ "$TOUT" = 1 ]; then
  echo "== Dossier complet"
  echo "Le dossier $RACINE (données comprises) va être placé dans la Corbeille."
  read -r -p "Confirmer ? [o/N] " REPONSE
  case "$REPONSE" in
    o|O|oui|OUI)
      cd "$HOME"
      mv "$RACINE" "$CORBEILLE/syntreso-$HORODATAGE"
      echo "Dossier placé dans la Corbeille : $CORBEILLE/syntreso-$HORODATAGE"
      ;;
    *) echo "Annulé : le dossier reste en place." ;;
  esac
else
  echo "Données conservées dans $RACINE/donnees (et .env, config/reglages.json)."
  echo "Pour tout retirer : ./desinstall-mac.sh --tout"
fi
