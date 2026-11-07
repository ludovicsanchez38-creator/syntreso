// Authentification à l'origine. Le serveur écoute sur 127.0.0.1 par défaut, mais cela
// ne suffit pas : tout programme de la machine (ou un reverse proxy mal réglé) pourrait
// lire et modifier des données financières. Toute requête doit donc prouver son
// identité, sauf /api/health (sonde de supervision, ne renvoie aucune donnée) et la
// page de connexion.
//
// Trois façons d'entrer :
//   1. Jeton d'accès (SYNTRESO_JETON, généré à l'installation) dans l'en-tête
//      `Authorization: Bearer <jeton>`. C'est le chemin de l'agent IA et des scripts.
//   2. Navigateur : la page /connexion demande le jeton une fois et pose un cookie
//      HttpOnly (identifiant aléatoire), expirant côté serveur après 30 jours.
//   3. Option : Cloudflare Access devant le serveur (CF_ACCESS_TEAM_DOMAIN +
//      CF_ACCESS_AUD). Le JWT `Cf-Access-Jwt-Assertion` est vérifié contre le JWKS de
//      l'équipe (signature, émetteur, audience).
//
// Sans aucune configuration, le serveur refuse de démarrer (voir index.js), sauf si
// SYNTRESO_SANS_AUTH=1 est posé explicitement (développement local uniquement).

import { createRemoteJWKSet, jwtVerify } from 'jose'
import { timingSafeEqual, randomBytes } from 'node:crypto'

export const COOKIE_NAME = 'syntreso_session'
const COOKIE_MAX_AGE_S = 30 * 24 * 3600

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

function readCookie(req, name) {
  const raw = (req.get && req.get('cookie')) || ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

function isHttps(req) {
  return Boolean(req.secure) || (req.get && req.get('x-forwarded-proto') === 'https')
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function loginPage(message = '') {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Syntréso - Connexion</title>
<style>
  :root { color-scheme: light dark; --fond: #f6f7f9; --carte: #ffffff; --texte: #111827; --doux: #6b7280; --bord: #e5e7eb; --primaire: #2563eb; --alerte: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --fond: #0b1020; --carte: #121a2e; --texte: #e5e7eb; --doux: #9ca3af; --bord: #273049; --primaire: #3b82f6; --alerte: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--fond); color: var(--texte); font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { width: 100%; max-width: 380px; background: var(--carte); border: 1px solid var(--bord); border-radius: 14px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 0 0 18px; color: var(--doux); font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid var(--bord); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
  button { margin-top: 14px; width: 100%; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--primaire); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .erreur { color: var(--alerte); margin: 12px 0 0; font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Syntréso</h1>
  <p>Pilotage de trésorerie. Saisissez le jeton d'accès créé à l'installation (fichier .env, ligne SYNTRESO_JETON).</p>
  <form method="post" action="/connexion">
    <label for="jeton">Jeton d'accès</label>
    <input id="jeton" name="jeton" type="password" autocomplete="current-password" required autofocus/>
    <button type="submit">Se connecter</button>
  </form>
  ${message ? `<p class="erreur">${escapeHtml(message)}</p>` : ''}
</main>
</body>
</html>`
}

/**
 * Fabrique le middleware. `jwks` est injectable pour les tests (createLocalJWKSet) ;
 * sinon il est construit depuis le domaine d'équipe Cloudflare.
 */
export function createAccessMiddleware({ teamDomain, aud, localToken, jwks } = {}) {
  const jwtEnabled = Boolean(teamDomain && aud)
  const enabled = jwtEnabled || Boolean(localToken)
  if (!enabled) {
    return Object.assign((_req, _res, next) => next(), { enabled: false })
  }
  const issuer = jwtEnabled ? `https://${teamDomain}` : null
  const keySet = jwks || (jwtEnabled ? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) : null)
  // Sessions propres au processus : un redémarrage les invalide toutes.
  const sessions = new Map()

  const middleware = async (req, res, next) => {
    const method = req.method || 'GET'
    if (req.path === '/api/health') return next()

    // --- page de connexion (jeton local uniquement)
    if (localToken && req.path === '/connexion') {
      if (method === 'GET') return res.type('html').send(loginPage())
      if (method === 'POST') {
        const proposed = String(req.body?.jeton || '').trim()
        if (proposed && safeEqual(proposed, localToken)) {
          const now = Date.now()
          for (const [id, expiresAt] of sessions) {
            if (expiresAt <= now) sessions.delete(id)
          }
          const session = randomBytes(32).toString('hex')
          sessions.set(session, now + COOKIE_MAX_AGE_S * 1000)
          const secure = isHttps(req) ? '; Secure' : ''
          res.setHeader('Set-Cookie', `${COOKIE_NAME}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure}`)
          return res.redirect(303, '/')
        }
        // petit délai : rend l'essai en rafale inutilement lent
        await new Promise((r) => setTimeout(r, 400))
        return res.status(401).type('html').send(loginPage('Jeton incorrect.'))
      }
    }
    if (localToken && req.path === '/deconnexion') {
      sessions.delete(readCookie(req, COOKIE_NAME))
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
      return res.redirect(303, '/connexion')
    }

    // --- Cloudflare Access (option)
    const assertion = req.get('cf-access-jwt-assertion')
    if (assertion && jwtEnabled) {
      try {
        await jwtVerify(assertion, keySet, { issuer, audience: aud })
        return next()
      } catch {
        return res.status(401).json({ error: 'jeton Cloudflare Access invalide' })
      }
    }

    // --- jeton local : en-tête Bearer (agent, scripts) ou cookie de session (navigateur)
    if (localToken) {
      const auth = req.get('authorization') || ''
      if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7).trim(), localToken)) return next()
      const cookie = readCookie(req, COOKIE_NAME)
      if (cookie && sessions.has(cookie)) {
        if (sessions.get(cookie) > Date.now()) return next()
        sessions.delete(cookie)
      }
    }

    // Navigateur sans session : renvoyer vers la page de connexion plutôt qu'un JSON.
    if (localToken && method === 'GET' && !String(req.path || '').startsWith('/api/')) {
      return res.redirect(302, '/connexion')
    }
    return res.status(401).json({ error: 'non autorisé : jeton manquant ou invalide (en-tête Authorization: Bearer <jeton>)' })
  }
  return Object.assign(middleware, { enabled: true })
}

/** Middleware configuré depuis l'environnement (SYNTRESO_JETON, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD). */
export function accessFromEnv() {
  return createAccessMiddleware({
    teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
    aud: process.env.CF_ACCESS_AUD,
    localToken: (process.env.SYNTRESO_JETON || '').trim() || undefined,
  })
}
