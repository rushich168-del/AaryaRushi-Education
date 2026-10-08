// B4.6 — run every repository test suite (except the live-auth one) one by one and record, per
// suite, pass/fail counts and failing test names. Used to classify wider-suite failures by
// comparing runs (e.g. before vs after a change, or HEAD worktree vs working tree).
// Usage: node scripts/b46-classify-suites.mjs <out.json> [--cwd <dir>]
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const out = process.argv[2]
const i = process.argv.indexOf('--cwd')
const cwd = i > -1 ? process.argv[i + 1] : process.cwd()
// NEVER run a suite that talks to a live project: legacy QA scripts read .env.local and call live
// auth.signUp / inserts / `npx supabase db query --linked`. They are listed as LIVE_SKIPPED, not run.
// (The scripts also fail closed on their own — scripts/lib/live-test-guard.mjs. This is defense in depth.)
const LIVE_NAMES = new Set(['test-patterns', 'test-pdf-import-db', 'test-preflight-gate', 'test-qb', 'test-results', 'test-rls',
  'test-student-exam', 'test-student-test-visibility', 'test-draft-paper-persistence'].map(n => `${n}.mjs`))
const LIVE = /\.env\.local|--linked|auth\.signUp\(\s*\{/
const isLive = src => /createClient\(/.test(src) && LIVE.test(src)
const all = fs.readdirSync(path.join(cwd, 'scripts')).filter(f => /^test-.*\.mjs$/.test(f)).sort()
const live = all.filter(f => LIVE_NAMES.has(f) || isLive(fs.readFileSync(path.join(cwd, 'scripts', f), 'utf8')))
const onlyI = process.argv.indexOf('--only')
const only = onlyI > -1 ? new Set(process.argv[onlyI + 1].split(',').map(s => s.trim()).filter(Boolean)) : null
const suites = all.filter(f => !live.includes(f) && (!only || only.has(f)))
console.log(`LIVE_SKIPPED (never run): ${live.join(', ')}`)
const results = {}
for (const f of suites) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', `scripts/${f}`], { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 })
  const txt = (r.stdout || '') + (r.stderr || '')
  const num = k => Number((txt.match(new RegExp(`^# ${k} ([0-9]+)`, 'm')) || [])[1] || 0)
  const failed = [...txt.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map(m => m[1].trim()).filter(n => !/^scripts[\/]/.test(n))
  results[f] = { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'), exit: r.status, timedOut: r.error?.code === 'ETIMEDOUT', seconds: (Date.now() - t0) / 1000, failed,
    firstError: failed.length || r.status ? (txt.match(/(Error[^\n]{0,200})/) || [])[1] || null : null }
  process.stdout.write(`${f}: ${results[f].pass}/${results[f].tests}${results[f].fail ? ` FAIL ${results[f].fail}` : ''}\n`)
}
fs.writeFileSync(out, JSON.stringify({ generated: new Date().toISOString(), cwd, results }, null, 1))
