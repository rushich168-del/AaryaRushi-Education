import MathText from '../math/MathText.jsx'
import { readPrintedContent } from '../../services/printedPaperContract.js'

export default function PrintedQuestionContent({ text }) {
  const printed = readPrintedContent(text)
  if (!printed) return <MathText text={text} />
  return <div className="space-y-2 min-w-0" aria-label="Original question">
    {printed.blocks.map((b, i) => b.type === 'image'
      ? <img key={i} src={b.src} alt={b.alt || 'Printed question'} className="block h-auto max-w-full" />
      : <p key={i} className={`whitespace-pre-wrap break-words leading-relaxed ${b.bold ? 'font-semibold' : ''}`}>{b.text}</p>)}
  </div>
}
