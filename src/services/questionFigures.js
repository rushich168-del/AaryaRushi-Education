// Figures a creator adds by hand in the review screen, and the "no figure needed" decision.
// A figure is an ordinary printed-content image block marked added:true, so nothing new is stored.
import { printedContent, readPrintedContent } from './printedPaperContract.js'

const FIGURE_CHECK = /VISUAL|RASTER_PAGE/
const blocksOf = q => readPrintedContent(q.content)?.blocks || [{ type: 'text', text: q.content || '' }]
const sameBlock = (a, b) => !!a && !!b && a.type === b.type && (a.type === 'image' ? a.src === b.src : a.text === b.text)
// Changed content needs a fresh check by the creator, as after Correct question.
const withBlocks = (q, blocks) => ({ ...q, content: printedContent(blocks), edited: true, reviewConfirmed: false })

// A shared passage is printed at the start of every question it governs. The questions around `index`
// whose content begins with the same blocks form the passage: {from, to} are their positions, `blocks`
// how many leading blocks they share. Null when the question stands alone.
export function sharedPassage(questions, index) {
  const mine = blocksOf(questions[index])
  if (mine.length < 2) return null
  const linked = i => {
    const blocks = questions[i] && blocksOf(questions[i])
    return blocks && blocks.length >= 2 && sameBlock(blocks[0], mine[0]) ? blocks : null
  }
  const group = [mine]
  let from = index, to = index
  for (let blocks; (blocks = linked(from - 1)); from--) group.unshift(blocks)
  for (let blocks; (blocks = linked(to + 1)); to++) group.push(blocks)
  if (from === to) return null
  let blocks = 1
  while (group.every(b => blocks < b.length - 1 && sameBlock(b[blocks], mine[blocks]))) blocks++
  return { from, to, blocks, numbers: questions.slice(from, to + 1).map(q => q.number) }
}

// target 'question': after the question's own content. target 'passage': at the end of the shared
// passage of every question it governs, before each question's own content.
export function addFigure(questions, index, { src, page }, target = 'question') {
  const figure = { type: 'image', src, alt: `Figure added from page ${page}`, added: true }
  if (target !== 'passage') return questions.map((q, i) => i === index ? withBlocks(q, [...blocksOf(q), figure]) : q)
  const passage = sharedPassage(questions, index)
  if (!passage) throw new Error('This question is not part of a shared passage.')
  return questions.map((q, i) => {
    if (i < passage.from || i > passage.to) return q
    const blocks = blocksOf(q)
    return withBlocks(q, [...blocks.slice(0, passage.blocks), figure, ...blocks.slice(passage.blocks)])
  })
}

export function addedFigures(questions, index) {
  const blocks = blocksOf(questions[index])
  if (!blocks.some(b => b.added)) return []
  const passage = sharedPassage(questions, index)
  return blocks.flatMap((b, i) => b.added ? [{ src: b.src, alt: b.alt, shared: !!passage && i < passage.blocks }] : [])
}

// A passage figure leaves every question of the passage; a question's own figure leaves only that question.
export function removeFigure(questions, index, src) {
  const at = blocksOf(questions[index]).findIndex(b => b.added && b.src === src)
  if (at < 0) return questions
  const passage = sharedPassage(questions, index)
  const shared = !!passage && at < passage.blocks
  return questions.map((q, i) => (shared ? i >= passage.from && i <= passage.to : i === index)
    ? withBlocks(q, blocksOf(q).filter(b => !(b.added && b.src === src))) : q)
}

// "No figure needed": the figure checks leave the question's warnings and are kept beside them, so the
// decision is saved with the draft and can be taken back.
export const figureWarnings = q => (q.warnings || []).filter(w => FIGURE_CHECK.test(w))
export function dismissFigureWarnings(q) {
  const dismissed = figureWarnings(q)
  if (!dismissed.length) return q
  return { ...q, warnings: q.warnings.filter(w => !FIGURE_CHECK.test(w)), figureDismissed: [...(q.figureDismissed || []), ...dismissed] }
}
export function restoreFigureWarnings(q) {
  const { figureDismissed, ...rest } = q
  return figureDismissed?.length ? { ...rest, warnings: [...(q.warnings || []), ...figureDismissed] } : q
}
