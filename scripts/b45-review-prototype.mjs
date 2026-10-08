// B4.5 — minimal LOCAL review prototype (not production KSC UI).
//
// Builds one self-contained HTML page from the persisted Draft dump (review items + context +
// crops) so a teacher can experience exception review:  source crop | proposed content | reason
// -> Accept / Edit / Mark missing / Defer, with filters and progress. Decisions are kept in the
// browser (localStorage) with per-item timings and can be exported as JSON to measure how long
// reviewing the automatic paper really takes. It never writes a database and never confirms an
// answer; option/answer fixes are only *recorded* here (the Draft workspace owns those edits).
//
// Usage: node scripts/b45-review-prototype.mjs  ->  reports/b45/review-prototype.html

import fs from 'fs'
import path from 'path'

const dump = JSON.parse(fs.readFileSync('reports/b4-preview/draft-dump.json', 'utf8'))
const b43 = JSON.parse(fs.readFileSync('reports/b43/b43-manifest.json', 'utf8'))
const OUT = 'reports/b45/review-prototype.html'

const images = {}
const dataUri = file => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
const mediaById = new Map()
for (const q of dump.questions) for (const m of q.media) mediaById.set(m.id, m)
for (const m of dump.materials) for (const x of m.media) mediaById.set(x.id, x)
const mediaImage = id => {
  if (!id) return null
  if (images[id]) return id
  const m = mediaById.get(id)
  const f = m && dump.storage[m.storage_path]
  if (!f || !fs.existsSync(f)) return null
  images[id] = dataUri(f)
  return id
}
const candidateImage = id => {
  const r = b43.rejected.find(x => x.id === id)
  if (!r?.contextFile) return null
  const key = `cand:${id}`
  if (!images[key]) images[key] = dataUri(path.join('reports/b43', r.contextFile))
  return key
}

const questions = new Map(dump.questions.map(q => [q.row.id, q]))
const optionOwner = new Map()
for (const q of dump.questions) for (const o of q.options) optionOwner.set(o.row.id, q)
const materials = new Map(dump.materials.map(m => [m.row.id, m]))
const qContext = q => ({
  number: Number(q.row.source_question_number),
  stem: q.row.content,
  material: q.row.shared_material_id ? materials.get(q.row.shared_material_id).row.position : null,
  options: q.options.map(o => ({ marker: o.row.marker, content: o.row.content, proposed: o.row.is_proposed_correct })),
})

