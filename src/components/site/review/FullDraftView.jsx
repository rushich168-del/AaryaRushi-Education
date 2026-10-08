import { useEffect, useRef } from 'react'
import { ReadinessChip, cx } from './ReviewPanels.jsx'
import { numberRange, teluguState } from '../../../services/draftReviewModel.js'

// Secondary inspection mode: the whole prepared paper in question order (English, Telugu, options,
// figures, shared materials once). Read-only; review decisions happen in the exception queue.
const TE = 'ksc-telugu'

function TeluguLine({ row }) {
  if (!row) return null
  const s = teluguState(row)
  if (row.text_quality === 'SCRIPT_NEUTRAL') return null
  return <div className="flex flex-wrap items-baseline gap-2">
    {row.content ? <span lang="te" className={cx(TE, 'text-slate-800')}>{row.content}</span> : <span className="text-xs text-slate-500">(no Telugu text)</span>}
    <span className={cx('rounded px-1 text-[11px]', ['verified', 'corrected', 'typed'].includes(s.key) ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600')}>{s.label}</span>
  </div>
}

// reviewable=false (B4.7: preparation failed/interrupted/running): the Draft is shown for inspection only,
// without readiness chips — missing review items must not read as "No blocking issues".
export default function FullDraftView({ ix, urls, focusQuestionId, onReviewQuestion, reviewable = true }) {
  const refs = useRef(new Map())
  useEffect(() => { if (focusQuestionId) refs.current.get(focusQuestionId)?.scrollIntoView({ block: 'start' }) }, [focusQuestionId])
  const shownMaterials = new Set()
  return <div className="space-y-4" aria-label="Full Draft">
    <p className="text-sm text-slate-600">{reviewable ? 'Inspection mode: the complete prepared paper in question order. Review decisions are made in the exception queue.'
      : 'Inspection only: this Draft was not fully prepared, so it has no review status. Prepare the paper again from its import.'}</p>
    {ix.questions.map(q => {
      const material = q.shared_material_id && !shownMaterials.has(q.shared_material_id) ? ix.materialById.get(q.shared_material_id) : null
      if (material) shownMaterials.add(material.id)
      const figures = (ix.mediaByQuestion.get(q.id) || []).filter(m => m.media_kind !== 'TEXT_REGION')
      const r = ix.readinessByQuestion.get(q.id)
      return <div key={q.id} className="space-y-2">
        {material && <section className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-3" aria-label={`Shared material ${ix.materialLabel.get(material.id)}`}>
          <p className="text-xs font-semibold uppercase text-indigo-900">Shared material {ix.materialLabel.get(material.id)} · applies to {numberRange(ix.questionsByMaterial.get(material.id) || [])}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{material.content_text || material.heading}</p>
          {ix.materialText.get(material.id)?.content && <p lang="te" className={cx(TE, 'mt-1')}>{ix.materialText.get(material.id).content}</p>}
          <div className="mt-2 grid gap-2 sm:grid-cols-2">{(ix.mediaByMaterial.get(material.id) || []).filter(m => m.media_kind !== 'TEXT_REGION').map(m =>
            urls[m.storage_path] && <img key={m.id} loading="lazy" src={urls[m.storage_path]} alt={`Shared material figure, page ${m.source_page}`} className="max-h-64 w-full rounded border bg-white object-contain" />)}</div>
        </section>}
        <article ref={el => refs.current.set(q.id, el)} className="scroll-mt-4 rounded-lg border border-slate-200 bg-white p-3" aria-label={`Question ${q.source_question_number}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-bold">Q{q.source_question_number}{q.shared_material_id ? <span className="ml-2 text-xs font-normal text-indigo-800">uses {ix.materialLabel.get(q.shared_material_id)}</span> : null}</h3>
            <div className="flex items-center gap-2">{reviewable && <ReadinessChip r={r} />}{reviewable && r && (Number(r.open_blocking) > 0 || Number(r.open_advisory) > 0) &&
              <button type="button" onClick={() => onReviewQuestion(q.id)} className="text-xs font-semibold text-blue-700">Review items</button>}</div>
          </div>
          <p className="mt-1 text-sm">{q.content || <span className="text-rose-800">(no English stem)</span>}</p>
          <TeluguLine row={ix.questionText.get(q.id)} />
          {figures.map(f => urls[f.storage_path] && <img key={f.id} loading="lazy" src={urls[f.storage_path]} alt={`Figure for Q${q.source_question_number}`} className="my-2 max-h-56 rounded border bg-white" />)}
          <ol className="mt-2 grid gap-1 sm:grid-cols-2">{(ix.optionsByQuestion.get(q.id) || []).map(o => <li key={o.id} className="rounded bg-slate-50 px-2 py-1 text-sm">
            <span className="font-semibold">{o.marker})</span> {o.content || <span className="text-rose-800">(empty)</span>}
            {o.is_proposed_correct && <span className="ml-2 rounded bg-violet-50 px-1 text-[11px] font-semibold text-violet-800" title="From the answer key; not confirmed">proposed answer</span>}
            {o.is_confirmed_correct && <span className="ml-1 rounded bg-emerald-50 px-1 text-[11px] font-semibold text-emerald-800">confirmed</span>}
            <TeluguLine row={ix.optionText.get(o.id)} />
          </li>)}</ol>
        </article>
      </div>
    })}
  </div>
}
