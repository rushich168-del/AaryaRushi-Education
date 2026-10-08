import { useEffect, useRef, useState } from 'react'
import SourceRegion from './SourceRegion.jsx'
import {
  ITEM_TITLES, itemTitle, allowedActions, itemLabel, itemOption, itemQuestion, provenanceText, reasonText, teluguContent, teluguState, numberRange,
} from '../../../services/draftReviewModel.js'

const TE_CLASS = 'ksc-telugu'
export const cx = (...c) => c.filter(Boolean).join(' ')

export function ReadinessChip({ r, compact = false }) {
  if (!r) return null
  const optional = Number(r.open_advisory) || 0
  const [label, cls] = r.readiness === 'READY' ? ['No blocking issues', 'bg-emerald-50 text-emerald-800 ring-emerald-200']
    : r.readiness === 'QUICK_CHECK' ? ['Quick check', 'bg-amber-50 text-amber-900 ring-amber-200'] : ['Manual review', 'bg-rose-50 text-rose-800 ring-rose-200']
  return <span className="inline-flex flex-wrap items-center gap-1">
    <span className={cx('rounded px-1.5 py-0.5 text-xs font-semibold ring-1', cls)}>{label}{!compact && r.readiness !== 'READY' ? ` · ${r.open_blocking}` : ''}</span>
    {optional > 0 && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600 ring-1 ring-slate-200">{optional} optional</span>}
  </span>
}

function StateBadge({ row }) {
  const s = teluguState(row)
  const cls = { verified: 'bg-emerald-50 text-emerald-800', corrected: 'bg-emerald-50 text-emerald-800', typed: 'bg-emerald-50 text-emerald-800',
    'missing-teacher': 'bg-slate-100 text-slate-700', neutral: 'bg-slate-100 text-slate-700', 'ocr-high': 'bg-sky-50 text-sky-800', ocr: 'bg-amber-50 text-amber-900' }[s.key] || 'bg-rose-50 text-rose-800'
  return <span className={cx('rounded px-1.5 py-0.5 text-xs font-semibold', cls)} data-state={s.key}>{s.label}</span>
}

function Kbd({ children }) { return <kbd className="rounded border border-slate-300 bg-slate-50 px-1 font-mono text-[11px] text-slate-600">{children}</kbd> }

function Crop({ url, alt }) {
  return url ? <img src={url} alt={alt} className="max-h-72 w-full rounded border border-slate-200 bg-white object-contain" />
    : <div className="flex min-h-16 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">No source crop</div>
}

function Reasons({ item }) {
  const reasons = item.machine_reasons || []
  return <ul className="list-disc space-y-0.5 pl-5 text-sm text-slate-700">{reasons.map(r => <li key={r}>{reasonText(r)}</li>)}</ul>
}

function Header({ ix, item, onOpenQuestion }) {
  const q = itemQuestion(ix, item)
  const r = q ? ix.readinessByQuestion.get(q.id) : null
  return <div className="flex flex-wrap items-start justify-between gap-2">
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{itemLabel(ix, item)}{item.status === 'DEFERRED' ? ' · deferred' : ''}</p>
      <h3 className="text-lg font-bold text-slate-900">{itemTitle(item)}</h3>
    </div>
    {q && <div className="flex items-center gap-2"><ReadinessChip r={r} />{onOpenQuestion && <button type="button" onClick={() => onOpenQuestion(q.id)} className="text-xs font-semibold text-blue-700">View in full Draft</button>}</div>}
  </div>
}

function Resolution({ item }) {
  if (item.status !== 'RESOLVED') return null
  const words = { ACCEPTED_OCR: 'OCR accepted and verified', EDITED_OCR: 'Corrected and verified', TRANSCRIBED: 'Typed by teacher', MARKED_MISSING: 'Marked missing',
    RESOLVED: 'Marked fixed', ACCEPTED_AS_IS: 'Accepted as is', RECONCILED: 'Closed automatically after the Draft was fixed' }
  return <p className="rounded bg-emerald-50 p-2 text-sm text-emerald-900" role="status">
    Resolved: {words[item.resolution] || item.resolution}{item.resolution_note ? ` — “${item.resolution_note}”` : ''}{item.resolved_at ? ` · ${new Date(item.resolved_at).toLocaleString()}` : ''}
    {(item.detail?.revisions || []).length ? ` · revised ${item.detail.revisions.length}×` : ''}
  </p>
}

// ---- Telugu quick check ------------------------------------------------------------------------
export function TeluguPanel({ ix, item, urls, busy, decide, editing, setEditing, confirmMissing, setConfirmMissing, onOpenQuestion }) {
  const c = teluguContent(ix, item)
  const acts = allowedActions(ix, item)
  const q = itemQuestion(ix, item), o = itemOption(ix, item)
  const [text, setText] = useState(c.current)
  const area = useRef(null)
  useEffect(() => { setText(c.current) }, [item.id, editing]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (editing) area.current?.focus() }, [editing])
  const english = o ? `${o.marker}) ${o.content ?? ''}` : q?.content
  const prov = provenanceText(c.provenance)
  const save = () => decide('edit', { text })
  // B4.8.4B: the suggestion goes through the same teacher edit/history path as a typed correction.
  const acceptSuggestion = () => decide('edit', { text: c.suggestion, note: `Accepted suggestion from ${c.decoder?.name || 'legacy decoder'}@${c.decoder?.version || '?'} after comparing with the source` })
  return <div className="space-y-4">
    <Header ix={ix} item={item} onOpenQuestion={onOpenQuestion} />
    <div className="grid gap-4 lg:grid-cols-3">
      <section aria-label="Source crop" className="space-y-1">
        <h4 className="text-xs font-semibold uppercase text-slate-500">Source (as printed)</h4>
        <Crop url={c.crop ? urls[c.crop.storage_path] : null} alt={`Source crop for ${itemLabel(ix, item)}`} />
        {english && <p className="text-xs text-slate-600"><span className="font-semibold">English:</span> {english}</p>}
      </section>
      <section aria-label="Current Telugu text" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase text-slate-500">Current Telugu text</h4>
        {editing
          ? <div className="space-y-2">
              <textarea ref={area} value={text} onChange={e => setText(e.target.value)} rows={4} lang="te" aria-label="Corrected Telugu text"
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() } if (e.key === 'Escape') { e.preventDefault(); setEditing(false) } }}
                className={cx(TE_CLASS, 'w-full rounded border border-blue-300 p-2 text-lg focus:outline-none focus:ring-2 focus:ring-blue-400')} />
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy || !text.trim()} onClick={save} className="rounded bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">Save correction &amp; verify <Kbd>Ctrl+Enter</Kbd></button>
                <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300">Cancel <Kbd>Esc</Kbd></button>
              </div>
            </div>
          : <div className={cx(TE_CLASS, 'min-h-16 rounded border border-slate-200 bg-slate-50 p-2 text-lg')} lang="te" data-testid="current-telugu">
              {c.current || <span className="font-sans text-sm text-slate-500">No Telugu text</span>}
            </div>}
        <div className="flex flex-wrap gap-1"><StateBadge row={c.row} />{!c.stored && c.attempt && <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900">OCR attempt — not stored (below threshold)</span>}</div>
        {c.original && c.original !== c.current && <p className="text-xs text-slate-600"><span className="font-semibold">Original OCR (kept):</span> <span lang="te" className={TE_CLASS}>{c.original}</span></p>}
        {c.suggestion && !editing && <div className="space-y-1" data-testid="suggested-telugu-block">
          <h4 className="text-xs font-semibold uppercase text-slate-500">Suggested Telugu (read from the PDF’s glyphs)</h4>
          <div className={cx(TE_CLASS, 'min-h-12 rounded border border-violet-200 bg-violet-50 p-2 text-lg')} lang="te" data-testid="suggested-telugu">{c.suggestion}</div>
          <p className="text-xs text-slate-600">A suggestion only — it differs from the OCR. Compare both with the source; nothing changes unless you accept it.</p>
        </div>}
      </section>
      <section aria-label="Reason and confidence" className="space-y-2">
        <h4 className="text-xs font-semibold uppercase text-slate-500">Why it is here</h4>
        <Reasons item={item} />
        <p className="text-sm text-slate-700">Confidence: <span className="font-semibold">{c.provenance.confidence != null ? c.provenance.confidence.toFixed(2) : '—'}</span>{c.provenance.verdict ? ` (${c.provenance.verdict})` : ''}</p>
        {prov && <p className="text-xs text-slate-500">Read by {prov}</p>}
        {c.rawOcr && <details className="text-xs text-slate-600"><summary>OCR before the number/punctuation layer</summary><span lang="te" className={TE_CLASS}>{c.rawOcr}</span></details>}
        <p className="text-xs text-slate-500">Accepting Telugu never confirms an answer.</p>
      </section>
    </div>
    <Resolution item={item} />
    {!editing && <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Decision">
      {acts.accept && <button type="button" disabled={busy} onClick={() => decide('accept')} className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
        {c.suggestion ? (c.stored ? 'Accept current OCR & verify' : 'Accept OCR attempt & verify') : c.stored ? 'Accept & verify' : 'Accept OCR attempt & verify'} <Kbd>Enter</Kbd></button>}
      {c.suggestion && item.status !== 'RESOLVED' && <button type="button" disabled={busy} onClick={acceptSuggestion} data-testid="accept-suggestion" className="rounded bg-violet-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
        Accept suggestion &amp; verify</button>}
      <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
        {item.status === 'RESOLVED' ? 'Revise text' : c.suggestion ? 'Edit manually + verify' : 'Edit + verify'} <Kbd>E</Kbd></button>
      {confirmMissing
        ? <span className="flex flex-wrap items-center gap-2 rounded bg-rose-50 px-2 py-1 text-sm text-rose-900">Mark this Telugu as missing? The OCR history is kept.
            <button type="button" disabled={busy} onClick={() => decide('missing')} className="rounded bg-rose-700 px-2 py-1 text-xs font-semibold text-white">Mark missing <Kbd>Enter</Kbd></button>
            <button type="button" onClick={() => setConfirmMissing(false)} className="text-xs font-semibold">Cancel <Kbd>Esc</Kbd></button></span>
        : <button type="button" disabled={busy} onClick={() => setConfirmMissing(true)} className="rounded px-3 py-1.5 text-sm font-semibold text-rose-800 ring-1 ring-rose-300">Mark missing <Kbd>M</Kbd></button>}
      {acts.defer && <button type="button" disabled={busy} onClick={() => decide('defer')} className="rounded px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300">Defer <Kbd>D</Kbd></button>}
    </div>}
  </div>
}

