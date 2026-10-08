import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { evaluateTestTarget, requireDisposableTestTarget, targetOf, LiveTestRefused, PROHIBITED_TARGETS } from './lib/live-test-guard.mjs'

// Incident 2026-09-23 containment: the live-test guard fails closed. These tests make ZERO network
// calls: the pure cases touch nothing, and every guarded script is run in a child process with a
// preload that intercepts fetch/net/tls/dns/http(s)/child_process and records any attempt.

const KSC = 'REPLACE_WITH_NEW_PROJECT_REF'
const LINKED = 'aibjitkcnsxuufkhogrl'
const DISPOSABLE = 'zzzzdisposabletest01'
const jwt = ref => `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ role: 'anon', ref })).toString('base64url')}.fake-signature`
const env = (ref, key = jwt(ref)) => ({ VITE_SUPABASE_URL: `https://${ref}.supabase.co`, VITE_SUPABASE_ANON_KEY: key })

test('KSC production is REFUSED — even when "approved", with a matching CLI link and key', () => {
  for (const usesLinkedCli of [false, true]) {
    const d = evaluateTestTarget({ envLocal: env(KSC), approval: KSC, cliRef: KSC, usesLinkedCli })
    assert.equal(d.allowed, false)
    assert.ok(d.reasons.some(r => /KSC production/.test(r)))
  }
  assert.equal(PROHIBITED_TARGETS[KSC], 'KSC production project')
})

test('.env.local / CLI link disagreement is REFUSED (the real repo state: KSC env, CLI linked elsewhere)', () => {
  const d = evaluateTestTarget({ envLocal: env(DISPOSABLE), approval: DISPOSABLE, cliRef: 'otherprojectref00001', usesLinkedCli: false })
  assert.deepEqual([d.allowed, d.reasons.some(r => /CLI is linked to otherprojectref00001/.test(r))], [false, true])
  const real = evaluateTestTarget({ envLocal: env(KSC), approval: null, cliRef: LINKED, usesLinkedCli: true })
  assert.equal(real.allowed, false)
  assert.equal(evaluateTestTarget({ envLocal: env(DISPOSABLE), approval: DISPOSABLE, cliRef: null, usesLinkedCli: true }).allowed, false, '--linked with no establishable link')
})

test('missing or unestablishable target identity is REFUSED', () => {
  for (const envLocal of [{}, { VITE_SUPABASE_URL: `https://${DISPOSABLE}.supabase.co` }, { VITE_SUPABASE_URL: 'not a url', VITE_SUPABASE_ANON_KEY: 'k' },
    { VITE_SUPABASE_URL: 'https://api.example.com', VITE_SUPABASE_ANON_KEY: 'k' }, { VITE_SUPABASE_URL: `http://${DISPOSABLE}.supabase.co`, VITE_SUPABASE_ANON_KEY: 'k' }]) {
    const d = evaluateTestTarget({ envLocal, approval: DISPOSABLE })
    assert.equal(d.allowed, false, JSON.stringify(envLocal))
  }
  assert.equal(targetOf('https://api.example.com'), null)
})

test('an arbitrary live / unapproved target is REFUSED', () => {
  assert.equal(evaluateTestTarget({ envLocal: env(DISPOSABLE), approval: null }).allowed, false, 'no approval')
  assert.equal(evaluateTestTarget({ envLocal: env(DISPOSABLE), approval: 'anotherdisposable001' }).allowed, false, 'approval names another target')
  assert.equal(evaluateTestTarget({ envLocal: env(LINKED), approval: LINKED, cliRef: LINKED, usesLinkedCli: true }).allowed, false, 'known live project')
  assert.equal(evaluateTestTarget({ envLocal: env(DISPOSABLE, jwt(KSC)), approval: DISPOSABLE }).allowed, false, 'anon key belongs to KSC')
  assert.equal(evaluateTestTarget({ envLocal: env(DISPOSABLE), approval: DISPOSABLE, nodeEnv: 'production' }).allowed, false, 'production environment')
  assert.equal(evaluateTestTarget({ envLocal: env(DISPOSABLE), approval: 'yes' }).allowed, false, 'a boolean-style flag is not an approval')
})

test('an explicitly configured disposable target is ALLOWED (hosted with matching CLI link, or local)', () => {
  const hosted = evaluateTestTarget({ envLocal: env(DISPOSABLE), approval: DISPOSABLE, cliRef: DISPOSABLE, usesLinkedCli: true })
  assert.deepEqual([hosted.allowed, hosted.target, hosted.reasons], [true, DISPOSABLE, []])
  const local = evaluateTestTarget({ envLocal: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: 'local' }, approval: 'local:127.0.0.1:54321', cliRef: null })
  assert.deepEqual([local.allowed, local.target], [true, 'local:127.0.0.1:54321'])
})

