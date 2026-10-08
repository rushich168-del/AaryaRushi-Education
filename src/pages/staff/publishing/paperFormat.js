// Display helpers shared by the publish-a-test screens.

function totalMarks(paper) {
  const total = Number(paper.question_count) * Number(paper.marks)
  return Number.isFinite(total) ? Number(total.toFixed(2)) : null
}

const NBSP = String.fromCharCode(160)

// "Version 1 · 150 questions · 60 min · 150 marks". Each fact stays on one line when the row wraps.
export function paperFacts(paper) {
  const facts = [`Version ${paper.version}`, `${paper.question_count} questions`, `${paper.duration} min`]
  const marks = totalMarks(paper)
  if (marks !== null) facts.push(`${marks} marks`)
  return facts.map(fact => fact.replaceAll(' ', NBSP)).join(' · ')
}

// Questions, minutes and total marks as separate numbers for the confirm card.
export function paperStats(paper) {
  return [
    { value: paper.question_count, label: 'Questions' },
    { value: paper.duration, label: 'Minutes' },
    { value: totalMarks(paper), label: 'Marks' },
  ].filter(stat => stat.value !== null && stat.value !== undefined && stat.value !== '')
}

// "Group-II" → "G2", "SI & Constable" → "SC", "DSC" → "DSC". Decorative only.
export function programInitials(name = '') {
  const roman = { I: '1', II: '2', III: '3', IV: '4' }
  const words = String(name).split(/[\s&\-–/]+/).filter(Boolean)
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  return words
    .slice(0, 2)
    .map(word => roman[word.toUpperCase()] || word[0])
    .join('')
    .toUpperCase()
}

export function sharedDate(paper) {
  const date = new Date(paper.created_at)
  if (!paper.created_at || Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// "6 Oct 2026" — when students first could take the test. Tells repeated titles apart.
export function publishedDate(delivery) {
  const date = new Date(delivery.opens_at || delivery.created_at)
  if (!(delivery.opens_at || delivery.created_at) || Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// Results for one published test when its test id is known; otherwise all results.
export const resultsLink = (resultsHref, delivery) =>
  delivery.test_id ? `${resultsHref}?test=${encodeURIComponent(delivery.test_id)}` : resultsHref

export const publicationKey = (versionId, programId) => `${versionId}:${programId}`

export function deliveryStatus(delivery, now = Date.now()) {
  if (delivery.closes_at && Date.parse(delivery.closes_at) <= now) return 'Closed'
  if (delivery.opens_at && Date.parse(delivery.opens_at) > now) return 'Scheduled'
  return 'Available'
}

// New tests belong to a program; older ones keep their course and batches.
export const deliveryGroup = delivery => delivery.program || delivery.course || 'Other tests'

export function deliveryAudience(delivery) {
  if (delivery.program) return `${delivery.program} · Program students`
  return [delivery.course, (delivery.batches || []).join(', ')].filter(Boolean).join(' · ')
}

const technical = /PGRST|\b[0-9]{2}[0-9A-Z]{3}\b|\brpc\b|\bsql\b|schema|function|undefined|\bnull\b|json|exception|stack|ksc_/i

// Staff see plain words; the original error goes to the console for developers.
export function plainMessage(error, fallback) {
  const message = String(error?.message || '').trim()
  if (message && !technical.test(message)) return message
  console.error('[publishing]', error)
  return fallback
}
