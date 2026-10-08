// B4.6 — classify wider-suite failures by comparing two runs of scripts/b46-classify-suites.mjs
// (before = captured pre-B4.6 baseline, after = with B4.6). Optionally a third run on a clean HEAD
// worktree separates "pre-existing in the committed code" from "pre-existing uncommitted branch work".
// Usage: node scripts/b46-compare-suites.mjs <before.json> <after.json> [<head.json>] [--out report.md]
import fs from 'fs'

const [beforeF, afterF, headF] = process.argv.slice(2).filter(a => !a.startsWith('--'))
const outI = process.argv.indexOf('--out')
const read = f => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).results : null)
const before = read(beforeF), after = read(afterF), head = read(headF)
const LIVE = new Set(['test-patterns', 'test-pdf-import-db', 'test-preflight-gate', 'test-qb', 'test-results', 'test-rls',
  'test-student-exam', 'test-student-test-visibility', 'test-draft-paper-persistence'].map(n => `${n}.mjs`))
const failed = r => r && (r.fail > 0 || (r.exit && r.exit !== 0))
const rows = []
for (const f of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
  if (LIVE.has(f)) { rows.push({ f, cls: 'LIVE — never run (guarded + runner-excluded)', b: before[f], a: null }); continue }
  const b = before[f], a = after[f], h = head?.[f]
  if (!failed(b) && !failed(a)) continue
  let cls
  if (!b) cls = failed(a) ? 'NEW SUITE FAILING — caused by B4.6 (blocker)' : 'new suite passing'
  else if (!failed(b) && failed(a)) cls = 'CAUSED BY B4.6 (regression — blocker)'
  else if (failed(b) && !failed(a)) cls = 'fixed / flaky (failed before, passes now)'
  else {
    const same = JSON.stringify([...(b.failed || [])].sort()) === JSON.stringify([...(a.failed || [])].sort())
    cls = same ? 'PRE-EXISTING (identical failures before B4.6)' : 'PRE-EXISTING suite, different failing tests — UNKNOWN, inspect'
    if (head) cls += failed(h) ? ' · also fails on clean HEAD (committed code)' : h ? ' · passes on clean HEAD (uncommitted branch work before B4.6)' : ' · not on HEAD'
  }
  rows.push({ f, cls, b, a, h })
}
const fmt = r => (r ? `${r.pass}/${r.tests}${r.fail ? ` (${r.fail} fail)` : ''}${r.timedOut ? ' TIMEOUT' : ''}` : '—')
const tot = res => Object.entries(res).filter(([f]) => !LIVE.has(f)).reduce((o, [, r]) => ({ suites: o.suites + 1, tests: o.tests + r.tests, pass: o.pass + r.pass, fail: o.fail + r.fail }), { suites: 0, tests: 0, pass: 0, fail: 0 })
const L = ['# B4.6 wider-suite failure classification', '', `Before (pre-B4.6 baseline, non-live suites): ${JSON.stringify(tot(before))}`, `After (with B4.6, non-live suites): ${JSON.stringify(tot(after))}`,
  head ? `Clean HEAD worktree: ${JSON.stringify(tot(head))}` : '', '', '| Suite | Before | After | Classification | First error (after) |', '|---|---|---|---|---|']
for (const r of rows) L.push(`| ${r.f} | ${fmt(r.b)} | ${fmt(r.a)} | ${r.cls} | ${(r.a?.firstError || r.b?.firstError || '').replace(/\|/g, '/').slice(0, 90)} |`)
const out = L.join('\n')
if (outI > -1) fs.writeFileSync(process.argv[outI + 1], out)
console.log(out)
