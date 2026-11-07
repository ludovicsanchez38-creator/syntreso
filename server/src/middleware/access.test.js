import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose'
import { createHash } from 'node:crypto'
import { createAccessMiddleware, COOKIE_NAME } from './access.js'

// JWKS local injecté : on teste la vérification (signature/issuer/audience) sans
// dépendre du réseau ni du vrai team Cloudflare.
const TEAM = 'equipe-test.example.com'
const AUD = 'aud-de-test'

let jwks
let signKey
let strangerKey
before(async () => {
  const pair = await generateKeyPair('RS256')
  signKey = pair.privateKey
  const stranger = await generateKeyPair('RS256')
  strangerKey = stranger.privateKey
  const jwk = await exportJWK(pair.publicKey)
  jwk.alg = 'RS256'
  jwks = createLocalJWKSet({ keys: [jwk] })
})

function makeReq(headers = {}, path = '/api/state', extra = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { path, get: (name) => h[name.toLowerCase()], ...extra }
}

async function run(mw, req) {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    location: null,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    type() { return this },
    send(b) { this.body = b; if (!this.statusCode) this.statusCode = 200; return this },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    redirect(code, url) { this.statusCode = code; this.location = url; return this },
  }
  let nexted = false
  await mw(req, res, () => { nexted = true })
  return { res, nexted }
}

function signJwt({ aud = AUD, iss = `https://${TEAM}`, key = signKey } = {}) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)
}

function mw(extra = {}) {
  return createAccessMiddleware({ teamDomain: TEAM, aud: AUD, jwks, ...extra })
}

test('access : non configuré -> pass-through marqué enabled:false (mode dev)', async () => {
  const m = createAccessMiddleware({})
  assert.equal(m.enabled, false)
  const { nexted } = await run(m, makeReq())
  assert.equal(nexted, true)
})

test('access : sans identité -> 401 (rien ne passe, ni lecture ni écriture)', async () => {
  const { res, nexted } = await run(mw(), makeReq())
  assert.equal(nexted, false)
  assert.equal(res.statusCode, 401)
})

test('access : JWT Cloudflare Access valide -> next', async () => {
  const token = await signJwt()
  const { nexted } = await run(mw(), makeReq({ 'Cf-Access-Jwt-Assertion': token }))
  assert.equal(nexted, true)
})

test('access : JWT à la mauvaise audience (autre app Access) -> 401', async () => {
  const token = await signJwt({ aud: 'une-autre-app' })
  const { res, nexted } = await run(mw(), makeReq({ 'Cf-Access-Jwt-Assertion': token }))
  assert.equal(nexted, false)
  assert.equal(res.statusCode, 401)
})

test('access : JWT signé par une clé étrangère -> 401', async () => {
  const token = await signJwt({ key: strangerKey })
  const { res } = await run(mw(), makeReq({ 'Cf-Access-Jwt-Assertion': token }))
  assert.equal(res.statusCode, 401)
})

test('access : Bearer local (crons) accepté, mauvais token refusé', async () => {
  const m = mw({ localToken: 'secret-cron' })
  const ok = await run(m, makeReq({ Authorization: 'Bearer secret-cron' }))
  assert.equal(ok.nexted, true)
  const ko = await run(m, makeReq({ Authorization: 'Bearer devine' }))
  assert.equal(ko.res.statusCode, 401)
})

test('access : token local seul (sans JWT configuré) suffit à protéger', async () => {
  const m = createAccessMiddleware({ localToken: 'secret-cron' })
  assert.equal(m.enabled, true)
  const ko = await run(m, makeReq())
  assert.equal(ko.res.statusCode, 401)
  const ok = await run(m, makeReq({ Authorization: 'Bearer secret-cron' }))
  assert.equal(ok.nexted, true)
})

test('access : /api/health reste ouvert (sonde monitoring, aucune donnée)', async () => {
  const { nexted } = await run(mw(), makeReq({}, '/api/health'))
  assert.equal(nexted, true)
})

