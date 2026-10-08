import {reviewReasons, numberingIssues} from './printedPaperReview.js'

export const hasAnswer = q => Number.isInteger(q.correct) && q.correct >= 0 && q.correct < 4
export function questionIssues(q) {
 const issues=[]
 if (!q.content?.trim()) issues.push('Question content is missing. Restore it from the source paper.')
 if (q.options?.length!==4 || q.options.some(x=>!String(x).trim())) issues.push('Four answer choices are required.')
 if (q.reviewConfirmed!==true && q.answerChanged) issues.push('An existing answer was changed. Check it against your answer key.')
 if (q.markedForReview) issues.push('Marked for your review. Resolve it or remove the review mark.')
 if (q.reviewConfirmed!==true) issues.push(...reviewReasons(q))
 return [...new Set(issues)]
}
export function paperReview(p) {
 const items=(p.questions||[]).map((q,index)=>({q,index,reasons:questionIssues(q)}))
 return {items, pending:items.filter(x=>x.reasons.length), answersMissing:items.filter(x=>!hasAnswer(x.q)), numbering:numberingIssues(p.questions||[],p.expectedCount||p.questions?.length||0)}
}
