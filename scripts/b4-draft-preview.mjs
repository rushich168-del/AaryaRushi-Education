// Read-only preview of the PERSISTED automatic Draft.
//
// Input: reports/b4-preview/draft-dump.json, written by scripts/b4-persist-local.mjs after the real
// writers (0023-0026) ran against a throwaway PostgreSQL. Every question, option, language row,
// media row and shared material shown here is exactly what the Draft stores. Crops are resolved
// through the dump's storage map (the local stand-in for the private bucket).
//
// Two review signals are not persisted yet (routing is B4.5) and are read from the pipeline output,
// labelled as such: B4.3 visual candidates rejected for a question, and B4.4 question outcomes.
//
// Writes ONE self-contained HTML file and a summary JSON. No database, no network, no app code.
// Usage: node scripts/b4-draft-preview.mjs [--out reports/b4-preview/draft-preview.html]

import fs from 'fs'
import path from 'path'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const OUT = arg('out', 'reports/b4-preview/draft-preview.html')
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const dump = read('reports/b4-preview/draft-dump.json')
const b43 = read('reports/b43/b43-manifest.json')
const before = fs.existsSync('reports/b4-preview/draft-preview-summary.before.json') ? read('reports/b4-preview/draft-preview-summary.before.json').summary : null
const img = (storagePath, alt) => {
  const file = dump.storage[storagePath]
  return file && fs.existsSync(file) ? `<img loading="lazy" alt="${esc(alt)}" src="data:image/png;base64,${fs.readFileSync(file).toString('base64')}">` : '<span class="bad-text">(crop missing)</span>'
}

const OPTION_REASONS = /^(FEWER_THAN_4_OPTIONS|MORE_THAN_4_OPTIONS|NO_OPTIONS|DUPLICATE_OPTION_MARKERS|EMPTY_OPTION_TEXT)/
const VISUAL_REASONS = /^(VISUAL_EXPECTED_BUT_NONE_FOUND|VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION|VISUAL_PARTIALLY_CONTAINED)/
const MATERIAL_VISUAL = /^MATERIAL_VISUAL_/
const DIRECTIONS_DEPENDENT = new Set((b43Directions()).flat())   // questions a Directions block governs

// The questions every B4.1 Directions block states it governs (from the persisted materials'
// applies_to_questions, i.e. the heading evidence) — used to count "missing shared material".
function b43Directions() { return (dump.materials || []).map(m => m.row.applies_to_questions || []) }

const materials = new Map(dump.materials.map(m => [m.row.id, m]))
const rejectedVisual = new Map()
for (const r of b43.rejected) {
  if (!r.questionNumber || r.reasons.includes('WHITESPACE_NO_INK')) continue
  if (!rejectedVisual.has(r.questionNumber)) rejectedVisual.set(r.questionNumber, [])
  rejectedVisual.get(r.questionNumber).push(r)
}