// ---- manual review -----------------------------------------------------------------------------
function OptionsTable({ ix, q, highlightOptionId }) {
  const opts = ix.optionsByQuestion.get(q.id) || []
  if (!opts.length) return <p className="text-sm text-rose-800">No options were extracted.</p>
  return <table className="w-full text-sm"><tbody>{opts.map(o => {
    const te = ix.optionText.get(o.id)
    return <tr key={o.id} className={cx('border-t border-slate-100', o.id === highlightOptionId && 'bg-amber-50')}>
      <td className="w-8 py-1 pr-2 align-top font-semibold">{o.marker})</td>
      <td className="py-1 align-top">{o.content ? o.content : <span className="font-semibold text-rose-800">(empty — no text extracted)</span>}
        {te && te.text_quality !== 'SCRIPT_NEUTRAL' && (te.content ? <div lang="te" className={cx(TE_CLASS, 'text-slate-600')}>{te.content}</div> : null)}</td>
      <td className="w-40 py-1 text-right align-top">
        {o.is_proposed_correct && <span className="rounded bg-violet-50 px-1.5 py-0.5 text-xs font-semibold text-violet-800 ring-1 ring-violet-200" title="From the paper's answer key; not confirmed">Proposed answer</span>}
        {o.is_confirmed_correct && <span className="ml-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-800">Confirmed by teacher</span>}
      </td></tr>
  })}</tbody></table>
}

