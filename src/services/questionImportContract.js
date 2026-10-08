import { academicFields } from './academicContext.js'
let candidateSequence = 0

// Parser adapters return these candidates, never database rows. An unknown answer
// stays null; parsing must not infer approval or silently choose the first option.
export function importCandidate(input = {}, context = {}, source = {}) {
  return {
    id: input.id || `candidate-${++candidateSequence}`,
    content: typeof input.content === 'string' ? input.content : '', options: Array.isArray(input.options) ? input.options.map(option => typeof option === 'string' ? option : '') : ['', ''],
    correctAnswerIndex: input.correctAnswerIndex ?? null,
    explanation: input.explanation || '', difficulty: input.difficulty || 'MEDIUM',
    academic: Object.fromEntries(academicFields.map(key => [key, input.academic?.[key] || context[key] || ''])),
    source: { kind: source.kind || 'PASTE', name: source.name || '', page: source.page ?? null, row: source.row ?? null, reference: source.reference || '', ...input.source },
    included: input.included !== false, confirmed: false,
    validation: { state: 'UNVALIDATED', errors: [] },
  }
}

export function validateImportCandidate(item) {
  const errors = []
  if (!item.content?.trim()) errors.push('Question text is required.')
  if (!Array.isArray(item.options) || item.options.length < 2 || item.options.length > 6) errors.push('Provide 2–6 options.')
  if (Array.isArray(item.options) && item.options.some(option => typeof option !== 'string' || !option.trim())) errors.push('Every option needs text.')
  if (!Number.isInteger(item.correctAnswerIndex) || item.correctAnswerIndex < 0 || item.correctAnswerIndex >= (item.options?.length || 0)) errors.push('Select one correct answer.')
  if (!['EASY', 'MEDIUM', 'HARD'].includes(item.difficulty)) errors.push('Choose a valid difficulty.')
  if (!item.academic?.exam_id || !item.academic?.subject_id) errors.push('Program and academic subject are required.')
  if (item.academic?.syllabus_id && !item.academic?.level_id) errors.push('Syllabus requires a track.')
  if (item.academic?.chapter_id && !item.academic?.syllabus_id) errors.push('Chapter requires a syllabus.')
  if (item.academic?.topic_id && !item.academic?.chapter_id) errors.push('Topic requires a chapter.')
  return { state: errors.length ? 'INVALID' : 'VALID', errors }
}

export function reviseImportCandidate(item, changes) {
  const next = { ...item, ...changes, confirmed: false }
  return { ...next, validation: validateImportCandidate(next) }
}

export function readyForDraft(item) {
  return item.included && item.confirmed && validateImportCandidate(item).state === 'VALID'
}
