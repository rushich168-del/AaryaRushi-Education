// LOCAL throwaway backend for the KSC teacher workflows (B4.6 Review Center, B4.7 automatic preparation).
//
// Migrations 0023-0029 are not applied to Supabase, so the app is exercised against a throwaway
// PostgreSQL with the REAL KSC schema (scripts/lib/local-draft-db.mjs: migrations 0001 -> 0029) behind
// a small HTTP server speaking the subset of the Supabase protocol the app uses
// (scripts/lib/local-rest.mjs: REST with embeds, RPC, private-bucket storage) plus a LOCAL fixture
// session (no passwords; fake users in a throwaway DB). Every request runs as `authenticated` with
// the caller's sub, so RLS, grants, triggers and SECURITY DEFINER checks are the real ones.
// It is NOT PostgREST and NOT Supabase; it binds to 127.0.0.1 only.
//
// Usage: node scripts/b46-local-backend.mjs [--seed none|golden] [--api-port 54321] [--vite-port 5174] [--no-vite | --csp]
//   --csp serves a production build with the staging Content-Security-Policy instead of the Vite dev server.
//   then open http://127.0.0.1:<vite-port>/__local/session  (owner teacher; ?as=other for a second teacher)
// Local test-only endpoints: /local/info, /local/fixtures/{golden,corrupt}.pdf, POST /local/faults (one-shot
// fault injection: { rpc: '<name>', upload: <nth upload fails>, ocrModel: true }).

import http from 'http'
import fs from 'fs'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { createLocalKscDb, cleanupStaleClusters, prepareGoldenDraft, GOLDEN_PDF } from './lib/local-draft-db.mjs'
import { createRestHandler } from './lib/local-rest.mjs'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d }
const API_PORT = Number(arg('api-port', 54321))
const VITE_PORT = Number(arg('vite-port', 5174))
const SEED = arg('seed', 'none')
const HOST = '127.0.0.1'
const API_URL = `http://${HOST}:${API_PORT}`
const SECRET = crypto.randomBytes(32)
const log = (...a) => console.log('[local]', ...a)