// A stored crop's normalized region (top-left origin) -> PDF points (y up) on its page.
export function mediaBox(m) {
  if (!m || m.region_x == null || !m.page_width_pt) return null
  const W = Number(m.page_width_pt), H = Number(m.page_height_pt)
  const x0 = Number(m.region_x) * W, x1 = x0 + Number(m.region_w) * W
  const y1 = H - Number(m.region_y) * H, y0 = y1 - Number(m.region_h) * H
  return { page: m.source_page, box: { x0, x1, y0, y1 } }
}

function sourceBoxFor(q, item) {
  if (item.source_region?.pt) return { page: item.source_region.page, box: item.source_region.pt }
  const page = item.source_page || q?.source_page
  const boxes = (q?.source_bbox || []).filter(b => b.page === page)
  if (!boxes.length) return { page, box: null }
  const box = { x0: Math.min(...boxes.map(b => b.x0)), x1: Math.max(...boxes.map(b => b.x1)), y0: Math.min(...boxes.map(b => b.y0)), y1: Math.max(...boxes.map(b => b.y1)) }
  return { page, box }
}

export function ManualPanel({ ix, item, urls, busy, decide, pdfPath, onOpenQuestion }) {
  const acts = allowedActions(ix, item)
  const q = itemQuestion(ix, item), o = itemOption(ix, item)
  const [note, setNote] = useState('')
  const [optionText, setOptionText] = useState('')
  const [stemText, setStemText] = useState('')
  useEffect(() => { setNote(''); setOptionText(''); setStemText('') }, [item.id])
  const figures = q ? (ix.mediaByQuestion.get(q.id) || []).filter(m => m.media_kind !== 'TEXT_REGION') : []
  const src = sourceBoxFor(q, item)
  const teStem = q ? ix.questionText.get(q.id) : null
  const material = q?.shared_material_id ? ix.materialById.get(q.shared_material_id) : null
  const verify = acts.kind === 'verify'
  return <div className="space-y-4">
    <Header ix={ix} item={item} onOpenQuestion={onOpenQuestion} />
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-3" aria-label="Draft content">
        <div><h4 className="text-xs font-semibold uppercase text-slate-500">Why it is here</h4><Reasons item={item} /></div>
        {item.item_type === 'UNASSIGNED_TEXT' && item.extracted_value && <div className="rounded bg-amber-50 p-2 text-sm"><span className="font-semibold">Unowned text:</span> {item.extracted_value}</div>}
        {q && <div className="space-y-2 rounded border border-slate-200 p-3">
          <p className="text-sm"><span className="font-semibold">Q{q.source_question_number}.</span> {q.content || <span className="text-rose-800">(no English stem)</span>}</p>
          {teStem?.content && <p lang="te" className={cx(TE_CLASS, 'text-slate-700')}>{teStem.content}</p>}
          {material && <p className="text-xs text-slate-600">Uses shared material {ix.materialLabel.get(material.id)}: {material.heading?.slice(0, 90)}</p>}
          <OptionsTable ix={ix} q={q} highlightOptionId={o?.id} />
          {item.item_type === 'ANSWER_KEY' && <p className="rounded bg-violet-50 p-2 text-xs text-violet-900">Proposed answers come from the paper's answer key and stay proposed.
            Nothing here confirms an answer. Fix the options (or the question) first; then mark this item fixed.</p>}
        </div>}
        {figures.map(f => <figure key={f.id} className="space-y-1"><Crop url={urls[f.storage_path]} alt={`Figure for Q${q?.source_question_number}`} />
          <figcaption className="text-xs text-slate-500">Automatic figure crop · page {f.source_page}{f.detection_confidence != null ? ` · detector confidence ${Number(f.detection_confidence).toFixed(2)}` : ''}</figcaption></figure>)}
      </section>
      <section aria-label="Source context"><h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Source context</h4>
        {verify && mediaBox(ix.mediaById.get(item.source_media_id))
          ? <SourceRegion storagePath={pdfPath} page={mediaBox(ix.mediaById.get(item.source_media_id)).page} box={mediaBox(ix.mediaById.get(item.source_media_id)).box} pad={40} label="Printed page around the automatic crop — compare edges and labels" />
          : <SourceRegion storagePath={pdfPath} page={src.page} box={src.box} label={`Printed source · page ${src.page}${src.box ? '' : ' (whole page)'}`} />}
      </section>
    </div>
    <Resolution item={item} />
    {(acts.resolve || acts.defer) && <div className="space-y-3 rounded border border-slate-200 bg-slate-50 p-3" role="group" aria-label="Decision">
      {acts.typeOption && <label className="block text-sm"><span className="font-semibold">Type option {o?.marker} exactly as printed in the source</span>
        <div className="mt-1 flex flex-wrap gap-2"><input value={optionText} onChange={e => setOptionText(e.target.value)} aria-label={`Option ${o?.marker} text`} className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1" />
          <button type="button" disabled={busy || !optionText.trim()} onClick={() => decide('saveOption', { optionId: o.id, text: optionText.trim() })} className="rounded bg-blue-700 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50">Save option text</button></div>
        <span className="text-xs text-slate-500">Saved as teacher-entered text on this option. Its answer flags are not changed.</span></label>}
      {acts.typeTeluguStem && <label className="block text-sm"><span className="font-semibold">Type the Telugu stem from the source</span>
        <div className="mt-1 flex flex-wrap gap-2"><textarea value={stemText} onChange={e => setStemText(e.target.value)} lang="te" rows={2} aria-label="Telugu stem" className={cx(TE_CLASS, 'min-w-0 flex-1 rounded border border-slate-300 px-2 py-1')} />
          <button type="button" disabled={busy || !stemText.trim()} onClick={() => decide('typeStem', { text: stemText.trim() })} className="rounded bg-blue-700 px-3 py-1 text-sm font-semibold text-white disabled:opacity-50">Save Telugu stem</button></div></label>}
      <div className="flex flex-wrap items-center gap-2">
        {acts.resolve && <button type="button" disabled={busy} onClick={() => decide('resolve', { note: verify ? 'Checked against the source' : null })} className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {verify ? 'Figure matches the source' : 'Mark fixed'}</button>}
        {acts.defer && <button type="button" disabled={busy} onClick={() => decide('defer')} className="rounded px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300">Defer <Kbd>D</Kbd></button>}
      </div>
      {!verify && (acts.acceptAsIs
        ? <div className="flex flex-wrap items-center gap-2"><input value={note} onChange={e => setNote(e.target.value)} placeholder="Why this is acceptable as it is (required)" aria-label="Accept-as-is note" className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm" />
            <button type="button" disabled={busy || !note.trim()} onClick={() => decide('acceptAsIs', { note: note.trim() })} className="rounded px-3 py-1.5 text-sm font-semibold text-slate-800 ring-1 ring-slate-400 disabled:opacity-50">Accept as is</button></div>
        : <p className="text-xs text-slate-600">This problem cannot be accepted as it is; it closes only when the Draft no longer has the defect.</p>)}
    </div>}
  </div>
}

