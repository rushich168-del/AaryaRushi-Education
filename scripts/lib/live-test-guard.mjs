// Fail-closed guard for network-capable integration scripts (incident 2026-09-23).
//
// Several legacy QA scripts sign up users, insert rows and run `npx supabase db query --linked`
// against whatever `.env.local` / the CLI link point at. They must refuse to do anything unless the
// target is an EXPLICITLY APPROVED DISPOSABLE test project. The guard runs synchronously at import
// time, before any client, auth, table or CLI call.
//
// Refused (unknown = refuse):
//   * target identity missing or not establishable (no/garbled URL, custom domain, non-https remote);
//   * a PROHIBITED project — KSC production can never be approved, by anything;
//   * the anon key names a different project than the URL;
//   * the Supabase CLI link (supabase/.temp/project-ref) names a different project, or is missing
//     when the script uses `--linked`;
//   * no explicit test-only approval, or the approval names a different target;
//   * a production-looking environment (NODE_ENV=production, CI deploy contexts).
// Approval: KSC_DISPOSABLE_TEST_TARGET=<project-ref | local:127.0.0.1:<port>> from the process
// environment or the git-ignored file `.env.disposable-test` — never from `.env.local`, so the
// approval cannot sit next to (and silently follow) the app's own backend config.

import fs from 'fs'
import path from 'path'
import { PROJECT_REF } from '../staging-config.mjs'

// Projects that are live and never disposable. KSC production is permanently prohibited; the
// CLI-linked "rushich168-del's Project" is a live project outside KSC testing.
export const PROHIBITED_TARGETS = Object.freeze({
  [PROJECT_REF]: 'production project',
  aibjitkcnsxuufkhogrl: 'live CLI-linked project (not a disposable test target)',
})
export const APPROVAL_VAR = 'KSC_DISPOSABLE_TEST_TARGET'
export const APPROVAL_FILE = '.env.disposable-test'

export class LiveTestRefused extends Error {
  constructor(script, reasons) {
    super(`LIVE TEST REFUSED (${script}): ${reasons.join('; ')}. Nothing was contacted. See docs/ksc/INCIDENT-2026-09-23-LIVE-TEST-SCRIPTS.md.`)
    this.name = 'LiveTestRefused'
    this.reasons = reasons
  }
}

const REF = /^[a-z0-9]{20}$/
const LOCAL = /^local:(127\.0\.0\.1|localhost):\d{1,5}$/
export const parseEnvText = text => Object.fromEntries(String(text || '').split(/\r?\n/)
  .map(l => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map(m => [m[1], m[2].replace(/^(['"])(.*)\1$/, '$2')]))

// URL -> target identity ('<ref>' for hosted projects, 'local:<host>:<port>' for a local stack), or null.
export function targetOf(url) {
  let u
  try { u = new URL(String(url || '').trim()) } catch { return null }
  if (['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol === 'http:' && u.port) return `local:${u.hostname}:${u.port}`
  const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname)
  return m && u.protocol === 'https:' && (u.pathname === '/' || u.pathname === '') ? m[1] : null
}
// Legacy anon keys are JWTs carrying the project ref; publishable keys carry none.
export function keyRef(key) {
  const parts = String(key || '').split('.')
  if (parts.length !== 3) return null
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()).ref ?? null } catch { return 'UNREADABLE' }
}

// Pure decision. Inputs are plain values so it can be tested without files or network.
export function evaluateTestTarget({ envLocal = {}, approval = null, cliRef = null, usesLinkedCli = false, nodeEnv = null, ciDeploy = false }) {
  const reasons = []
  const url = envLocal.VITE_SUPABASE_URL, key = envLocal.VITE_SUPABASE_ANON_KEY
  const target = targetOf(url)
  if (!url || !key) reasons.push('target URL/key missing')
  else if (!target) reasons.push('target identity cannot be established from the URL (only https://<ref>.supabase.co or http://127.0.0.1:<port> are recognised)')
  if (target && PROHIBITED_TARGETS[target]) reasons.push(`target is the ${PROHIBITED_TARGETS[target]} (${target}) — permanently prohibited`)
  const kr = keyRef(key)
  if (kr === 'UNREADABLE') reasons.push('anon key is malformed')
  else if (kr && target && !target.startsWith('local:') && kr !== target) reasons.push(`anon key belongs to ${kr}, URL to ${target}`)
  if (kr && PROHIBITED_TARGETS[kr]) reasons.push(`anon key belongs to the ${PROHIBITED_TARGETS[kr]} (${kr})`)
  const cli = cliRef ? String(cliRef).trim() : null
  if (cli && PROHIBITED_TARGETS[cli] && usesLinkedCli) reasons.push(`Supabase CLI is linked to the ${PROHIBITED_TARGETS[cli]} (${cli}) and this script uses --linked`)
  if (cli && target && !target.startsWith('local:') && cli !== target) reasons.push(`.env.local targets ${target} but the Supabase CLI is linked to ${cli}`)
  if (usesLinkedCli && !cli) reasons.push('script uses --linked but the CLI link target cannot be established')
  if (usesLinkedCli && target?.startsWith('local:')) reasons.push('script uses --linked, which cannot address a local target')
  if (!approval) reasons.push(`no explicit disposable-target approval (${APPROVAL_VAR})`)
  else if (!REF.test(approval) && !LOCAL.test(approval)) reasons.push(`${APPROVAL_VAR} is not a project ref or local:<host>:<port>`)
  else if (PROHIBITED_TARGETS[approval]) reasons.push(`${APPROVAL_VAR} names the ${PROHIBITED_TARGETS[approval]} — it can never be approved`)
  else if (target && approval !== target) reasons.push(`${APPROVAL_VAR} approves ${approval}, but the script would contact ${target}`)
  if (nodeEnv === 'production') reasons.push('NODE_ENV=production')
  if (ciDeploy) reasons.push('running in a deploy/production CI context')
  return { allowed: reasons.length === 0, target, reasons }
}

// Reads the same files the scripts use and throws LiveTestRefused unless allowed. Call it at the
// very top of a script, before creating any client.
export function requireDisposableTestTarget({ script, usesLinkedCli = false, cwd = process.cwd(), env = process.env, readFile = fs.readFileSync, exists = fs.existsSync }) {
  const file = f => path.join(cwd, f)
  const envLocal = exists(file('.env.local')) ? parseEnvText(readFile(file('.env.local'), 'utf8')) : {}
  const approvalFile = exists(file(APPROVAL_FILE)) ? parseEnvText(readFile(file(APPROVAL_FILE), 'utf8'))[APPROVAL_VAR] : null
  const approval = (env[APPROVAL_VAR] || approvalFile || '').trim() || null
  const cliRef = exists(file('supabase/.temp/project-ref')) ? String(readFile(file('supabase/.temp/project-ref'), 'utf8')).trim() || null : null
  const decision = evaluateTestTarget({ envLocal, approval, cliRef, usesLinkedCli, nodeEnv: env.NODE_ENV || null,
    ciDeploy: Boolean(env.VERCEL_ENV === 'production' || env.CF_PAGES_BRANCH === 'main' || env.NETLIFY_CONTEXT === 'production') })
  if (!decision.allowed) throw new LiveTestRefused(script, decision.reasons)
  return { url: envLocal.VITE_SUPABASE_URL, key: envLocal.VITE_SUPABASE_ANON_KEY, target: decision.target }
}
