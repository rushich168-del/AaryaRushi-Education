// B4.8.3C — deduplicated math-image recovery: pure helpers (platform-neutral; no I/O, no network).
//
// A math bitmap is identified by its exact pixels (`fp`, computed in pdf-page-model-core). A teacher
// resolves one fingerprint once; every placement of the same pixels can then receive that verified
// value. Nothing here reads a bitmap, recognises maths or proposes a value: the value comes from the
// teacher. This module only
//   * groups placements by fingerprint (groupMathImages),
//   * converts friendly teacher input to the restricted form (friendlyToLatex),
//   * validates that restricted form (validateMathLatex) — the only maths the Draft stores, and a
//     subset of what MathText/KaTeX renders,
//   * places a verified value in an owner's stored text at the recorded anchor, or refuses
//     (placeAtAnchor). It never guesses a position.
//
// Restricted form: one \( … \) span whose body uses only digits, a decimal point, single Latin letters,
// spaces, + - = ( ) , . %, \times \div \pi \pm \circ, \frac{…}{…}, \sqrt{…}, ^{…}, _{…}; braces
// balanced; nothing else (no macros, no \text, no URLs, no HTML).

export const MATH_RECOVERY_VERSION = '1.0.0'

// ---- grouping --------------------------------------------------------------------------------
// questions: the layout model's questions ({ number, notation }) or Draft rows
// ({ source_question_number, analysis_regions: { notation } }).
export function groupMathImages(questions) {
  const groups = new Map()
  for (const q of questions || []) {
    const number = String(q.number ?? q.source_question_number ?? '')
    const notation = q.notation || q.analysis_regions?.notation || []
    for (const n of notation) {
      if (n.kind !== 'IMAGE') continue
      const fp = n.fp || null
      const key = fp || `unreadable:${number}:${n.page}:${n.box?.x ?? n.x},${n.box?.y ?? n.y}`   // never merged
      const g = groups.get(key) || { fp, px: n.px ?? null, occurrences: [] }
      g.occurrences.push({ question: number, questionId: q.id ?? null, side: n.side, owner: n.owner ?? null, page: n.page,
        box: n.box ?? null, anchor: n.anchor ?? null })
      groups.set(key, g)
    }
  }
  // Most-reused first, then paper order.
  const firstQ = g => Math.min(...g.occurrences.map(o => Number(o.question) || Infinity))
  return [...groups.values()].sort((a, b) => (b.occurrences.length - a.occurrences.length) || (firstQ(a) - firstQ(b)))
}

// ---- restricted representation ----------------------------------------------------------------
const COMMANDS = new Set(['frac', 'sqrt', 'times', 'div', 'pi', 'pm', 'circ'])
const ARITY = { frac: 2, sqrt: 1 }

// Validate a body (without \( \)). Returns null when valid, else a reason code.
export function validateMathBody(body) {
  const s = String(body ?? '')
  if (!s.trim()) return 'EMPTY'
  if (s.length > 200) return 'TOO_LONG'
  let i = 0
  const group = depth => {                           // parse until the matching '}' (depth>0) or end
    while (i < s.length) {
      const c = s[i]
      if (c === '}') { if (depth === 0) throw 'UNBALANCED_BRACES'; i++; return }
      if (c === '{') throw 'BARE_BRACE'
      if (c === '\\') {
        const m = /^\\([a-zA-Z]+)/.exec(s.slice(i))
        if (!m) { if (s[i + 1] === '%' || s[i + 1] === ',') { i += 2; continue } throw 'BAD_ESCAPE' }
        if (!COMMANDS.has(m[1])) throw `COMMAND_NOT_ALLOWED(${m[1]})`
        i += m[0].length
        for (let k = 0; k < (ARITY[m[1]] || 0); k++) arg(depth)
        continue
      }
      if (c === '^' || c === '_') { i++; arg(depth); continue }
      if (!/[0-9A-Za-z .+\-=(),%]/.test(c)) throw `CHARACTER_NOT_ALLOWED(${c})`
      if (/[A-Za-z]/.test(c) && /[A-Za-z]/.test(s[i + 1] || '')) throw 'WORDS_NOT_ALLOWED'   // single letters only
      i++
    }
    if (depth > 0) throw 'UNBALANCED_BRACES'
  }
  const arg = depth => {
    while (s[i] === ' ') i++
    if (s[i] !== '{') throw 'ARGUMENT_NEEDS_BRACES'
    i++
    const start = i
    group(depth + 1)
    if (!s.slice(start, i - 1).trim()) throw 'EMPTY_ARGUMENT'
  }
  try { group(0); return null } catch (e) { return typeof e === 'string' ? e : 'INVALID' }
}

// A stored value: exactly one \( … \) span with a valid body.
export function validateMathLatex(value) {
  const m = /^\\\(([\s\S]*)\\\)$/.exec(String(value ?? '').trim())
  if (!m) return 'NOT_ONE_MATH_SPAN'
  if (m[1].includes('\\(') || m[1].includes('\\)')) return 'NESTED_SPAN'
  return validateMathBody(m[1])
}