// ---- shared material (shown once, with every dependent question) ---------------------------------
export function MaterialPanel({ ix, item, urls, busy, decide, editing, setEditing, confirmMissing, setConfirmMissing }) {
  const m = ix.materialById.get(item.draft_material_id)
  const qs = ix.questionsByMaterial.get(item.draft_material_id) || []
  const media = ix.mediaByMaterial.get(item.draft_material_id) || []
  const teCrops = media.filter(x => x.media_kind === 'TEXT_REGION'), figures = media.filter(x => x.media_kind !== 'TEXT_REGION')
  const mt = ix.materialText.get(item.draft_material_id)
  const acts = allowedActions(ix, item)
  const [text, setText] = useState('')
  const area = useRef(null)
  useEffect(() => { setText(mt?.content || '') }, [item.id, editing]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (editing) area.current?.focus() }, [editing])
  const isTelugu = item.item_type === 'MATERIAL_TELUGU'
  const shown = isTelugu ? teCrops : item.source_media_id ? media.filter(x => x.id === item.source_media_id) : figures
  return <div className="space-y-4">
    <Header ix={ix} item={item} />
    <div className="rounded border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
      <p className="font-semibold">Shared by {qs.length} question{qs.length === 1 ? '' : 's'} — {numberRange(qs)}. Resolve it once; every linked question updates.</p>
      <div className="mt-2 flex flex-wrap gap-2" data-testid="material-dependents">{qs.map(q => <span key={q.id} className="inline-flex items-center gap-1 rounded bg-white px-2 py-0.5 ring-1 ring-indigo-200">
        <span className="font-semibold">Q{q.source_question_number}</span><ReadinessChip r={ix.readinessByQuestion.get(q.id)} compact /></span>)}</div>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-2" aria-label="Material content">
        <h4 className="text-xs font-semibold uppercase text-slate-500">{m?.material_type?.toLowerCase().replace(/_/g, ' ') || 'Material'} · page {m?.source_page_start}{m?.source_page_end && m.source_page_end !== m.source_page_start ? `–${m.source_page_end}` : ''}</h4>
        <p className="whitespace-pre-wrap text-sm text-slate-800">{m?.content_text || m?.heading}</p>
        <div><h4 className="text-xs font-semibold uppercase text-slate-500">Why it is here</h4><Reasons item={item} /></div>
        {isTelugu && <div className="space-y-1"><h4 className="text-xs font-semibold uppercase text-slate-500">Telugu version</h4>
          {editing
            ? <><textarea ref={area} value={text} onChange={e => setText(e.target.value)} rows={5} lang="te" aria-label="Material Telugu text"
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); decide('edit', { text }) } if (e.key === 'Escape') { e.preventDefault(); setEditing(false) } }}
                className={cx(TE_CLASS, 'w-full rounded border border-blue-300 p-2 text-lg')} />
              <div className="flex gap-2"><button type="button" disabled={busy || !text.trim()} onClick={() => decide('edit', { text })} className="rounded bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">Save for all {qs.length} questions <Kbd>Ctrl+Enter</Kbd></button>
                <button type="button" onClick={() => setEditing(false)} className="rounded px-3 py-1.5 text-sm font-semibold ring-1 ring-slate-300">Cancel <Kbd>Esc</Kbd></button></div></>
            : <div lang="te" className={cx(TE_CLASS, 'rounded border border-slate-200 bg-slate-50 p-2')}>{mt?.content || <span className="font-sans text-sm text-slate-500">{mt ? 'Marked missing by teacher' : 'Not transcribed (the source is an image of Telugu text)'}</span>}</div>}
        </div>}
      </section>
      <section className="space-y-2" aria-label="Source crops">{shown.map(x => <figure key={x.id}><Crop url={urls[x.storage_path]} alt={`Shared material source crop, page ${x.source_page}`} />
        <figcaption className="text-xs text-slate-500">{x.media_kind === 'TEXT_REGION' ? 'Telugu source' : 'Figure'} · page {x.source_page}</figcaption></figure>)}</section>
    </div>
    <Resolution item={item} />
    {!editing && (acts.edit || acts.resolve || acts.defer) && <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Decision">
      {isTelugu && acts.edit && <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white">Type Telugu + verify <Kbd>E</Kbd></button>}
      {isTelugu && acts.markMissing && (confirmMissing
        ? <span className="flex items-center gap-2 rounded bg-rose-50 px-2 py-1 text-sm text-rose-900">Mark missing for all {qs.length} questions?
            <button type="button" onClick={() => decide('missing')} className="rounded bg-rose-700 px-2 py-1 text-xs font-semibold text-white">Mark missing <Kbd>Enter</Kbd></button>
            <button type="button" onClick={() => setConfirmMissing(false)} className="text-xs font-semibold">Cancel</button></span>
        : <button type="button" disabled={busy} onClick={() => setConfirmMissing(true)} className="rounded px-3 py-1.5 text-sm font-semibold text-rose-800 ring-1 ring-rose-300">Mark missing <Kbd>M</Kbd></button>)}
      {!isTelugu && acts.resolve && <button type="button" disabled={busy} onClick={() => decide('resolve', { note: 'Checked against the source' })} className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white">
        {item.item_type === 'MATERIAL_VISUAL_VERIFY' ? 'Figure matches the source' : 'Mark fixed'}</button>}
      {acts.defer && <button type="button" disabled={busy} onClick={() => decide('defer')} className="rounded px-3 py-1.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-300">Defer <Kbd>D</Kbd></button>}
    </div>}
  </div>
}
