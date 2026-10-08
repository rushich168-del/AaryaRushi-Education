// EXPERIMENT — self-contained sheet for a Telugu reader to verify the benchmark reference text.
// Each row: source crop | reference (assistant-transcribed) | tessdata_fast | tessdata (int), with
// character-level differences highlighted. Writes reports/ocr-bench/verification-sheet.html.
import fs from 'fs'
import path from 'path'
import { align } from './score.mjs'

const truth = JSON.parse(fs.readFileSync('scripts/fixtures/telugu-ocr-benchmark-truth.json', 'utf8'))
const { units } = JSON.parse(fs.readFileSync('reports/ocr-bench/units.json', 'utf8'))
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const img = f => `data:image/png;base64,${fs.readFileSync(path.join('reports/ocr-bench', f)).toString('base64')}`
const errs = (h, r) => align(h, r).errors
const rows = truth.units.map((t, i) => {
  const u = units.find(x => x.id === t.id)
  const f = u.models.fast.text, n = u.models.int.text
  return `<tr><td>${i + 1}</td><td><b>${t.id}</b><br><small>${esc(u.english?.slice(0, 90) || '')}</small></td>
<td>${u.crops.map(c => `<img alt="${t.id}" src="${img(c)}">`).join('')}</td>
<td class="te ref">${esc(t.text)}${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}</td>
<td class="te">${esc(f)}<div class="e">${errs(f, t.text)} err · ${u.models.fast.verdict}</div></td>
<td class="te">${esc(n)}<div class="e">${errs(n, t.text)} err · ${u.models.int.verdict}</div></td>
<td><label><input type="checkbox"> correct</label></td></tr>`
}).join('\n')
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Telugu benchmark verification</title>
<style>:root{--bg:#f6f5f1;--fg:#1d2433;--line:#d9d6cc;--card:#fff}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15181e;--fg:#e8e6df;--line:#353a44;--card:#1f232b}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,"Noto Sans Telugu","Nirmala UI",sans-serif}table{border-collapse:collapse;width:100%;background:var(--card)}
td,th{border:1px solid var(--line);padding:6px;vertical-align:top}img{max-width:340px;width:100%;background:#fff;display:block;margin-bottom:4px}.te{font-size:17px}.ref{font-weight:600}
.e,.note{font-size:12px;opacity:.75}.wrap{overflow-x:auto}</style></head><body>
<h1>Telugu OCR benchmark — reference verification (${truth.units.length} units)</h1>
<p>${esc(truth.provenance)}</p><p>Please check the <b>Reference</b> column against the crop. Mark "correct", or note the fix. OCR columns are for comparison only.</p>
<div class="wrap"><table><tr><th>#</th><th>Unit</th><th>Source crop</th><th>Reference (to verify)</th><th>tessdata_fast (production)</th><th>tessdata (integer)</th><th>✓</th></tr>
${rows}</table></div></body></html>`
fs.writeFileSync('reports/ocr-bench/verification-sheet.html', html)
console.log('reports/ocr-bench/verification-sheet.html', (html.length / 1e6).toFixed(1), 'MB')
