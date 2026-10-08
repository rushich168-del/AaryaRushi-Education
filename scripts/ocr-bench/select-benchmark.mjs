// EXPERIMENT — deterministic selection of benchmark units from reports/ocr-bench/units.json.
// Strata use only the PRODUCTION (fast) verdict and content features, never the candidate model's
// output, so the set cannot favour either model. Writes reports/ocr-bench/selection.json.
import fs from 'fs'

const { units } = JSON.parse(fs.readFileSync('reports/ocr-bench/units.json', 'utf8'))
const byId = new Map(units.map(u => [u.id, u]))
const picked = new Map()
const add = (u, why) => { if (u && !picked.has(u.id) && u.kind !== 'BLOCK') picked.set(u.id, { id: u.id, why }) }
const spread = (xs, n) => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor((i + 0.5) * xs.length / n)]))
const len = u => (u.models.fast.text || '').length

// 1. Named golden cases.
for (const id of ['105S', '105OA', '105OB', '105OC', '105OD', '1S', '1OA', '1OB', '1OC', '1OD', '6S', '8S', '59S']) add(byId.get(id), 'named')
// 2. Previous spot-check units (every ~27th HIGH unit of the first run).
const spot = JSON.parse(fs.readFileSync('scripts/fixtures/b44-telugu-spot-truth.json', 'utf8')).units
for (const t of spot) add(byId.get(`${t.q}${t.kind === 'STEM' ? 'S' : 'O' + t.marker}`), 'b44-spot')
// 3. Mixed Telugu + Latin/number inside the Telugu unit (text-layer runs, or digits in the English).
const mixed = units.filter(u => u.glyphs.flat().some(r => 'text' in r) || (u.englishDigits || []).length)
for (const u of spread(mixed.filter(u => len(u) < 140), 10)) add(u, 'mixed-script')
// 4. Match-the-following options.
for (const u of spread(units.filter(u => u.kind === 'OPTION' && /[A-D]-\d/.test(u.english || '')), 3)) add(u, 'match-following')
// 5. Stems across the paper (stems are a large share of Telugu review items).
for (const u of spread(units.filter(u => u.kind === 'STEM' && len(u) > 20 && len(u) < 260), 8)) add(u, 'stem-spread')
// 6. Production verdict strata (short/medium units so the reference can be transcribed carefully).
for (const [v, n] of [['DIGIT_MISMATCH', 5], ['LOW', 5], ['MEDIUM', 5], ['HIGH', 5], ['NOT_TELUGU', 2], ['EMPTY', 1]]) {
  for (const u of spread(units.filter(u => u.models.fast.verdict === v && u.kind !== 'BLOCK' && len(u) < 160), n)) add(u, `fast-${v}`)
}
const out = [...picked.values()].map(p => ({ ...p, crops: byId.get(p.id).crops, english: byId.get(p.id).english, fast: byId.get(p.id).models.fast.text, int: byId.get(p.id).models.int.text }))
fs.writeFileSync('reports/ocr-bench/selection.json', JSON.stringify(out, null, 1))
console.log(out.length, out.map(o => o.id).join(' '))