const items = dump.reviewItems.map(i => {
  const q = i.draft_question_id ? questions.get(i.draft_question_id) : i.draft_option_id ? optionOwner.get(i.draft_option_id) : null
  const m = i.draft_material_id ? materials.get(i.draft_material_id) : null
  let img = mediaImage(i.source_media_id)
  if (!img && i.detail?.candidate) img = candidateImage(i.detail.candidate)
  // Question-level items (answer key, options, structure) have no crop of their own: show the
  // question's source region so the reviewer still sees the page.
  if (!img && q) img = mediaImage(q.media.find(x => x.media_kind === 'TEXT_REGION')?.id)
  const figures = m ? m.media.filter(x => x.media_kind !== 'TEXT_REGION').map(x => mediaImage(x.id)).filter(Boolean) : []
  return {
    id: i.id, type: i.item_type, route: i.route, blocking: i.blocking, effort: i.effort, page: i.source_page,
    value: i.extracted_value, confidence: i.confidence, reasons: i.machine_reasons, marker: i.detail?.marker ?? null,
    img, figures,
    question: q ? qContext(q) : null,
    material: m ? { position: m.row.position, type: m.row.material_type, heading: m.row.heading, text: (m.row.content_text || '').slice(0, 1200),
      appliesTo: m.row.applies_to_questions } : null,
  }
})
const readinessBase = dump.readiness.map(r => ({ number: Number(r.source_question_number), id: r.draft_question_id }))
const itemQuestions = Object.fromEntries(items.map(i => [i.id, i.material ? i.material.appliesTo : [i.question.number]]))

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draft review prototype</title>
<style>
:root{--bg:#f4f3ee;--fg:#1c2230;--muted:#6a7282;--card:#fff;--line:#dcd8cc;--ok:#1f7a4d;--okbg:#e3f3ea;--warn:#8a5a00;--warnbg:#fbf0d6;--bad:#a3342a;--badbg:#fbe6e3;--key:#1d4f91;--keybg:#e2ecfa;--sel:#eef3fb}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#14171d;--fg:#e7e5de;--muted:#9aa1ad;--card:#1d2129;--line:#343a45;--okbg:#17372a;--warnbg:#3a2e12;--badbg:#3d1d1a;--keybg:#18284a;--ok:#6fd3a0;--warn:#f0c46a;--bad:#f19a90;--key:#8fb4ff;--sel:#202a3a}}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,"Noto Sans Telugu","Nirmala UI",sans-serif;display:flex;flex-direction:column}
header{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--card);display:flex;flex-wrap:wrap;gap:12px;align-items:center}
h1{font-size:16px;margin:0}.stat{font-size:13px}.stat b{font-size:15px}.bar{flex:1 1 200px;height:8px;background:var(--line);border-radius:4px;overflow:hidden;min-width:120px}.bar>i{display:block;height:100%;background:var(--ok)}
.filters{display:flex;gap:6px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--line)}
.filters button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:inherit;border-radius:999px;padding:3px 10px;cursor:pointer}
.filters button.on{background:var(--key);color:#fff;border-color:var(--key)}
main{flex:1;display:flex;min-height:0}
nav{width:300px;max-width:40vw;border-right:1px solid var(--line);overflow:auto;background:var(--card)}
nav div{padding:6px 10px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:6px;align-items:center;font-size:13px}
nav div.cur{background:var(--sel)}nav div.done{opacity:.55}nav .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
section#item{flex:1;overflow:auto;padding:14px 16px}
@media (max-width:760px){main{flex-direction:column}nav{width:auto;max-width:none;max-height:30vh;border-right:0;border-bottom:1px solid var(--line)}}
.grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:14px}@media (max-width:980px){.grid{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}
h2{font-size:17px;margin:0 0 8px}h3{font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:10px 0 4px}
.crop img{max-width:100%;height:auto;display:block;background:#fff;border:1px solid var(--line)}
textarea{width:100%;min-height:90px;font:17px/1.5 "Noto Sans Telugu","Nirmala UI",system-ui,sans-serif;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit}
input[type=text]{width:100%;font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:inherit}
.chip{display:inline-block;font-size:12px;border-radius:999px;padding:0 8px;line-height:20px;margin-right:4px}
.QUICK_CHECK{background:var(--warnbg);color:var(--warn)}.MANUAL_REVIEW{background:var(--badbg);color:var(--bad)}.ADVISORY{background:var(--keybg);color:var(--key)}.okc{background:var(--okbg);color:var(--ok)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.actions button{font:inherit;padding:7px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:inherit;cursor:pointer}
.actions button.primary{background:var(--ok);border-color:var(--ok);color:#fff}.actions button:disabled{opacity:.45;cursor:not-allowed}
kbd{font-size:11px;border:1px solid var(--line);border-radius:3px;padding:0 4px;margin-left:4px;opacity:.7}
table{border-collapse:collapse;width:100%}td,th{border-top:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
.muted{color:var(--muted)}.small{font-size:12px}.te{font-size:17px}.note{font-size:12px;color:var(--muted);margin-top:6px}
.done-banner{padding:8px 10px;border-radius:6px;background:var(--okbg);color:var(--ok);margin-bottom:10px}
</style></head><body>
<header><h1>Draft review prototype · SI/Constable Test-10</h1>
<span class="stat">Items <b id="pItems"></b></span><div class="bar"><i id="pBar"></i></div>
<span class="stat">Questions ready <b id="pReady"></b></span><span class="stat">Session <b id="pTime">0:00</b></span>
<button id="export" style="font:inherit;font-size:13px">Export decisions</button><button id="reset" style="font:inherit;font-size:13px">Reset</button></header>
<div class="filters" id="filters"></div>
<main><nav id="list"></nav><section id="item"></section></main>
<script>
const ITEMS = ${JSON.stringify(items)};
const IMAGES = ${JSON.stringify(images)};
const QUESTIONS = ${JSON.stringify(readinessBase)};
const ITEM_QUESTIONS = ${JSON.stringify(itemQuestions)};
const KEY = 'b45-review-decisions-v1';
let decisions = {}; try { decisions = JSON.parse(localStorage.getItem(KEY) || '{}') } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(decisions)) } catch {} }
const TELUGU = new Set(['TELUGU_STEM','TELUGU_OPTION','TELUGU_VERIFY','MATERIAL_TELUGU'])
const FILTERS = [
  ['open', 'Open (blocking)', i => i.blocking && !isResolved(i)],
  ['quick', 'Quick checks', i => i.route === 'QUICK_CHECK'],
  ['telugu', 'Telugu', i => TELUGU.has(i.type) || i.type === 'TELUGU_STRUCTURE_AMBIGUOUS'],
  ['visual', 'Visual', i => /VISUAL/.test(i.type)],
  ['options', 'Options / structure', i => ['OPTION_SET_ABNORMAL','OPTION_EMPTY','UNASSIGNED_TEXT','ENGLISH_STEM_MISSING','STRUCTURE','TELUGU_STRUCTURE_AMBIGUOUS'].includes(i.type)],
  ['answer', 'Answer issues', i => i.type === 'ANSWER_KEY'],
  ['material', 'Shared material', i => !!i.material],
  ['advisory', 'Advisory (optional)', i => !i.blocking],
  ['resolved', 'Resolved', i => isResolved(i)],
  ['all', 'All', () => true],
]
let filter = 'open', cur = null, shownAt = Date.now(), sessionStart = Date.now()
const isResolved = i => decisions[i.id] && decisions[i.id].status === 'RESOLVED'
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const label = i => ({ TELUGU_STEM: 'Telugu stem', TELUGU_OPTION: 'Telugu option ' + (i.marker || ''), TELUGU_VERIFY: 'Verify Telugu' + (i.marker ? ' ' + i.marker : ' stem'),
  TELUGU_STRUCTURE_AMBIGUOUS: 'Telugu block (stem/options unclear)', MATERIAL_TELUGU: 'Shared material Telugu', MATERIAL_VISUAL_VERIFY: 'Verify material figure',
  MATERIAL_VISUAL_MISSING: 'Material figure missing', QUESTION_VISUAL_MISSING: 'Question figure missing', QUESTION_VISUAL_VERIFY: 'Verify question figure',
  OPTION_SET_ABNORMAL: 'Option set abnormal', OPTION_EMPTY: 'Empty option ' + (i.marker || ''), ANSWER_KEY: 'Answer key issue', UNASSIGNED_TEXT: 'Unowned text after options',
  ENGLISH_STEM_MISSING: 'English stem missing', STRUCTURE: 'Structure', MATERIAL_RANGE_UNLINKED: 'Material range unclear' }[i.type] || i.type)
const owner = i => i.material ? 'M' + i.material.position + ' → Q' + i.material.appliesTo.join(', Q') : 'Q' + i.question.number
function visible() { const f = FILTERS.find(x => x[0] === filter)[2]; return ITEMS.filter(f) }
function progress() {
  const blocking = ITEMS.filter(i => i.blocking), done = blocking.filter(isResolved).length
  document.getElementById('pItems').textContent = done + ' / ' + blocking.length
  document.getElementById('pBar').style.width = (100 * done / blocking.length) + '%'
  const openQ = new Set(); for (const i of blocking) if (!isResolved(i)) for (const n of ITEM_QUESTIONS[i.id]) openQ.add(n)
  document.getElementById('pReady').textContent = (QUESTIONS.length - openQ.size) + ' / ' + QUESTIONS.length
}
function renderFilters() {
  document.getElementById('filters').innerHTML = FILTERS.map(([k, n, f]) => '<button data-f="' + k + '" class="' + (k === filter ? 'on' : '') + '">' + n + ' (' + ITEMS.filter(f).length + ')</button>').join('')
  document.querySelectorAll('#filters button').forEach(b => b.onclick = () => { filter = b.dataset.f; const v = visible(); cur = v[0]?.id ?? null; render() })
}
function renderList() {
  const v = visible()
  document.getElementById('list').innerHTML = v.map(i => '<div data-id="' + i.id + '" class="' + (i.id === cur ? 'cur ' : '') + (isResolved(i) ? 'done' : '') + '"><span class="chip ' + i.route + '">' + (i.route === 'MANUAL_REVIEW' ? 'M' : i.route === 'QUICK_CHECK' ? 'Q' : 'A') + '</span><span class="t">' + esc(owner(i)) + ' · ' + esc(label(i)) + '</span>' + (isResolved(i) ? '✓' : '') + '</div>').join('') || '<div class="muted">Nothing here.</div>'
  document.querySelectorAll('#list div[data-id]').forEach(d => d.onclick = () => { cur = d.dataset.id; render() })
  document.querySelector('#list .cur')?.scrollIntoView({ block: 'nearest' })
}
function questionContext(q) {
  if (!q) return ''
  return '<h3>Question ' + q.number + (q.material !== null ? ' · uses shared material M' + q.material : '') + '</h3><p>' + esc(q.stem || '(no English stem)') + '</p><table>' +
    q.options.map(o => '<tr><td>' + esc(o.marker) + '</td><td>' + (o.content ? esc(o.content) : '<span class="muted">(empty)</span>') + (o.proposed ? ' <span class="chip ADVISORY">proposed</span>' : '') + '</td></tr>').join('') + '</table>'
}
function renderItem() {
  const el = document.getElementById('item'), i = ITEMS.find(x => x.id === cur)
  if (!i) { el.innerHTML = '<p class="muted">Select an item.</p>'; return }
  shownAt = Date.now()
  const d = decisions[i.id]
  const telugu = TELUGU.has(i.type)
  const crop = i.img ? '<div class="crop"><img alt="source" src="' + IMAGES[i.img] + '"></div>' : '<p class="muted">No crop for this item.</p>'
  const figs = (i.figures || []).map(k => '<div class="crop" style="margin-top:6px"><img alt="figure" src="' + IMAGES[k] + '"></div>').join('')
  const answerLock = i.type === 'ANSWER_KEY' || i.type === 'OPTION_EMPTY'
  let proposed
  if (telugu) proposed = '<textarea id="txt" lang="te" placeholder="' + (i.type === 'MATERIAL_TELUGU' ? 'No OCR for shared material — type the Telugu from the crop' : 'No usable OCR — type the Telugu from the crop') + '">' + esc(d?.text ?? i.value ?? '') + '</textarea>'
  else proposed = '<p class="te">' + (i.value ? esc(i.value) : '<span class="muted">—</span>') + '</p>'
  const acts = telugu
    ? '<button class="primary" id="acc"' + (i.value ? '' : ' disabled') + '>Accept OCR<kbd>A</kbd></button><button id="edit">Save edit<kbd>Ctrl+Enter</kbd></button><button id="miss">Mark missing<kbd>M</kbd></button><button id="def">Defer<kbd>D</kbd></button>'
    : '<button class="primary" id="res">' + (answerLock ? 'Fixed in option editor' : 'Resolved') + '<kbd>R</kbd></button><button id="asis"' + (answerLock ? ' disabled title="An answer/empty-option problem cannot be accepted as is"' : '') + '>Accept as is (note)</button><button id="def">Defer<kbd>D</kbd></button>'
  el.innerHTML = (d ? '<div class="done-banner">' + esc(d.status + (d.resolution ? ' · ' + d.resolution : '')) + ' · ' + Math.round(d.ms / 1000) + ' s</div>' : '') +
    '<h2>' + esc(owner(i)) + ' — ' + esc(label(i)) + ' <span class="chip ' + i.route + '">' + i.route.replace('_', ' ') + '</span></h2>' +
    '<div class="grid"><div class="panel"><h3>Source · page ' + (i.page ?? '—') + '</h3>' + crop + figs + '</div>' +
    '<div class="panel"><h3>Proposed content</h3>' + proposed +
    '<h3>Reason</h3><p>' + i.reasons.map(r => '<span class="chip ' + i.route + '">' + esc(r) + '</span>').join(' ') + '</p>' +
    '<p class="small">Confidence ' + (i.confidence ?? '—') + ' · effort estimate ' + esc(i.effort) + (i.type === 'TELUGU_VERIFY' ? ' · <b>high confidence is not proof of correctness</b>' : '') + '</p>' +
    (i.material ? '<p class="small">Resolving this once clears it for Q' + i.material.appliesTo.join(', Q') + '.</p>' : '') +
    '<input type="text" id="note" placeholder="Note (required for Accept as is)" value="' + esc(d?.note ?? '') + '">' +
    '<div class="actions">' + acts + '<button id="next">Next<kbd>N</kbd></button></div>' +
    (i.type === 'ANSWER_KEY' ? '<p class="note">Answers stay <b>proposed</b>. Resolving this item never confirms an answer, and option text is never invented to satisfy the key.</p>' : '') +
    (i.type === 'QUESTION_VISUAL_MISSING' ? '<p class="note">Capture the figure with “Add visual from source”, or accept as is if the question needs none.</p>' : '') +
    '</div></div>' +
    '<div class="panel" style="margin-top:14px">' + (i.material ? '<h3>Shared material M' + i.material.position + ' · ' + esc(i.material.type) + '</h3><p class="small">' + esc(i.material.heading || '') + '</p><p>' + esc(i.material.text) + '</p>' : questionContext(i.question)) + '</div>'
  const decide = (status, resolution, extra = {}) => {
    const note = document.getElementById('note').value.trim()
    decisions[i.id] = { status, resolution, note, at: new Date().toISOString(), ms: Date.now() - shownAt, type: i.type, owner: owner(i), ...extra }
    save(); goNext()
  }
  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn }
  on('acc', () => decide('RESOLVED', 'ACCEPTED_OCR'))
  on('edit', () => { const t = document.getElementById('txt').value.trim(); if (!t) return alert('Type the Telugu, or mark it missing.'); decide('RESOLVED', t === (i.value || '') ? 'ACCEPTED_OCR' : (i.value ? 'EDITED_OCR' : 'TRANSCRIBED'), { text: t, originalOcr: i.value }) })
  on('miss', () => decide('RESOLVED', 'MARKED_MISSING'))
  on('def', () => decide('DEFERRED', null))
  on('res', () => decide('RESOLVED', 'RESOLVED'))
  on('asis', () => { if (!document.getElementById('note').value.trim()) return alert('Add a note explaining why it is fine as is.'); decide('RESOLVED', 'ACCEPTED_AS_IS') })
  on('next', goNext)
}
function goNext() { const v = visible(); const k = v.findIndex(x => x.id === cur); const nxt = v.slice(k + 1).find(x => !isResolved(x)) || v.find(x => !isResolved(x)); cur = nxt?.id ?? null; render() }
function render() { progress(); renderFilters(); renderList(); renderItem() }
document.addEventListener('keydown', e => {
  const typing = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT'
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { document.getElementById('edit')?.click(); return }
  if (typing) return
  const map = { a: 'acc', m: 'miss', d: 'def', r: 'res', n: 'next' }
  if (map[e.key]) { const b = document.getElementById(map[e.key]); if (b && !b.disabled) b.click() }
})
document.getElementById('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), sessionMs: Date.now() - sessionStart, decisions }, null, 2)], { type: 'application/json' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'b45-review-decisions.json'; a.click()
}
document.getElementById('reset').onclick = () => { if (confirm('Clear all recorded decisions in this browser?')) { decisions = {}; save(); render() } }
setInterval(() => { const s = Math.floor((Date.now() - sessionStart) / 1000); document.getElementById('pTime').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }, 1000)
cur = visible()[0]?.id ?? null
render()
</script></body></html>`
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html)
console.log(`items ${items.length} · images ${Object.keys(images).length} · ${path.resolve(OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`)
