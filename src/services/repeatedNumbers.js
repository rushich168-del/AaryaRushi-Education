// A question number used more than once in a prepared paper, and what the creator can do about the
// extra copy: merge it into the first one (the same question in another language), delete it, or
// renumber from it (the paper really has one more question). Each action returns the paper fields to
// change, so the caller can apply it and keep the old values for Undo.
import { printedContent, readPrintedContent } from './printedPaperContract.js'
import { importedSubjectSections } from './sourceSubjectHeadings.js'
import { examFormat } from './examFormats.js'

const blocksOf = q => readPrintedContent(q.content)?.blocks || [{ type: 'text', text: q.content || '' }]
const answered = q => Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4
// The import notes on the copy that it broke the number sequence; that is settled by the creator's action.
const withoutSequenceNote = warnings => (warnings || []).filter(w => !/NUMBER_SEQUENCE/.test(w))

// The later copies of every repeated number, in paper order: `index` is the copy, `first` the question
// that used the number before it.
export function repeatedCopies(questions) {
  const seen = new Map(), copies = []
  questions.forEach((q, index) => {
    const number = Number(q.number)
    if (seen.has(number)) copies.push({ number, index, first: seen.get(number) })
    else seen.set(number, index)
  })
  return copies
}

// Why the number of questions is wrong, in the creator's terms. Empty when the counts agree.
export function sourceCountNote(paper) {
  const expected = paper.expectedCount, found = paper.questions.length
  if (!expected || expected === found) return ''
  return paper.answerKeyCount === expected
    ? `The answer key has ${expected} answers but the paper has ${found} questions.`
    : `The source paper has ${expected} questions but ${found} were found.`
}

// One question fewer: the section plan follows when it described the old count. Sections read from the
// paper's own subject headings are recounted; otherwise the section that held the removed question loses
// one, and a custom question count that matched moves with it. A plan that never matched is left alone.
function planAfterRemoval(paper, removed, questions) {
  if (!examFormat(paper.exam) || !paper.sections?.length) return {}
  const custom = examFormat(paper.exam).formats.find(f => f.id === paper.testFormat)?.custom
  const count = custom && Number(paper.targetCount) === paper.questions.length ? { targetCount: questions.length } : {}
  const fromHeadings = importedSubjectSections(questions)
  if (fromHeadings) return { sections: fromHeadings, ...count }
  if (paper.sections.reduce((n, s) => n + Number(s.count), 0) !== paper.questions.length) return {}
  let start = 0
  const sections = paper.sections.map(s => {
    const end = start + Number(s.count), held = removed >= start && removed < end
    start = end
    return held ? { ...s, count: Number(s.count) - 1 } : s
  }).filter(s => Number(s.count) > 0)
  return { sections, ...count }
}

// Same question in another language: its content follows the first copy's content and the copy goes.
export function mergeCopy(paper, index) {
  const copy = paper.questions[index]
  const target = paper.questions.findLastIndex((q, i) => i < index && Number(q.number) === Number(copy.number))
  if (target < 0) throw new Error('There is no earlier question with this number.')
  const first = paper.questions[target]
  const merged = {
    ...first,
    content: printedContent([...blocksOf(first), ...blocksOf(copy)]),
    correct: answered(first) ? first.correct : copy.correct,
    sourcePages: [...new Set([...(first.sourcePages || []), ...(copy.sourcePages || [])])],
    warnings: [...new Set([...(first.warnings || []), ...withoutSequenceNote(copy.warnings)])],
    edited: true,
    reviewConfirmed: false,
  }
  const questions = paper.questions.flatMap((q, i) => (i === index ? [] : [i === target ? merged : q]))
  return { questions, ...planAfterRemoval(paper, index, questions), target }
}

export function deleteQuestion(paper, index) {
  const questions = paper.questions.filter((_, i) => i !== index)
  return { questions, ...planAfterRemoval(paper, index, questions) }
}

// The paper really has one more question: this copy and every question after it move up by one, and the
// paper is expected to hold one more. The copy needs the creator's check (its answer came from the key
// entry of the number it shared).
export function renumberFrom(paper, index) {
  const questions = paper.questions.map((q, i) => i < index ? q
    : i === index ? { ...q, number: Number(q.number) + 1, warnings: withoutSequenceNote(q.warnings), edited: true, reviewConfirmed: false }
      : { ...q, number: Number(q.number) + 1 })
  return { questions, ...(paper.expectedCount ? { expectedCount: paper.expectedCount + 1 } : {}) }
}