// ---------- per-question assessment (from persisted rows) ------------------------------------
const rows = dump.questions.map(({ row: q, media, texts, options }) => {
  const number = Number(q.source_question_number)
  const opts = (options || []).map(o => ({ ...o.row, te: (o.texts || []).find(t => t.language === 'te') }))
  const te = (texts || []).find(t => t.language === 'te')
  const material = q.shared_material_id ? materials.get(q.shared_material_id) : null
  const issues = { options: [], answer: [], telugu: [], visual: [], material: [], stem: [], structure: [] }
  for (const r of q.review_reasons || []) {
    if (OPTION_REASONS.test(r)) issues.options.push(r)
    else if (VISUAL_REASONS.test(r)) issues.visual.push(r)
    else if (r.startsWith('NO_ANSWER_KEY_ENTRY')) issues.answer.push(r)
    else if (r.startsWith('NO_TELUGU_REGION')) { /* informational */ }
    else issues.structure.push(r)
  }
  if (opts.length !== 4 && !issues.options.some(r => /THAN_4|NO_OPTIONS/.test(r))) issues.options.push(`OPTION_COUNT_${opts.length}`)
  if (opts.some(o => !o.content) && !issues.options.some(r => r.startsWith('EMPTY_OPTION_TEXT'))) issues.options.push('EMPTY_OPTION_TEXT')
  const proposed = opts.filter(o => o.is_proposed_correct)
  if (!proposed.length && !issues.answer.length) issues.answer.push('NO_PROPOSED_ANSWER')
  else if (proposed.length && !proposed[0].content) issues.answer.push(`KEY_${proposed[0].marker}_POINTS_AT_EMPTY_OPTION`)
  if (q.answer_key_source && !proposed.length) issues.answer.push('KEY_HAS_NO_OPTION')

  const figures = (media || []).filter(m => m.media_kind !== 'TEXT_REGION')
  if (figures.length) issues.visual = issues.visual.filter(r => !r.startsWith('VISUAL_FROM_LAYOUT_GAP_NEEDS_CONFIRMATION'))
  // A question whose visual lives in its shared material is satisfied by the material figure.
  const materialFigures = material ? material.media.filter(m => m.media_kind !== 'TEXT_REGION') : []
  if (materialFigures.length) issues.visual = issues.visual.filter(r => !r.startsWith('VISUAL_EXPECTED_BUT_NONE_FOUND'))
  for (const r of rejectedVisual.get(number) || []) issues.visual.push(`VISUAL_CANDIDATE_REJECTED(${r.reasons.join('+')}) [B4.3, not persisted]`)
  if (material) for (const r of material.row.review_reasons || []) (MATERIAL_VISUAL.test(r) ? issues.visual : issues.material).push(`M${material.row.position}: ${r}`)
  if (DIRECTIONS_DEPENDENT.has(number) && !material) issues.material.push('SHARED_MATERIAL_NOT_LINKED')

  const teRows = [te, ...opts.map(o => o.te)].filter(Boolean)
  for (const t of teRows) if ((t.ocr_review_reasons || []).length && !(t.ocr_review_reasons.length === 1 && t.ocr_review_reasons[0] === 'TELUGU_OPTIONS_NOT_IN_SOURCE')) issues.telugu.push(...t.ocr_review_reasons)

  const stem = q.content || ''
  if (opts.length && (stem.match(/(^|\s)[A-D]\)/g) || []).length >= 2) issues.stem.push('STEM_CONTAINS_OPTION_TEXT')
  if (!stem) issues.stem.push('ENGLISH_STEM_EMPTY')

  const blocking = Object.entries(issues).filter(([, v]) => v.length)
  return { number, q, opts, te, media, material, issues, blocking, rejected: rejectedVisual.get(number) || [] }
})

const ready = r => !r.blocking.length
const count = pred => rows.filter(pred).length
const summary = {
  total: rows.length,
  ready: count(ready),
  needsReview: count(r => !ready(r)),
  exactlyFour: count(r => r.opts.length === 4),
  options: count(r => r.issues.options.length),
  telugu: count(r => r.issues.telugu.length),
  visual: count(r => r.issues.visual.length),
  answer: count(r => r.issues.answer.length),
  stem: count(r => r.issues.stem.some(x => x === 'STEM_CONTAINS_OPTION_TEXT')),
  stemEmpty: count(r => r.issues.stem.includes('ENGLISH_STEM_EMPTY')),
  materialMissing: count(r => r.issues.material.includes('SHARED_MATERIAL_NOT_LINKED')),
  materialQuestions: count(r => r.material),
  materialBlocks: dump.materials.length,
  materialBlocksLinked: dump.materials.filter(m => (m.row.applies_to_questions || []).length).length,
  materialReview: count(r => r.issues.material.length),
  structure: count(r => r.issues.structure.length),
  onlyTelugu: count(r => r.blocking.length && r.blocking.every(([k]) => k === 'telugu')),
}

