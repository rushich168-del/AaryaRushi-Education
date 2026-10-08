export const PRINTED_PREFIX = 'KSC_PRINTED_V1:'
export const imageDataPattern = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/

export function printedContent(blocks) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 300) throw new Error('Question content is missing or too large.')
  for (const b of blocks) {
    if (b.type === 'image' ? !imageDataPattern.test(b.src || '') : b.type !== 'text' || typeof b.text !== 'string') throw new Error('Unsupported question content.')
  }
  return PRINTED_PREFIX + JSON.stringify({ blocks })
}

export function readPrintedContent(text) {
  if (typeof text !== 'string' || !text.startsWith(PRINTED_PREFIX)) return null
  try { const value = JSON.parse(text.slice(PRINTED_PREFIX.length)); printedContent(value.blocks); return value } catch { return { blocks: [{ type: 'text', text: 'Question could not be displayed. Please contact your teacher.' }] } }
}

export function parseAnswerKey(text, questions) {
  const answers = new Map()
  const validNumbers = new Set(questions.map(q => q.number))
  const lines = text.trim().split(/\r?\n/).filter(x => x.trim())
  for (const line of lines) {
    // Explicit number-answer pairs only; never infer an answer from question prose.
    const m = line.trim().match(/^(\d+)\s*[.):,=\-\t ]\s*([A-Da-d1-4])\s*$/)
    if (!m || !validNumbers.has(Number(m[1])) || answers.has(Number(m[1]))) throw new Error(`Check this answer-key line: ${line}`)
    answers.set(Number(m[1]), /[1-4]/.test(m[2]) ? Number(m[2]) - 1 : m[2].toUpperCase().charCodeAt(0) - 65)
  }
  return questions.map(q => ({ ...q, correct: answers.has(q.number) ? answers.get(q.number) : q.correct }))
}