const b64u = b => Buffer.from(b).toString('base64url')
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url')
function makeJwt(user) {
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600 }))}`
  return `${body}.${sign(body)}`
}
function verifyJwt(tok) {
  const [h, p, s] = String(tok || '').split('.')
  if (!h || !p || !s || sign(`${h}.${p}`) !== s) return null
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
  return claims.exp > Date.now() / 1000 ? claims : null
}
const verifyStorageToken = (objectPath, token) => {
  const [tok, exp] = String(token || '').split('.')
  return tok === sign(`${objectPath}|${exp}`) && Number(exp) >= Date.now() / 1000
}

// One-shot fault injection (local acceptance tests only).
const faults = { rpc: null, upload: null, ocrModel: false }
let uploadCount = 0

async function main() {
  cleanupStaleClusters(log)
  const db = await createLocalKscDb({ log })
  const users = {
    owner: { id: db.teacher, email: 'owner.teacher@ksc.local', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'local' }, user_metadata: { name: 'Local owner teacher' } },
    other: { id: db.otherTeacher, email: 'other.teacher@ksc.local', aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'local' }, user_metadata: { name: 'Local other teacher' } },
  }
  const userById = id => Object.values(users).find(u => u.id === id)
  const session = user => ({ access_token: makeJwt(user), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `local.${user.id}.${sign(user.id)}`, user })
  let seeded = null
  if (SEED === 'golden') {
    seeded = await prepareGoldenDraft(db)
    log(`golden Draft prepared by the shared orchestrator: paper ${seeded.draftPaperId} (${seeded.summary.questions} questions, ${seeded.summary.reviewItems} review items)`)
  }
  const handler = createRestHandler({ runner: db.runner, storageDir: db.storageDir, storageMap: db.storageMap, sign, verifyStorageToken })

  const readRaw = req => new Promise((resolve, reject) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject) })
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, prefer, accept, x-client-info, accept-profile, content-profile, range, x-supabase-api-version, x-upsert, cache-control, x-metadata')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', 'content-range, content-length')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    const url = new URL(req.url, API_URL)
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(body === undefined || body === null ? '' : JSON.stringify(body)) }
    const claims = verifyJwt((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))
    const uid = claims?.sub && userById(claims.sub) ? claims.sub : null
    try {
      const raw = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readRaw(req) : Buffer.alloc(0)
      // ---- local fixtures / session / faults ----
      if (url.pathname === '/local/session') {
        const u = users[url.searchParams.get('as') || 'owner']
        if (!u) return send(404, { error: 'unknown user' })
        return send(200, { session: session(u), storageKey: `sb-${HOST.split('.')[0]}-auth-token`,
          next: url.searchParams.get('next') || (seeded ? `/dashboard/admin/draft-review/${seeded.draftPaperId}` : '/dashboard/admin/questions') })
      }
      if (url.pathname === '/local/info') return send(200, { pgPort: db.port, owner: db.teacher, other: db.otherTeacher, seededPaperId: seeded?.draftPaperId ?? null, catalogue: db.catalogue })
      if (url.pathname === '/local/faults' && req.method === 'POST') { Object.assign(faults, JSON.parse(raw.toString() || '{}')); uploadCount = 0; return send(200, faults) }
      if (url.pathname === '/local/fixtures/golden.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return fs.createReadStream(GOLDEN_PDF).pipe(res) }
      if (url.pathname === '/local/fixtures/corrupt.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(Buffer.from('%PDF-1.4\nthis is not a valid pdf body\n%%EOF')) }
      // ---- auth ----
      if (url.pathname === '/auth/v1/user') return uid ? send(200, userById(uid)) : send(401, { code: 401, error_code: 'no_authorization', msg: 'Not signed in' })
      if (url.pathname === '/auth/v1/logout') { res.writeHead(204); return res.end() }
      if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
        const { refresh_token: rt } = JSON.parse(raw.toString() || '{}')
        const [, id, sig] = String(rt || '').split('.')
        if (!id || sig !== sign(id) || !userById(id)) return send(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' })
        return send(200, session(userById(id)))
      }
      if (url.pathname.startsWith('/auth/v1/')) return send(400, { error: 'unsupported', error_description: 'The local backend only supports the fixture session.' })
      // ---- REST / RPC ----
      const rest = /^\/rest\/v1\/(.+)$/.exec(url.pathname)
      if (rest && rest[1].startsWith('rpc/')) {
        const fn = rest[1].slice(4)
        if (faults.rpc === fn) { faults.rpc = null; return send(500, { code: 'LOCAL_FAULT', message: `LOCAL_FAULT_INJECTED: ${fn} failed`, details: null, hint: null }) }
        const args = req.method === 'POST' ? JSON.parse(raw.toString() || '{}') : Object.fromEntries(url.searchParams)
        return send(200, await db.runner.rpc(uid, fn, args))
      }
      if (rest) {
        const body = raw.length ? JSON.parse(raw.toString()) : null
        const r = await handler.rest({ method: req.method, table: rest[1], url, headers: req.headers, body, uid })
        if (req.method === 'HEAD') { res.writeHead(r.status, { 'Content-Range': r.headers?.['Content-Range'] || '*/*' }); return res.end() }
        return send(r.status, r.body, r.headers)
      }
      // ---- storage ----
      if (url.pathname.startsWith('/storage/v1/')) {
        if ((req.method === 'POST' || req.method === 'PUT') && /^\/storage\/v1\/object\/(?!sign\/)[^/]+\/.+/.test(url.pathname) && faults.upload) {
          uploadCount++
          if (uploadCount >= faults.upload) { faults.upload = null; return send(500, { statusCode: '500', error: 'LOCAL_FAULT', message: 'LOCAL_FAULT_INJECTED: storage upload failed' }) }
        }
        const r = await handler.storage({ method: req.method, url, headers: req.headers, raw, uid })
        if (r.file) { res.writeHead(200, { 'Content-Type': r.file.endsWith('.pdf') ? 'application/pdf' : 'image/png', 'Cache-Control': 'private, max-age=300' }); return fs.createReadStream(r.file).pipe(res) }
        return send(r.status, r.body)
      }
      return send(404, { message: 'Not available in the local backend' })
    } catch (e) {
      const status = e.status || (e.code === '42501' ? 403 : e.code === '23505' ? 409 : e.code === 'PGRST202' ? 404 : 400)
      return send(status, { code: e.code || 'LOCAL', message: e.message, details: e.detail ?? null, hint: e.hint ?? null })
    }
  })
  await new Promise(r => server.listen(API_PORT, HOST, r))
  log(`API ${API_URL} (throwaway PG on port ${db.port}; seed ${SEED})`)

  let vite = null
  const sessionPage = q => `<!doctype html><meta charset="utf-8"><title>Local session</title><p>Signing in to the LOCAL throwaway backend…</p>
