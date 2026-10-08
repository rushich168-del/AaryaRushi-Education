import katex from 'katex'

const MATH_PATTERN = /\\(frac|sqrt|in|notin|cup|cap|le|ge|ne|neq|theta|pi|subset)|[\u2260\u2264\u2265\u2208\u2209\u222a\u2229\u221a\u00b2\u00b3]|\^\{[^}]+\}|_\{[^}]+\}|\^[A-Za-z0-9]/

// A "strong" math word carries an unambiguous math signal (command, brace,
// super/subscript, relation, or a math symbol). Such a word anchors a math run.
const STRONG_MATH_WORD =
  /\\[A-Za-z]+|[{}^_=]|[\u2260\u2264\u2265\u2208\u2209\u222a\u2229\u221a\u00b2\u00b3\u2282\u03b8\u03c0]/
// A "weak" math word is a lone variable, number or operator. It can join an
// existing math run (e.g. the `x` in `x \u2208 A`) but never starts one on its own,
// so ordinary prose is not dragged into math mode.
const WEAK_MATH_WORD = /^[A-Za-z]$|^\d+$|^[-+*/=<>]+$/

function classifyWord(word) {
  if (STRONG_MATH_WORD.test(word)) return 'strong'
  if (WEAK_MATH_WORD.test(word)) return 'weak'
  return 'prose'
}

function hasMath(text) {
  return MATH_PATTERN.test(String(text || ''))
}

function normalizeForKatex(value) {
  return String(value || '')
    .replace(/\u2260/g, '\\ne ')
    .replace(/\u2264/g, '\\le ')
    .replace(/\u2265/g, '\\ge ')
    .replace(/\u2208/g, '\\in ')
    .replace(/\u2209/g, '\\notin ')
    .replace(/\u222a/g, '\\cup ')
    .replace(/\u2229/g, '\\cap ')
    .replace(/\u00b2/g, '^2')
    .replace(/\u00b3/g, '^3')
    .replace(/\u221a\s*\{([^}]+)\}/g, '\\sqrt{$1}')
    .replace(/\u221a\s*([A-Za-z0-9]+(?:\^(?:\{[^}]*\}|[A-Za-z0-9]+))?)/g, '\\sqrt{$1}')
    .trim()
}

function renderKatex(expression) {
  const normalized = normalizeForKatex(expression)
  if (!normalized) {
    return null
  }
  try {
    return katex.renderToString(normalized, {
      displayMode: false,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    })
  } catch {
    return null
  }
}

function findClose(text, openIndex, openChar, closeChar) {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === openChar) {
      depth += 1
    } else if (text[index] === closeChar) {
      depth -= 1
      if (depth === 0) {
        const inside = text.slice(openIndex + 1, index)
        return hasMath(inside) ? index : -1
      }
    }
  }
  return -1
}

function pushText(tokens, text) {
  if (text) {
    tokens.push({ type: 'text', value: text })
  }
}

function tokenizeExplicit(text) {
  const tokens = []
  let index = 0

  while (index < text.length) {
    const inlineIndex = text.indexOf('\\(', index)
    const displayIndex = text.indexOf('\\[', index)
    const dollarIndex = text.indexOf('$', index)
    const parenIndex = text.indexOf('(', index)
    const bracketIndex = text.indexOf('[', index)
    const candidates = [inlineIndex, displayIndex, dollarIndex, parenIndex, bracketIndex].filter((item) => item >= 0)

    if (!candidates.length) {
      pushText(tokens, text.slice(index))
      break
    }

    const next = Math.min(...candidates)
    pushText(tokens, text.slice(index, next))

    if (next === inlineIndex) {
      const end = text.indexOf('\\)', next + 2)
      if (end > next) {
        tokens.push({ type: 'math', value: text.slice(next + 2, end) })
        index = end + 2
        continue
      }
    }

    if (next === displayIndex) {
      const end = text.indexOf('\\]', next + 2)
      if (end > next) {
        tokens.push({ type: 'math', value: text.slice(next + 2, end) })
        index = end + 2
        continue
      }
    }

    if (next === dollarIndex && !/\d/.test(text[next + 1] || '')) {
      const end = text.indexOf('$', next + 1)
      if (end > next + 1) {
        const inside = text.slice(next + 1, end)
        // The trailing-digit check guards against currency like "5$"; genuine
        // inline math frequently ends in a digit ($x^{2}=4$), so let real math
        // through regardless. Currency is still blocked by the leading-digit
        // check above ($5 never reaches here).
        if (hasMath(inside) || !/\d/.test(text[end - 1] || '')) {
          tokens.push({ type: 'math', value: inside })
          index = end + 1
          continue
        }
      }
    }

    if (next === parenIndex) {
      const end = findClose(text, next, '(', ')')
      if (end > next) {
        tokens.push({ type: 'math', value: text.slice(next + 1, end) })
        index = end + 1
        continue
      }
    }

    if (next === bracketIndex) {
      const end = findClose(text, next, '[', ']')
      if (end > next) {
        tokens.push({ type: 'math', value: text.slice(next + 1, end) })
        index = end + 1
        continue
      }
    }

    pushText(tokens, text[next])
    index = next + 1
  }

  return tokens
}

function tokenizeAuto(text) {
  if (!hasMath(text)) {
    return [{ type: 'text', value: text }]
  }

  // Split into alternating word / whitespace parts so slices can be rebuilt
  // exactly. Even indices are words, odd indices are the separators between.
  const parts = text.split(/(\s+)/)
  const kinds = parts.map((part, index) => (index % 2 === 0 ? classifyWord(part) : 'space'))

  // Anchor the math run on the first strong-math word.
  let anchor = -1
  for (let index = 0; index < parts.length; index += 2) {
    if (kinds[index] === 'strong') {
      anchor = index
      break
    }
  }

  if (anchor < 0) {
    return [{ type: 'text', value: text }]
  }

  // Grow left over adjacent weak words (e.g. the `x` before `∈`) and right over
  // any strong/weak words. Stop at the first prose word so trailing normal prose
  // (e.g. "and explain your answer") stays outside math mode.
  let startWord = anchor
  for (let index = anchor - 2; index >= 0; index -= 2) {
    if (kinds[index] === 'weak') startWord = index
    else break
  }

  let endWord = anchor
  for (let index = anchor + 2; index < parts.length; index += 2) {
    if (kinds[index] === 'strong' || kinds[index] === 'weak') endWord = index
    else break
  }

  return [
    { type: 'text', value: parts.slice(0, startWord).join('') },
    { type: 'math', value: parts.slice(startWord, endWord + 1).join('') },
    { type: 'text', value: parts.slice(endWord + 1).join('') },
  ].filter((token) => token.value)
}

function tokenizeMathText(text) {
  const explicit = tokenizeExplicit(text)
  return explicit.some((token) => token.type === 'math') ? explicit : tokenizeAuto(text)
}

export default function MathText({ text, className = '' }) {
  const value = String(text || '')
  if (!value) {
    return null
  }

  return (
    <span className={className}>
      {tokenizeMathText(value).map((token, index) => {
        if (token.type !== 'math') {
          return <span key={index}>{token.value}</span>
        }
        const html = renderKatex(token.value)
        if (!html) {
          return <span key={index}>{token.value}</span>
        }
        return <span key={index} className="inline-block align-baseline" dangerouslySetInnerHTML={{ __html: html }} />
      })}
    </span>
  )
}