test('approval is never read from .env.local, and refusal throws before returning credentials', () => {
  const files = { '.env.local': `VITE_SUPABASE_URL=https://${DISPOSABLE}.supabase.co\nVITE_SUPABASE_ANON_KEY=${jwt(DISPOSABLE)}\nKSC_DISPOSABLE_TEST_TARGET=${DISPOSABLE}\n` }
  const io = { cwd: '/x', env: {}, exists: f => Object.keys(files).some(k => f.endsWith(k)), readFile: f => files[Object.keys(files).find(k => f.endsWith(k))] }
  assert.throws(() => requireDisposableTestTarget({ script: 't', ...io }), LiveTestRefused)
  files['.env.disposable-test'] = `KSC_DISPOSABLE_TEST_TARGET=${DISPOSABLE}\n`
  assert.equal(requireDisposableTestTarget({ script: 't', ...io }).url, `https://${DISPOSABLE}.supabase.co`)
})

// ---- every guarded script, run for real, refuses before ANY network/auth/database/CLI call -------
const SCRIPTS = { 'test-patterns': true, 'test-preflight-gate': true, 'test-qb': true, 'test-results': true, 'test-rls': true, 'test-student-exam': true,
  'test-student-test-visibility': true, 'test-pdf-import-db': false, 'test-draft-paper-persistence': false }
const PRELOAD = path.resolve('scripts/fixtures/no-network-preload.mjs')
function runScript(name, { envLocal, cliRef = null, approvalEnv = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksc-guard-'))
  try {
    fs.writeFileSync(path.join(dir, '.env.local'), Object.entries(envLocal).map(([k, v]) => `${k}=${v}`).join('\n'))
    if (cliRef) { fs.mkdirSync(path.join(dir, 'supabase/.temp'), { recursive: true }); fs.writeFileSync(path.join(dir, 'supabase/.temp/project-ref'), cliRef) }
    const log = path.join(dir, 'net.json')
    const childEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NO_NET_LOG: log }
    if (approvalEnv) childEnv.KSC_DISPOSABLE_TEST_TARGET = approvalEnv
    const r = spawnSync(process.execPath, ['--import', 'file:///' + PRELOAD.replace(/\\/g, '/'), path.resolve('scripts', `${name}.mjs`)], { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 60000 })
    return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), calls: fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : null }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('all nine live-capable scripts refuse the KSC target before any network call', () => {
  for (const name of Object.keys(SCRIPTS)) {
    const r = runScript(name, { envLocal: env(KSC), cliRef: LINKED })
    assert.notEqual(r.status, 0, `${name} must fail closed`)
    assert.match(r.out, /LIVE TEST REFUSED/, name)
    assert.deepEqual(r.calls, [], `${name} attempted: ${JSON.stringify(r.calls)}`)
  }
})

test('mismatched env/CLI and unapproved targets are refused by every script, with zero calls', () => {
  for (const name of Object.keys(SCRIPTS)) {
    for (const setup of [{ envLocal: env(DISPOSABLE), cliRef: LINKED, approvalEnv: DISPOSABLE }, { envLocal: env(DISPOSABLE), cliRef: DISPOSABLE }, { envLocal: {}, approvalEnv: DISPOSABLE }]) {
      const r = runScript(name, setup)
      assert.notEqual(r.status, 0, `${name} ${JSON.stringify(setup)}`)
      assert.deepEqual(r.calls, [], name)
    }
  }
})

test('an approved local disposable target passes the guard (and then only reaches the blocking preload)', () => {
  const r = runScript('test-pdf-import-db', { envLocal: { VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'local-test' }, approvalEnv: 'local:127.0.0.1:9' })
  assert.doesNotMatch(r.out, /LIVE TEST REFUSED/)
  assert.ok(r.calls.length > 0 && r.calls.every(c => c.kind === 'fetch' && c.target.startsWith('http://127.0.0.1:9/')), JSON.stringify(r.calls))
  const linkedLocal = runScript('test-qb', { envLocal: { VITE_SUPABASE_URL: 'http://127.0.0.1:9', VITE_SUPABASE_ANON_KEY: 'local-test' }, approvalEnv: 'local:127.0.0.1:9' })
  assert.match(linkedLocal.out, /cannot address a local target/, '--linked scripts cannot run against a local target')
  assert.deepEqual(linkedLocal.calls, [])
})

test('the suite runner still excludes all nine scripts (defense in depth)', () => {
  const runner = fs.readFileSync('scripts/b46-classify-suites.mjs', 'utf8')
  const names = /const LIVE_NAMES = new Set\(\[([\s\S]*?)\]/.exec(runner)[1]
  for (const name of Object.keys(SCRIPTS)) assert.ok(names.includes(`'${name}'`), `${name} is in the runner's never-run list`)
  assert.ok(!names.includes('test-live-test-guard'), 'this zero-network guard test is itself run')
})
