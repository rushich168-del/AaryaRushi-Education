// Printed delivery preserves the pixels: text-decoding warnings are not claims
// that the visible source is damaged. Surface only checks useful to a teacher.
export function reviewReasons(question) {
  const reasons = new Set()
  if (question.edited) reasons.add('This question was edited. Check the corrected content and answer.')
  for (const warning of question.warnings || []) {
    if (/NO_TELUGU_REGION|ENGLISH_STEM_MISSING|DUPLICATE_OPTION_TEXT|EMPTY_OPTION_TEXT|NOTATION/.test(warning)) continue
    if (/NO_ANSWER_KEY_ENTRY/.test(warning)) continue // shown separately as answer needed
    if (/NUMBER_SEQUENCE|DUPLICATE_NUMBER/.test(warning)) reasons.add('Question numbering needs checking against the paper.')
    else if (/COLUMN_MODEL/.test(warning)) reasons.add('The page columns are uncertain. Check where this question starts and ends.')
    else if (/OPTIONS|OPTION_MARKERS|UNASSIGNED_TEXT/.test(warning)) reasons.add('Check that all four choices belong to this question and none are cut off.')
    else if (/VISUAL/.test(warning)) reasons.add('Check the complete diagram or table is visible.')
    else if (/RASTER_PAGE/.test(warning)) reasons.add('This page is a picture in the PDF. Check that the question and any diagram look right.')
    else reasons.add(warning)
  }
  return [...reasons]
}

export const needsQuestionReview = question => reviewReasons(question).length > 0 && question.reviewConfirmed !== true

export function numberingIssues(questions, expected = questions.length) {
  const numbers = questions.map(q => Number(q.number))
  const missing = Array.from({length: expected}, (_, i) => i + 1).filter(n => !numbers.includes(n))
  const duplicate = [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))]
  const invalid = numbers.some(n => !Number.isInteger(n) || n < 1 || n > expected)
  const outOfOrder = !missing.length && !duplicate.length && !invalid && numbers.some((n,i)=>n!==i+1)
  return [missing.length ? `Missing question numbers: ${missing.join(', ')}.` : '', duplicate.length ? `Repeated question numbers: ${duplicate.join(', ')}.` : '', invalid ? `Use question numbers from 1 to ${expected}.` : '', outOfOrder ? 'Question numbers must follow paper order. Correct them in Edit question.' : '', questions.length !== expected ? `Expected ${expected} questions; found ${questions.length}.` : ''].filter(Boolean)
}