test('access : cookie de session posé par /connexion accepté, cookie forgé refusé', async () => {
  const m = createAccessMiddleware({ localToken: 'jeton-test' })
  const cookie = await connexion(m)
  const ok = await run(m, makeReq({ Cookie: `autre=1; ${cookie}` }))
  assert.equal(ok.nexted, true)
  const ko = await run(m, makeReq({ Cookie: `${COOKIE_NAME}=cookie-forge` }))
  assert.equal(ko.res.statusCode, 401)
})

test('access : POST /connexion avec le bon jeton -> cookie HttpOnly + redirection', async () => {
  const m = createAccessMiddleware({ localToken: 'jeton-test' })
  const { res } = await run(m, makeReq({}, '/connexion', { method: 'POST', body: { jeton: 'jeton-test' } }))
  assert.equal(res.statusCode, 303)
  assert.match(res.headers['set-cookie'], /HttpOnly/)
  assert.match(res.headers['set-cookie'], new RegExp(`^${COOKIE_NAME}=[a-f0-9]{64};`))
  assert.ok(!res.headers['set-cookie'].includes('jeton-test;'), 'le jeton brut ne part jamais dans le cookie')
})

test('access : POST /connexion avec un mauvais jeton -> 401, aucun cookie', async () => {
  const m = createAccessMiddleware({ localToken: 'jeton-test' })
  const { res } = await run(m, makeReq({}, '/connexion', { method: 'POST', body: { jeton: 'faux' } }))
  assert.equal(res.statusCode, 401)
  assert.equal(res.headers['set-cookie'], undefined)
})

test('access : page HTML sans session -> redirection vers /connexion ; API sans jeton -> 401 JSON', async () => {
  const m = createAccessMiddleware({ localToken: 'jeton-test' })
  const page = await run(m, makeReq({}, '/', { method: 'GET' }))
  assert.equal(page.res.statusCode, 302)
  assert.equal(page.res.location, '/connexion')
  const api = await run(m, makeReq({}, '/api/state', { method: 'GET' }))
  assert.equal(api.res.statusCode, 401)
})

async function connexion(m) {
  const { res } = await run(m, makeReq({}, '/connexion', { method: 'POST', body: { jeton: 'jeton-test' } }))
  assert.equal(res.statusCode, 303)
  return res.headers['set-cookie'].split(';')[0]
}

test('F-1 : chaque connexion crée une session aléatoire distincte', async () => {
  const m = createAccessMiddleware({ localToken: 'jeton-test' })
  assert.notEqual(await connexion(m), await connexion(m))
})

test('F-1 : le cookie copié est refusé après déconnexion, les autres sessions restent valides', async () => {
  const m = createAccessMiddleware({ localToken: 'jeton-test' })
  const cookie = await connexion(m)
  const autre = await connexion(m)
  assert.equal((await run(m, makeReq({ Cookie: cookie }))).nexted, true)
  await run(m, makeReq({ Cookie: cookie }, '/deconnexion'))
  assert.equal((await run(m, makeReq({ Cookie: cookie }))).res.statusCode, 401)
  assert.equal((await run(m, makeReq({ Cookie: autre }))).nexted, true)
})

test('F-1 : expiration serveur à trente jours même si le cookie est rejoué', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 })
  const m = createAccessMiddleware({ localToken: 'jeton-test' })
  const cookie = await connexion(m)
  t.mock.timers.tick(30 * 24 * 3600 * 1000 - 1)
  assert.equal((await run(m, makeReq({ Cookie: cookie }))).nexted, true)
  t.mock.timers.tick(1)
  assert.equal((await run(m, makeReq({ Cookie: cookie }))).res.statusCode, 401)
})

test('F-1 : une session ne survit pas à la recréation du middleware', async () => {
  const cookie = await connexion(createAccessMiddleware({ localToken: 'jeton-test' }))
  const redemarre = createAccessMiddleware({ localToken: 'jeton-test' })
  assert.equal((await run(redemarre, makeReq({ Cookie: cookie }))).res.statusCode, 401)
})

test('F-1 : ancien cookie déterministe refusé', async () => {
  const ancien = createHash('sha256').update('syntreso-session:jeton-test').digest('hex')
  const m = createAccessMiddleware({ localToken: 'jeton-test' })
  assert.equal((await run(m, makeReq({ Cookie: `${COOKIE_NAME}=${ancien}` }))).res.statusCode, 401)
})