<script>fetch(${JSON.stringify(API_URL)} + '/local/session?' + ${JSON.stringify(q.toString())}).then(r => r.json()).then(s => {
  localStorage.setItem(s.storageKey, JSON.stringify(s.session)); location.replace(s.next) })</script>`
  if (process.argv.includes('--csp')) {
    // Production build served with the STAGING Content-Security-Policy (only connect-src points at
    // this local API), to prove the in-browser preparation and Review Center work under it.
    process.env.VITE_SUPABASE_URL = API_URL
    process.env.VITE_SUPABASE_ANON_KEY = 'local-throwaway-anon'
    process.env.VITE_PUBLIC_PREVIEW = 'false'
    const { build } = await import('vite')
    const { stagingCsp } = await import('./staging-config.mjs')
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-local-csp-dist-'))
    await build({ logLevel: 'warn', build: { outDir, emptyOutDir: true } })
    const csp = stagingCsp(API_URL)
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
      '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.traineddata': 'application/octet-stream' }
    const app = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/__local/session') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(sessionPage(url.searchParams)) }
      if (faults.ocrModel && url.pathname.startsWith('/ocr/tessdata/')) { faults.ocrModel = false; res.statusCode = 503; return res.end('LOCAL_FAULT_INJECTED') }
      let file = path.join(outDir, decodeURIComponent(url.pathname))
      if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(outDir, 'index.html')
      res.setHeader('Content-Security-Policy', csp)
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream')
      fs.createReadStream(file).pipe(res)
    })
    await new Promise(r => app.listen(VITE_PORT, HOST, r))
    vite = { close: () => { app.close(); fs.rmSync(outDir, { recursive: true, force: true }) } }
    log(`App (production build, staging CSP) http://${HOST}:${VITE_PORT}/__local/session`)
    log(`CSP: ${csp}`)
  } else if (!process.argv.includes('--no-vite')) {
    process.env.VITE_SUPABASE_URL = API_URL
    process.env.VITE_SUPABASE_ANON_KEY = 'local-throwaway-anon'
    process.env.VITE_PUBLIC_PREVIEW = 'false'
    const { createServer } = await import('vite')
    vite = await createServer({
      server: { host: HOST, port: VITE_PORT, strictPort: true },
      plugins: [{
        name: 'ksc-local-session',
        enforce: 'pre',
        configureServer(s) {
          // One-shot fault: the Telugu model is unavailable (runs before the OCR asset middleware).
          s.middlewares.use((req, res, next) => {
            if (faults.ocrModel && (req.url || '').startsWith('/ocr/tessdata/')) { faults.ocrModel = false; res.statusCode = 503; return res.end('LOCAL_FAULT_INJECTED') }
            next()
          })
          // Stores the LOCAL fixture session for the app origin, then opens the app.
          s.middlewares.use('/__local/session', (req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(sessionPage(new URL(req.url, 'http://x').searchParams))
          })
        },
      }],
    })
    await vite.listen()
    log(`App http://${HOST}:${VITE_PORT}/__local/session  (owner teacher; ?as=other for a second teacher)`)
  }
  fs.mkdirSync('reports/b46', { recursive: true })
  fs.writeFileSync('reports/b46/local-backend.json', JSON.stringify({ api: API_URL, app: vite ? `http://${HOST}:${VITE_PORT}` : null, seed: SEED,
    seededPaperId: seeded?.draftPaperId ?? null, pgPort: db.port, started: new Date().toISOString() }, null, 1))

  const shutdown = async () => { log('stopping'); server.close(); await vite?.close(); await db.stop(); process.exit(0) }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
}
main().catch(e => { console.error('[local] backend failed:', e.message?.slice(0, 2000) || e); process.exit(1) })