// ---- friendly input -------------------------------------------------------------------------
// Teachers type ordinary maths; LaTeX is optional. Supported, deterministically:
//   8/11 -> \frac{8}{11}   3 1/2 -> 3\frac{1}{2}   ½ -> \frac{1}{2}   √3, sqrt(3), sqrt3 -> \sqrt{3}
//   70√3/3 -> \frac{70\sqrt{3}}{3}   (70√3)/3 -> the same   10^21 -> 10^{21}   x^2 -> x^{2}   60° -> 60^{\circ}
//   × x* -> \times   ÷ -> \div   π -> \pi
// Anything else must already be valid restricted LaTeX; otherwise the input is refused with a reason.
const VULGAR = { '½': [1, 2], '⅓': [1, 3], '⅔': [2, 3], '¼': [1, 4], '¾': [3, 4], '⅕': [1, 5], '⅖': [2, 5], '⅗': [3, 5], '⅘': [4, 5],
  '⅙': [1, 6], '⅚': [5, 6], '⅛': [1, 8], '⅜': [3, 8], '⅝': [5, 8], '⅞': [7, 8] }
export function friendlyToLatex(input) {
  let s = String(input ?? '').trim().replace(/^\\\(|\\\)$/g, '').trim()
  if (!s) return { ok: false, error: 'EMPTY' }
  if (!s.includes('\\')) {
    s = s.replace(/\s+/g, ' ')
      .replace(/(\d)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])/g, (_, d, v) => `${d}\\frac{${VULGAR[v][0]}}{${VULGAR[v][1]}}`)
      .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, v => `\\frac{${VULGAR[v][0]}}{${VULGAR[v][1]}}`)
      .replace(/(?:√|sqrt)\s*\(\s*([^()]+?)\s*\)/gi, '\\sqrt{$1}')
      .replace(/(?:√|sqrt)\s*([0-9]+(?:\.[0-9]+)?|[A-Za-z])/gi, '\\sqrt{$1}')
      .replace(/°/g, '^{\\circ}')
      .replace(/×|(?<=\d)\s*[x*]\s*(?=\d)/g, '\\times ')
      .replace(/÷/g, '\\div ')
      .replace(/π/g, '\\pi ')
      .replace(/\^\s*\(?\s*([0-9]+|[A-Za-z])\s*\)?/g, '^{$1}')
    // Fractions: an operand is a parenthesised group or a run of digits/letters/\sqrt{…} with no spaces.
    const operand = '(\\([^()]+\\)|(?:\\d+(?:\\.\\d+)?|[A-Za-z]|\\\\sqrt\\{[^}]+\\})+)'
    // Mixed number "3 1/2": ONLY plain digits over plain digits (70 √3/3 is a product, never 70 + √3/3).
    s = s.replace(/(^|[^\d\\}])(\d+) (\d+)\s*\/\s*(\d+)(?![\d.])/g, (all, pre, whole, n, d) => `${pre}${whole}\\frac{${n}}{${d}}`)
    s = s.replace(new RegExp(`${operand}\\s*/\\s*${operand}`, 'g'), (all, n, d) => `\\frac{${strip(n)}}{${strip(d)}}`)
    s = s.replace(/\s+/g, ' ').trim()
  }
  const error = validateMathBody(s)
  return error ? { ok: false, error } : { ok: true, latex: `\\(${s}\\)` }
}
const strip = x => x.replace(/^\((.*)\)$/, '$1').trim()

// Plain linear reading of a restricted value (for occurrence previews in text-only surfaces).
export const linearOf = latex => String(latex ?? '').replace(/^\\\(|\\\)$/g, '')
  .replace(/\\frac\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\{([^{}]*)\}/g, '($1)/($2)').replace(/\\sqrt\{([^}]*)\}/g, '√$1')
  .replace(/\^\{\\circ\}/g, '°').replace(/\^\{([^}]*)\}/g, '^$1').replace(/\\times/g, '×').replace(/\\div/g, '÷').replace(/\\pi/g, 'π').trim()

// ---- placement ------------------------------------------------------------------------------
// Put a verified value into an owner's stored text at the bitmap's anchor. Exact or refused:
//   * empty owner text and an empty anchor -> the value alone;
//   * otherwise the text must contain "before" immediately followed (spaces allowed) by "after"
//     EXACTLY ONCE; the value goes between them. No match or several matches -> refused.
export function placeAtAnchor(content, anchor, latex) {
  if (validateMathLatex(latex)) return { ok: false, why: 'INVALID_VALUE' }
  if (!anchor) return { ok: false, why: 'NO_ANCHOR' }
  const text = String(content ?? '')
  const before = anchor.before || '', after = anchor.after || ''
  if (!text.trim()) return !before && !after ? { ok: true, content: latex } : { ok: false, why: 'OWNER_TEXT_MISSING' }
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  const re = new RegExp(`${before ? esc(before) : '^'}(\\s*)${after ? `(?=${esc(after)})` : '$'}`, 'g')
  const hits = [...text.matchAll(re)]
  if (hits.length !== 1) return { ok: false, why: hits.length ? 'ANCHOR_AMBIGUOUS' : 'ANCHOR_NOT_FOUND' }
  const gap = hits[0][1]
  const at = hits[0].index + hits[0][0].length - gap.length
  const left = text.slice(0, at), right = text.slice(at + gap.length)
  // A whole number directly before the bitmap is a mixed number (15 + ⅔ -> 15⅔): attach. Otherwise keep
  // one space between words and the value.
  const joinL = !left ? '' : /\d$/.test(left) ? '' : ' '
  const joinR = !right ? '' : /^[%.,)]/.test(right) ? '' : ' '
  return { ok: true, content: `${left}${joinL}${latex}${joinR}${right}` }
}