// ---------- rendering ------------------------------------------------------------------------
const chip = (text, tone) => `<span class="chip ${tone}">${esc(text)}</span>`
const mediaById = new Map(dump.questions.flatMap(q => q.media).concat(dump.materials.flatMap(m => m.media)).map(m => [m.id, m]))
function teluguCell(t, allMedia) {
  if (!t) return null
  if (t.text_quality === 'SCRIPT_NEUTRAL') return 'NEUTRAL'
  const crop = t.source_media_id ? mediaById.get(t.source_media_id) : null
  const attempt = crop?.detection_detail?.ocrText
  if (t.text_quality === 'OCR_EXTRACTED') {
    const tone = t.ocr_verdict === 'HIGH' ? 'ok' : 'warn'
    return `<div class="tecell"><div>${chip(`OCR ${t.ocr_verdict.toLowerCase()} · ${Math.round(t.ocr_confidence * 100)}`, tone)}<div lang="te" class="te">${esc(t.content)}</div></div>
${t.ocr_verdict !== 'HIGH' && crop ? `<div class="crop"><small>source</small>${img(crop.storage_path, 'Telugu source')}</div>` : ''}</div>`
  }
  if ((t.ocr_review_reasons || [])[0] === 'TELUGU_OPTIONS_NOT_IN_SOURCE') return '<span class="muted">not printed in Telugu in the source</span>'
  return `<div class="tecell"><div>${chip(`not stored — ${(t.ocr_review_reasons || []).join(', ') || 'MISSING'}`, 'bad')}${attempt ? `<div lang="te" class="te attempt">${esc(attempt)}</div>` : ''}</div>
${crop ? `<div class="crop"><small>source</small>${img(crop.storage_path, 'Telugu source')}</div>` : ''}</div>`
}

