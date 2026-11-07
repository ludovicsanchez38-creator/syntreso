# Syntréso - image du serveur (API + interface web déjà construite dans web/dist).
#
# Construction : docker compose build   (ou docker build -t syntreso .)
# Les données vivent dans le volume /donnees, jamais dans l'image.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    SYNTRESO_HOST=0.0.0.0 \
    SYNTRESO_PORT=3900 \
    SYNTRESO_DATA_DIR=/donnees \
    SYNTRESO_ENTREE_INDY=/entree-indy \
    SYNTRESO_REGLAGES=/app/config/reglages.json

WORKDIR /app

# Dépendances du serveur seules (le front est livré construit dans web/dist).
COPY server/package.json server/package-lock.json server/
RUN npm --prefix server ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY package.json ./
COPY server/src server/src
COPY web/dist web/dist
COPY scripts scripts
COPY modeles modeles
COPY agent-workspace agent-workspace
COPY config/reglages.exemple.json config/reglages.exemple.json
COPY exemples exemples

RUN mkdir -p /donnees /entree-indy && chown -R node:node /donnees /entree-indy /app/config
USER node

EXPOSE 3900
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3900/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