function materialCard(m, anchor) {
  const r = m.row
  const figures = m.media.filter(x => x.media_kind !== 'TEXT_REGION')
  const teCrops = m.media.filter(x => x.media_kind === 'TEXT_REGION')
  const reasons = r.review_reasons || []
  return `<section class="material" id="${anchor}">
<header><h2>Shared material M${r.position}</h2>${chip(r.material_type, 'neutral')} ${chip(`applies to Q${(r.applies_to_questions || []).join(', Q') || '—'}`, 'key')}
<small class="muted">pages ${r.source_page_start}${r.source_page_end !== r.source_page_start ? `–${r.source_page_end}` : ''} · range ${esc(r.range_source)} · confidence ${r.extraction_confidence ?? '—'}</small></header>
<p class="small muted">${esc(r.heading || '')}</p>
${r.content_text ? `<details ${r.content_text.length < 600 ? 'open' : ''}><summary>English text (${r.content_text.length} chars)</summary><p>${esc(r.content_text)}</p></details>` : '<p class="muted">No English text.</p>'}
${(r.warnings || []).length ? `<p class="small muted">${esc(r.warnings.join(' · '))}</p>` : ''}
${figures.length ? `<div class="visual"><h3>Figures ${chip(`automatic · ${figures.length}`, 'ok')}</h3>${figures.map(f => img(f.storage_path, `M${r.position} figure`)).join('')}</div>` : ''}
${teCrops.length ? `<div class="visual"><h3>Telugu source region ${chip('not OCR\'d — kept for review', 'warn')}</h3>${teCrops.map(f => img(f.storage_path, `M${r.position} Telugu source`)).join('')}</div>` : ''}
${reasons.length ? `<ul class="reasons">${reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
</section>`
}

const shownMaterials = new Set()
function card(r) {
  const { q, opts, te, media, material } = r
  const isReady = ready(r)
  let prefix = ''
  if (material && !shownMaterials.has(material.row.id)) { shownMaterials.add(material.row.id); prefix = materialCard(material, `m${material.row.position}`) }
  const figures = (media || []).filter(m => m.media_kind === 'FIGURE' || (m.media_kind !== 'TEXT_REGION'))
  const teStem = te ? teluguCell(te) : '<span class="muted">No Telugu in the source</span>'
  const optionRows = opts.map(o => {
    const t = teluguCell(o.te)
    const cell = t === 'NEUTRAL' ? `<span class="shared">${esc(o.content)}</span> ${chip('same in both languages', 'neutral')}` : (t || '<span class="muted">—</span>')
    return `<tr class="${o.is_proposed_correct ? 'key' : ''}"><th>${esc(o.marker)}</th><td>${o.content ? esc(o.content) : '<span class="bad-text">(empty)</span>'}${o.is_proposed_correct ? ` ${chip('proposed answer', 'key')}` : ''}</td><td>${cell}</td></tr>`
  }).join('')
  const labels = { options: 'Options', answer: 'Answer key', telugu: 'Telugu OCR', visual: 'Visual', material: 'Shared material', stem: 'English stem', structure: 'Structure' }
  const reasonList = r.blocking.map(([k, v]) => `<li><b>${labels[k]}:</b> ${esc([...new Set(v)].join(' · '))}</li>`).join('')
  return `${prefix}<article class="q ${isReady ? 'ready' : 'review'}" data-cats="${r.blocking.map(([k]) => k).join(' ')}" data-ready="${isReady}" id="q${r.number}">
<header><h2>Q${r.number}</h2>${isReady ? chip('READY', 'ok') : chip('NEEDS REVIEW', 'bad')}
<small class="muted">${esc(q.source_reference || '')} · stored status ${esc(q.extraction_status)} · proposed ${opts.find(o => o.is_proposed_correct)?.marker ?? '—'} (proposed only, not confirmed)</small></header>
${material ? `<p class="matref">${chip(`uses shared material M${material.row.position}`, 'key')} <a href="#m${material.row.position}">${esc(material.row.material_type.toLowerCase())} · Q${(material.row.applies_to_questions || []).join(', Q')}</a></p>` : ''}
<div class="stems"><div><h3>English stem <small class="muted">(as stored)</small></h3><p>${q.content ? esc(q.content) : '<span class="bad-text">(empty)</span>'}</p></div>
<div><h3>Telugu stem</h3>${teStem}</div></div>
${figures.length ? `<div class="visual"><h3>Automatic visual ${chip(`B4.3 · confidence ${figures[0].detection_confidence}`, 'ok')}</h3>${figures.map(f => img(f.storage_path, `Q${r.number} visual`)).join('')}</div>` : ''}
${r.rejected.length ? `<div class="visual"><h3>Visual not attached ${chip('teacher to capture', 'bad')}</h3>${r.rejected.map(v => (fs.existsSync(path.join('reports/b43', v.contextFile)) ? `<img loading="lazy" alt="Q${r.number} rejected visual" src="data:image/png;base64,${fs.readFileSync(path.join('reports/b43', v.contextFile)).toString('base64')}">` : '')).join('')}</div>` : ''}
<table class="opts"><thead><tr><th></th><th>English option</th><th>Telugu version</th></tr></thead><tbody>${optionRows || '<tr><td colspan="3" class="bad-text">No options</td></tr>'}</tbody></table>
${(q.warnings || []).length ? `<p class="small muted">${esc(q.warnings.join(' · '))}</p>` : ''}
${reasonList ? `<ul class="reasons">${reasonList}</ul>` : ''}
</article>`
}

const cards = rows.map(card).join('\n')
const tile = (label, value, tone, filter, note = '') => `<button class="tile ${tone}" data-filter="${filter}"><span class="v">${value}</span><span class="l">${esc(label)}</span>${note ? `<span class="n">${esc(note)}</span>` : ''}</button>`
const ba = (key, after) => (before && before[key] !== undefined ? `was ${before[key]}` : '')
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prepared Draft preview</title>
<style>
:root{--bg:#f5f4ef;--fg:#1c2230;--muted:#687080;--card:#fff;--line:#dcd8cc;--ok:#1f7a4d;--okbg:#e3f3ea;--warn:#8a5a00;--warnbg:#fbf0d6;--bad:#a3342a;--badbg:#fbe6e3;--key:#1d4f91;--keybg:#e2ecfa;--neutral:#5a6070;--neutralbg:#eceef2;--mat:#f0ecfa}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#14171d;--fg:#e7e5de;--muted:#9aa1ad;--card:#1d2129;--line:#343a45;--okbg:#17372a;--warnbg:#3a2e12;--badbg:#3d1d1a;--keybg:#18284a;--neutralbg:#2a2f38;--ok:#6fd3a0;--warn:#f0c46a;--bad:#f19a90;--key:#8fb4ff;--neutral:#b9c0cc;--mat:#241f33}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,"Noto Sans Telugu","Nirmala UI",sans-serif}
main{max-width:1180px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:0}h3{font-size:13px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
.lead{margin:4px 0 12px;color:var(--muted)}.answer{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:12px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;text-align:left;cursor:pointer;color:inherit;font:inherit;display:flex;flex-direction:column}
.tile.active{outline:2px solid var(--key)}.tile .v{font-size:26px;font-weight:700}.tile .l{font-size:13px}.tile .n{font-size:12px;color:var(--muted)}
.tile.ok .v{color:var(--ok)}.tile.bad .v{color:var(--bad)}.tile.warn .v{color:var(--warn)}
.q,.material{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0}
.material{background:var(--mat);border-left-color:var(--key)}
.q.ready{border-left-color:var(--ok)}.q.review{border-left-color:var(--bad)}
.q header,.material header{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;margin-bottom:8px}
.stems{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media (max-width:760px){.stems{grid-template-columns:1fr}}
.stems p{margin:0}.te{font-size:17px;white-space:pre-wrap}.te.attempt{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--bad)}
.tecell{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start}.tecell>div{flex:1 1 180px;min-width:0}
.crop,.tecell>.crop{flex:1 1 100%;min-width:0}.crop img,.visual img{max-width:100%;height:auto;display:block;background:#fff;border:1px solid var(--line);margin-top:2px}
.visual{margin:10px 0}.visual img{max-width:520px;margin-bottom:6px}
table.opts{width:100%;border-collapse:collapse;margin-top:10px}table.opts th,table.opts td{border-top:1px solid var(--line);padding:6px;vertical-align:top;text-align:left}
table.opts thead th{font-size:12px;color:var(--muted);font-weight:600}table.opts tbody th{width:28px}table.opts td{width:48%}
.chip{display:inline-block;font-size:12px;border-radius:999px;padding:0 8px;line-height:20px;white-space:nowrap}
.chip.ok{background:var(--okbg);color:var(--ok)}.chip.warn{background:var(--warnbg);color:var(--warn)}.chip.bad{background:var(--badbg);color:var(--bad)}
.chip.key{background:var(--keybg);color:var(--key)}.chip.neutral{background:var(--neutralbg);color:var(--neutral)}
.shared{font-size:16px}.muted{color:var(--muted)}.small{font-size:13px}.bad-text{color:var(--bad)}.matref{margin:0 0 8px}.matref a{color:var(--key)}
.reasons{margin:10px 0 0;padding-left:18px;font-size:13px}.reasons li{margin:2px 0}
.bar{position:sticky;top:0;background:var(--bg);padding:6px 0;z-index:2;display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px}
.bar input{font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:inherit;width:110px}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:8px 0}summary{cursor:pointer;font-weight:600}
</style></head><body><main>
<h1>Prepared Draft preview — SI/Constable Test-10</h1>
<p class="lead">Read-only. Rendered from the <b>persisted Draft</b> (writers 0023–0026 on throwaway PostgreSQL, ${esc(dump.generated)}). Every answer shown is <b>proposed only</b>.</p>
<div class="tiles">
${tile('Total questions', summary.total, '', 'all')}
${tile('Automatically prepared', summary.ready, 'ok', 'ready', ba('ready'))}
${tile('Needs review', summary.needsReview, 'bad', 'review', ba('needsReview'))}
${tile('Missing / abnormal options', summary.options, 'warn', 'options', ba('options'))}
${tile('Telugu OCR review', summary.telugu, 'warn', 'telugu', ba('telugu'))}
${tile('Visual review', summary.visual, 'warn', 'visual', ba('visual'))}
${tile('Answer-key issues', summary.answer, summary.answer ? 'warn' : 'ok', 'answer', ba('answer'))}
${tile('Stems with option text', summary.stem, summary.stem ? 'bad' : 'ok', 'stem', ba('stem'))}
${tile('Shared material missing', summary.materialMissing, summary.materialMissing ? 'bad' : 'ok', 'material', before ? `was ${before.material}` : '')}
${tile('Shared-material review', summary.materialReview, 'warn', 'material', `${summary.materialBlocks} blocks, ${summary.materialQuestions} questions linked`)}
</div>
<div class="answer"><b>If a teacher uploaded this PDF today:</b>
<ul>
<li><b>${summary.ready} of ${summary.total}</b> questions could be approved without edits; ${summary.needsReview} need at least one teacher action.</li>
<li>Stems are stem-only (${summary.stem} contaminated${before ? `, was ${before.stem}` : ''}); ${summary.exactlyFour} questions have exactly four options; all ${summary.materialBlocks} Directions blocks are stored as shared materials referenced by ${summary.materialQuestions} questions.</li>
<li>Telugu is the dominant remaining work: ${summary.telugu} questions carry at least one Telugu region to check or retype; for ${summary.onlyTelugu} of them Telugu is the <i>only</i> thing left.</li>
<li>Shared materials still need a teacher for their Telugu text (not OCR'd) — ${summary.materialReview} questions reference a material with review reasons.</li>
</ul>
<details><summary>How READY / NEEDS REVIEW is decided</summary><p class="small">READY = no issue in any category. Options: stored review reasons or a count other than four or an empty option. Answer key: none proposed, or proposed on an empty option. Visual: stored B4.1 visual reasons not satisfied by a persisted question or material figure, plus B4.3 candidates rejected for the question (pipeline signal, not yet persisted). Shared material: a Directions block governs the question but no material is linked, or the linked material carries review reasons. Telugu: any persisted Telugu row with review reasons (a source that prints no Telugu options is not a review). English stem: contains two or more option markers, or is empty. Nothing here changes stored status (routing is B4.5).</p></details>
</div>
<div class="bar"><span id="shown"></span><label>Jump to Q <input id="jump" type="number" min="1" max="200"></label><button class="tile" data-filter="all" style="padding:4px 10px;flex-direction:row">Show all</button></div>
${cards}
</main>
<script>
const tiles=[...document.querySelectorAll('[data-filter]')], cards=[...document.querySelectorAll('article.q')], shown=document.getElementById('shown'), mats=[...document.querySelectorAll('section.material')]
function apply(f){cards.forEach(c=>{const on=f==='all'||(f==='ready'&&c.dataset.ready==='true')||(f==='review'&&c.dataset.ready==='false')||c.dataset.cats.split(' ').includes(f);c.style.display=on?'':'none'});
mats.forEach(m=>m.style.display=(f==='all'||f==='material')?'':'none');tiles.forEach(t=>t.classList.toggle('active',t.dataset.filter===f&&f!=='all'));shown.textContent=cards.filter(c=>c.style.display!=='none').length+' of '+cards.length+' questions shown'}
tiles.forEach(t=>t.addEventListener('click',()=>apply(t.dataset.filter)))
document.getElementById('jump').addEventListener('change',e=>{apply('all');document.getElementById('q'+e.target.value)?.scrollIntoView({behavior:'smooth'})})
apply('all')
</script></body></html>`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html)
fs.writeFileSync(path.join(path.dirname(OUT), 'draft-preview-summary.json'), JSON.stringify({ summary, before,
  perQuestion: rows.map(r => ({ number: r.number, ready: ready(r), issues: r.issues })) }, null, 2))
console.log(JSON.stringify(summary))
console.log(`Preview: ${path.resolve(OUT)} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`)
