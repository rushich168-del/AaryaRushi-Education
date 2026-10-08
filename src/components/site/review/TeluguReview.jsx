import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react'
import { ReadinessChip, MaterialPanel, cx } from './ReviewPanels.jsx'
import { teluguState, reasonText } from '../../../services/draftReviewModel.js'
import { draftReviewService } from '../../../services/draftReviewService.js'
import { activeUnitOf, buildTeluguReview, laneCounts, laneQuestions, nextQuestionAfter, wordDiff } from '../../../services/teluguReviewModel.js'

// B4.8.4C — question-level Telugu Review. The teacher decides whole questions: every Telugu unit of the
// question (stem + options) with its source crops, the English for reference, suggestions and the PDF's own
// digit evidence. Every decision is ONE server call: a single unit through the 0027/0028 review RPCs, or (0033) a
// question's confidence-only checks together, one printed text for all its identical places, or a passage's OCR
// proposal. The server re-checks eligibility and the text the teacher saw; nothing is batched in the browser.

const TE = 'ksc-telugu'
const LANES = [
  ['quick', 'Quick Telugu Check'], ['exception', 'Telugu Exceptions'], ['passages', 'Shared passages'],
  ['repeated', 'Repeated printed text'], ['optional', 'Optional checks'],
]
const LANE_HELP = {
  quick: 'Only confidence needs a teacher here. Read the whole question against the source: Enter = Looks correct for every unit, then the next question.',
  exception: 'Each unit below has a specific problem. Choose what the source shows; nothing changes unless you choose it.',
  optional: 'Nothing blocks these questions. Verifying them is optional and records teacher evidence.',
}
const NOTE = {
  keep: 'Looks correct (Telugu Review)',
  keepOverSuggestion: s => `Kept the current OCR; did not use the suggestion from ${s}`,
  suggestion: s => `Accepted suggestion from ${s} after comparing with the source`,
  digits: d => `Used the digits printed in the PDF (${d.name}@${d.version}): ${(d.before || []).join(' ')} -> ${(d.after || []).join(' ')}`,
  digitsThenEdit: d => `Started from the digits printed in the PDF (${d.name}@${d.version}), then edited`,
}

function Kbd({ children }) { return <kbd className="rounded border border-slate-300 bg-slate-50 px-1 font-mono text-[11px] text-slate-600">{children}</kbd> }

function Btn({ tone = 'plain', children, ...p }) {
  const tones = { green: 'bg-emerald-700 text-white', blue: 'bg-blue-700 text-white', violet: 'bg-violet-700 text-white', amber: 'bg-amber-600 text-white',
    plain: 'bg-white text-slate-800 ring-1 ring-slate-300', rose: 'bg-white text-rose-800 ring-1 ring-rose-300' }
  return <button type="button" {...p} className={cx('inline-flex min-h-11 items-center gap-1.5 rounded px-3 py-2 text-sm font-semibold disabled:opacity-50 sm:min-h-0 sm:py-1.5', tones[tone])}>{children}</button>
}

// Digits highlighted so the teacher sees exactly what "Use printed digits" would change.
function DigitText({ text, mark }) {
  return <span>{String(text).split(/(\d+)/).map((p, i) => /^\d+$/.test(p) ? <mark key={i} className={cx('rounded px-0.5', mark)}>{p}</mark> : <span key={i}>{p}</span>)}</span>
}

// The words that differ between two readings, marked (the rest is identical).
function DiffText({ parts, mark }) {
  return <span>{parts.map((p, i) => p.same ? <span key={i}>{p.t}</span> : <mark key={i} className={cx('rounded px-0.5', mark)}>{p.t}</mark>)}</span>
}

function StatusChip({ u }) {
  if (u.open) {
    const [label, cls] = u.item.status === 'DEFERRED' ? ['Deferred', 'bg-slate-100 text-slate-700']
      : !u.blocking ? ['Optional check', 'bg-sky-50 text-sky-800'] : u.lane === 'exception' ? ['Needs a decision', 'bg-rose-50 text-rose-800'] : ['Needs a check', 'bg-amber-50 text-amber-900']
    return <span className={cx('rounded px-1.5 py-0.5 text-xs font-semibold', cls)}>{label}</span>
  }
  return <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-800">{teluguState(u.content.row).label}</span>
}

function UnitCard({ u, active, urls, busy, editing, editText, setEditText, confirmMissing, onActivate, act, onJump, onGroup }) {
  const area = useRef(null)
  useEffect(() => { if (editing) area.current?.focus() }, [editing])
  const c = u.content
  const decoderName = c.decoder ? `${c.decoder.name}@${c.decoder.version}` : 'the legacy glyph decoder'
  const exception = u.lane === 'exception'
  const structure = u.kind === 'BLOCK'
  const diff = u.suggestion && c.current ? wordDiff(c.current, u.suggestion) : null
  return <article onClick={onActivate} aria-current={active ? 'true' : undefined} data-testid={`unit-${u.key}`} data-lane={u.lane}
    className={cx('rounded-lg border bg-white p-3', active ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200', !u.open && 'opacity-80')}>
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-bold text-slate-900">{u.label}</h4>
      <StatusChip u={u} />
    </div>
    <div className="grid gap-3 md:grid-cols-2">
      <section aria-label={`Source for ${u.label}`} className="min-w-0 space-y-1">
        {u.crops.length ? u.crops.map(m => urls[m.storage_path]
          ? <img key={m.id} src={urls[m.storage_path]} alt={`Printed ${u.label}, page ${m.source_page}`} className="h-auto max-h-60 max-w-full rounded border border-slate-200 bg-white object-contain" />
          : <div key={m.id} className="flex min-h-12 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-500">Loading source…</div>)
          : <div className="flex min-h-12 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-500">No source crop</div>}
        {u.crops.length > 1 && <p className="text-xs text-slate-500">{u.crops.length} source parts, in reading order</p>}
        {u.english && <p className="text-xs text-slate-600"><span className="font-semibold">English (reference only):</span> {u.option ? `${u.option.marker}) ` : ''}{u.english}</p>}
      </section>
      <section aria-label={`Telugu for ${u.label}`} className="min-w-0 space-y-2">
        <p className="text-xs font-semibold uppercase text-slate-500">{c.stored ? 'Current Telugu' : c.attempt ? 'OCR reading (not stored yet)' : 'Current Telugu'}</p>
        {editing
          ? <div className="space-y-2">
              <textarea ref={area} value={editText} onChange={e => setEditText(e.target.value)} rows={Math.min(8, Math.max(2, String(editText).split('\n').length + 1))} lang="te"
                aria-label={`Corrected Telugu for ${u.label}`} onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); act('save') }
                  if (e.key === 'Escape') { e.preventDefault(); act('cancel') }
                }} className={cx(TE, 'w-full rounded border border-blue-300 p-2 text-lg focus:outline-none focus:ring-2 focus:ring-blue-400')} />
              <div className="flex flex-wrap gap-2">
                <Btn tone="blue" disabled={busy || !editText.trim()} onClick={() => act('save')}>{structure ? 'Save Telugu stem' : 'Save & verify'} <Kbd>Ctrl+Enter</Kbd></Btn>
                <Btn disabled={busy} onClick={() => act('cancel')}>Cancel <Kbd>Esc</Kbd></Btn>
              </div>
            </div>
          : <div lang="te" data-testid="unit-current" className={cx(TE, 'min-h-12 whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 text-lg')}>
              {c.current ? (u.digitRepair ? <DigitText text={c.current} mark="bg-rose-100" /> : diff ? <DiffText parts={diff.left} mark="bg-rose-100" /> : c.current) : <span className="font-sans text-sm text-slate-500">No Telugu text was read</span>}
            </div>}
        {c.original && c.original !== c.current && <p className="text-xs text-slate-600"><span className="font-semibold">Original OCR (kept):</span> <span lang="te" className={TE}>{c.original}</span></p>}

        {exception && u.issues.length > 0 && <ul className="space-y-1 rounded bg-rose-50 p-2 text-sm text-rose-950" data-testid="unit-issues">
          {u.issues.map(i => <li key={i.code}><span className="font-semibold">{i.title}.</span>{i.detail ? ` ${i.detail}` : ''}</li>)}</ul>}

        {u.suggestion && !editing && <div className="space-y-1" data-testid="unit-suggestion">
          <p className="text-xs font-semibold uppercase text-slate-500">Suggested Telugu (read from the PDF’s glyphs)</p>
          <div lang="te" className={cx(TE, 'whitespace-pre-wrap rounded border border-violet-200 bg-violet-50 p-2 text-lg')}>{diff ? <DiffText parts={diff.right} mark="bg-violet-200" /> : u.suggestion}</div>
          <p className="text-xs text-slate-600">A suggestion only; it is sometimes wrong. Marked words are where the two readings differ — compare them with the printed source.</p>
        </div>}

        {u.digitRepair && !editing && <div className="space-y-1" data-testid="unit-digit-repair">
          <p className="text-xs font-semibold uppercase text-slate-500">Digits printed in the PDF</p>
          <p className="text-sm">OCR read <b>{(u.digitRepair.before || []).join(' ')}</b>; the PDF prints <b>{(u.digitRepair.after || []).join(' ')}</b>.</p>
          <div lang="te" className={cx(TE, 'whitespace-pre-wrap rounded border border-amber-200 bg-amber-50 p-2 text-lg')}><DigitText text={u.digitRepair.text} mark="bg-emerald-100" /></div>
          {!u.digitRepair.oneClick && <p className="text-xs text-slate-600">This unit has other problems too, so the printed digits open in the editor for you to finish.</p>}
        </div>}

        {u.repeat && <div className="rounded bg-indigo-50 p-2 text-xs text-indigo-950" data-testid="unit-repeat">
          <p><span className="font-semibold">Printed identically in {u.repeat.count} places:</span> {u.repeat.places.map((p, i) => <span key={i}>{i ? ', ' : ''}
            {p.questionId && p.questionId !== u.question?.id ? <button type="button" className="font-semibold text-indigo-800 underline" onClick={e => { e.stopPropagation(); onJump(p.questionId) }}>{p.label}</button> : <b>{p.label}</b>}</span>)}.</p>
          {u.repeat.differentReadings.length > 0 && <p className="mt-1">The OCR read the same print differently elsewhere: {u.repeat.differentReadings.map((r, i) => <span key={i} lang="te" className={cx(TE, 'mx-1 rounded bg-white px-1')}>{r || '—'}</span>)}</p>}
          {u.open && onGroup && <button type="button" className="mt-1 font-semibold text-indigo-800 underline" onClick={e => { e.stopPropagation(); onGroup(u.repeat.fp) }}>Decide this print once for all {u.repeat.count} places</button>}
        </div>}
      </section>
    </div>

    {u.open && !editing && <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label={`Decision for ${u.label}`}>
      {structure ? <>
          <Btn tone="blue" disabled={busy} onClick={() => act('edit')}>Type Telugu stem <Kbd>E</Kbd></Btn>
          <Btn tone="green" disabled={busy} onClick={() => act('fixed')}>Mark fixed <Kbd>F</Kbd></Btn>
        </> : <>
          {u.canKeep && (exception || u.suggestion
            ? <Btn tone="green" disabled={busy} onClick={() => act('keep')}>Keep current <Kbd>K</Kbd></Btn>
            : <Btn tone="green" disabled={busy} onClick={() => act('keep')}>Keep this unit <Kbd>K</Kbd></Btn>)}
          {u.suggestion && <Btn tone="violet" disabled={busy} onClick={() => act('suggestion')} data-testid="use-suggestion">Use suggestion <Kbd>S</Kbd></Btn>}
          {u.digitRepair && <Btn tone="amber" disabled={busy} onClick={() => act('digits')} data-testid="use-printed-digits">{u.digitRepair.oneClick ? 'Use printed digits' : 'Edit with printed digits'} <Kbd>P</Kbd></Btn>}
          <Btn tone="blue" disabled={busy} onClick={() => act('edit')}>Edit <Kbd>E</Kbd></Btn>
          {confirmMissing
            ? <span className="flex flex-wrap items-center gap-2 rounded bg-rose-50 px-2 py-1 text-sm text-rose-900">Mark missing? OCR history is kept.
                <Btn tone="rose" disabled={busy} onClick={() => act('missing')}>Mark missing <Kbd>Enter</Kbd></Btn>
                <Btn onClick={() => act('cancel')}>Cancel <Kbd>Esc</Kbd></Btn></span>
            : u.canMarkMissing && <Btn tone="rose" disabled={busy} onClick={() => act('askMissing')}>Missing <Kbd>M</Kbd></Btn>}
        </>}
      {u.canDefer && <Btn disabled={busy} onClick={() => act('defer')}>Defer <Kbd>D</Kbd></Btn>}
    </div>}
  </article>
}

// A shared passage's OCR proposal, checked once for every linked question (0033). OCR is never verification.
function PassageCheck({ p, ix, urls, busy, text, setText, onAccept, onSave, onDefer }) {
  const reasons = (p.item.machine_reasons || []).filter(r => !['TELUGU_MATERIAL_OCR_PROPOSAL', 'HIGH', 'MEDIUM', 'LOW'].includes(r))
  return <div className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shared passage · {p.range}</p>
        <h3 className="text-lg font-bold">Check the OCR reading once — every linked question uses it</h3></div>
      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900">OCR proposal · not verified</span>
    </div>
    <div className="grid gap-3 lg:grid-cols-2">
      <section aria-label="Printed passage" className="min-w-0 space-y-1">{p.crops.map(m => urls[m.storage_path]
        ? <img key={m.id} src={urls[m.storage_path]} alt={`Printed passage, page ${m.source_page}`} className="h-auto max-w-full rounded border border-slate-200 object-contain" />
        : <div key={m.id} className="flex min-h-12 items-center justify-center rounded border border-dashed border-slate-300 text-xs text-slate-500">Loading source…</div>)}
        <p className="text-xs text-slate-600"><span className="font-semibold">English (reference only):</span> {p.material?.content_text?.slice(0, 400) || p.material?.heading}</p></section>
      <section aria-label="OCR reading" className="min-w-0 space-y-2">
        {text != null
          ? <><textarea autoFocus value={text} onChange={e => setText(e.target.value)} rows={Math.min(14, text.split('\n').length + 2)} lang="te" aria-label="Corrected passage"
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSave() } if (e.key === 'Escape') { e.preventDefault(); setText(null) } }}
                className={cx(TE, 'w-full rounded border border-blue-300 p-2 text-lg')} />
              <div className="flex flex-wrap gap-2"><Btn tone="blue" disabled={busy || !text.trim()} onClick={onSave}>Save for all linked questions <Kbd>Ctrl+Enter</Kbd></Btn>
                <Btn disabled={busy} onClick={() => setText(null)}>Cancel <Kbd>Esc</Kbd></Btn></div></>
          : <div lang="te" data-testid="passage-proposal" className={cx(TE, 'whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 p-2 text-lg')}>{p.proposal}</div>}
        {reasons.length > 0 && <ul className="list-disc pl-5 text-sm text-rose-900">{reasons.map(r => <li key={r}>{reasonText(r)}</li>)}</ul>}
        <p className="text-xs text-slate-500">Read by OCR ({p.text?.ocr_verdict?.toLowerCase()} confidence). Saving keeps this OCR reading in the history beside your decision.</p>
      </section>
    </div>
    {text == null && <div className="flex flex-wrap gap-2" role="group" aria-label="Passage decision">
      <Btn tone="green" disabled={busy} onClick={onAccept} data-testid="accept-passage">Looks correct <Kbd>Enter</Kbd></Btn>
      <Btn tone="blue" disabled={busy} onClick={() => setText(p.proposal)}>Edit <Kbd>E</Kbd></Btn>
      {p.item.status === 'OPEN' && <Btn disabled={busy} onClick={onDefer}>Defer <Kbd>D</Kbd></Btn>}
    </div>}
  </div>
}

export default function TeluguReview({ ix, urls, busy, decideItem, decideBatch, draftPaperId, flash }) {
  const review = useMemo(() => buildTeluguReview(ix), [ix])
  const counts = useMemo(() => laneCounts(review), [review])
  const [lane, setLane] = useState(() => (counts.quick ? 'quick' : counts.exception ? 'exception' : counts.passages ? 'passages' : 'optional'))
  const list = useMemo(() => (['quick', 'exception', 'optional'].includes(lane) ? laneQuestions(review, lane) : []), [review, lane])
  const [qid, setQid] = useState(null)
  const [unitId, setUnitId] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')
  const [editNote, setEditNote] = useState(null)
  const [missingId, setMissingId] = useState(null)
  const [passageId, setPassageId] = useState(null)
  const [groupFp, setGroupFp] = useState(null)
  const [groupText, setGroupText] = useState(null)        // non-null while correcting a repeated print
  const [groupResult, setGroupResult] = useState({})      // fp -> last per-place outcomes
  const [pText, setPText] = useState(null)                // non-null while editing a passage proposal
  const [pEditing, setPEditing] = useState(false)
  const [pMissing, setPMissing] = useState(false)
  const prevList = useRef(list)
  const advance = useRef(null)   // { from, before }: the question just finished, and the lane as it was
  const rootRef = useRef(null)

  // Keep a valid current question/unit as the data changes (decisions, lane switches), and move on by
  // itself once the current question has nothing left to decide in this lane.
  useEffect(() => {
    if (!['quick', 'exception', 'optional'].includes(lane)) return
    if (advance.current) {
      const { from, before } = advance.current
      advance.current = null
      setQid(nextQuestionAfter(before, list, from) ?? list[0]?.id ?? null); setUnitId(null)
    } else if (!list.some(q => q.id === qid)) {
      setQid((qid ? nextQuestionAfter(prevList.current, list, qid) : null) ?? list[0]?.id ?? null)
    }
    prevList.current = list
  }, [list, qid, lane])
  // While the effect above catches up, show the question it will choose (no empty frame between questions).
  const current = list.find(q => q.id === qid) || (list.length ? list.find(q => q.id === nextQuestionAfter(prevList.current, list, qid)) || list[0] : null)
  const active = activeUnitOf(current, unitId)
  useEffect(() => { if (active && active.id !== unitId) setUnitId(active.id) }, [active, unitId])
  const passages = review.passages.filter(p => p.open)
  const passage = review.passages.find(p => p.id === passageId) || passages[0] || null
  const groups = review.sourceDecisions
  const group = groups.find(g => g.fp === groupFp) || groups[0] || null

  const position = current ? list.findIndex(q => q.id === current.id) : -1
  // Keyboard review continues after a mouse click (a focused button would swallow Enter).
  const blurInside = () => { if (typeof document !== 'undefined' && document.activeElement && rootRef.current?.contains(document.activeElement)) document.activeElement.blur?.() }
  const goQuestion = delta => { blurInside(); if (!list.length) return; const i = Math.min(list.length - 1, Math.max(0, position + delta)); setQid(list[i].id); setUnitId(null); cancel() }
  const cancel = () => { setEditingId(null); setMissingId(null); setEditNote(null) }
  const jump = questionId => {
    const q = review.questions.find(x => x.id === questionId)
    if (!q) return
    setLane(q.lane); setQid(q.id); setUnitId(null); cancel()
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'start' }))
  }

  // One atomic "Looks correct" for every confidence/agreement-only unit of the question (0033).
  async function verifyQuestion() {
    blurInside()
    if (!current?.verifyUnits.length) return
    const before = list, q = current
    const res = await decideBatch(() => draftReviewService.verifyQuestionTelugu(q.id, q.verifyUnits.map(u => ({ item_id: u.id, expected: u.content.current })), null),
      { questionIds: [q.id], label: `Saved: Q${q.number} — ${q.verifyUnits.length} unit${q.verifyUnits.length === 1 ? '' : 's'} verified in one decision.` })
    if (!res) return
    cancel()
    const rest = q.openUnits.filter(x => !q.verifyUnits.includes(x) && x.item.status === 'OPEN' && (lane === 'optional' || x.blocking))
    if (rest.length) setUnitId(rest[0].id)
    else { advance.current = { from: q.id, before }; setUnitId(null) }
  }

  // After a saved decision: the next open unit of this question, else the next question of the lane.
  async function run(u, action, payload) {
    const before = list
    const ok = await decideItem(u.item, action, payload)
    if (!ok) return
    cancel()
    // Still to do in this question: its OPEN blocking units (in the optional lane, its open optional ones).
    const idx = current ? current.openUnits.findIndex(x => x.id === u.id) : -1
    const rest = current ? current.openUnits.slice(idx + 1).concat(current.openUnits.slice(0, Math.max(0, idx)))
      .filter(x => x.id !== u.id && x.item.status === 'OPEN' && (lane === 'optional' || x.blocking)) : []
    if (rest.length) setUnitId(rest[0].id)
    else { advance.current = { from: current?.id, before }; setUnitId(null) }
  }

  function act(u, what) {
    blurInside()
    const dec = u.content.decoder ? `${u.content.decoder.name}@${u.content.decoder.version}` : 'the legacy glyph decoder'
    if (what === 'cancel') return cancel()
    if (what === 'keep') return run(u, 'accept', { note: u.suggestion ? NOTE.keepOverSuggestion(dec) : NOTE.keep })
    if (what === 'suggestion' && u.suggestion) return run(u, 'edit', { text: u.suggestion, note: NOTE.suggestion(dec) })
    if (what === 'digits' && u.digitRepair) {
      if (u.digitRepair.oneClick) return run(u, 'edit', { text: u.digitRepair.text, note: NOTE.digits(u.digitRepair) })
      setUnitId(u.id); setEditingId(u.id); setEditText(u.digitRepair.text); setEditNote(NOTE.digitsThenEdit(u.digitRepair)); return
    }
    if (what === 'edit') { setUnitId(u.id); setEditingId(u.id); setEditText(u.content.current || ''); setEditNote(null); return }
    if (what === 'save') {
      if (!editText.trim()) return
      if (u.kind === 'BLOCK') return decideItem(u.item, 'typeStem', { text: editText.trim() }).then(ok => ok && cancel())
      return run(u, 'edit', { text: editText.trim(), note: editNote })
    }
    if (what === 'askMissing') { setUnitId(u.id); setMissingId(u.id); return }
    if (what === 'missing') return run(u, 'missing', {})
    if (what === 'defer') return run(u, 'defer', {})
    if (what === 'fixed') return run(u, 'resolve', { note: 'Telugu stem checked against the source (Telugu Review)' })
  }

  // ---- repeated printed text (0033): one decision for every place of the same frozen print ----
  const mostCommon = g => { const c = {}; for (const p of g.open) c[p.reading] = (c[p.reading] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' }
  async function decideGroup(g, mode, text) {
    blurInside()
    if (!text?.trim()) return
    const res = await decideBatch(() => draftReviewService.applySourceDecision(draftPaperId, g.fp, mode, text.trim(), g.open.map(p => ({ item_id: p.item.id, expected: p.reading })), null),
      { questionIds: [...new Set(g.open.map(p => p.question?.id).filter(Boolean))],
        label: mode === 'VERIFY_SOURCE_AS_CORRECT' ? `Verified once for ${g.open.length} places.` : `Saved once for ${g.open.length} places (the OCR readings are kept in history).` })
    if (!res) return
    setGroupResult(r => ({ ...r, [g.fp]: res.occurrences }))
    setGroupText(null)
    if (!res.conflicts) { const next = groups.find(x => x.fp !== g.fp); setGroupFp(next?.fp ?? null) }
  }

  // ---- shared passages (0033): accept or edit the OCR proposal once ----
  const nextPassage = () => { const next = passages.find(p => p.id !== passage?.id); setPassageId(next?.id ?? null); setPText(null); setPEditing(false); setPMissing(false) }
  async function acceptPassage() {
    blurInside()
    if (!passage?.proposal) return
    const res = await decideBatch(() => draftReviewService.resolvePassage(passage.item.id, 'ACCEPT', passage.proposal, null, null),
      { questionIds: passage.questions.map(q => q.id), materialIds: [passage.material.id], label: `Passage verified once for ${passage.range}.` })
    if (res) nextPassage()
  }
  async function savePassage() {
    if (!passage?.proposal || !pText?.trim()) return
    const res = await decideBatch(() => draftReviewService.resolvePassage(passage.item.id, 'EDIT', passage.proposal, pText, null),
      { questionIds: passage.questions.map(q => q.id), materialIds: [passage.material.id], label: `Passage corrected once for ${passage.range} (the OCR reading is kept).` })
    if (res) nextPassage()
  }
  useEffect(() => {
    function onKey(e) {
      if (busy || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (e.target.closest?.('button, a') && (e.key === 'Enter' || e.key === ' ')) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (lane === 'passages' && passage?.open && passage.proposal && pText == null) {
        if (k === 'Enter') { e.preventDefault(); acceptPassage() }
        else if (k === 'e') { e.preventDefault(); setPText(passage.proposal) }
        else if (k === 'd' && passage.item.status === 'OPEN') { e.preventDefault(); decideItem(passage.item, 'defer', {}).then(ok => ok && nextPassage()) }
      }
      if (lane === 'repeated' && group && groupText == null) {
        const i = groups.findIndex(x => x.fp === group.fp)
        if (k === 'Enter' && group.readings.length === 1) { e.preventDefault(); decideGroup(group, 'VERIFY_SOURCE_AS_CORRECT', group.readings[0]) }
        else if (k === 'e') { e.preventDefault(); setGroupText(mostCommon(group)) }
        else if ((k === 'ArrowDown' || k === 'j') && groups[i + 1]) { e.preventDefault(); setGroupFp(groups[i + 1].fp) }
        else if (k === 'ArrowUp' && i > 0) { e.preventDefault(); setGroupFp(groups[i - 1].fp) }
      }
    }
    if (!['passages', 'repeated'].includes(lane)) return undefined
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Keyboard-first: Enter = Looks correct for the question's confidence-only units, then next · K keep this unit · S suggestion ·
  // P printed digits · E edit · M missing · D defer · F mark fixed (structure) · ↓/↑ unit · → / ← question.
  useEffect(() => {
    function onKey(e) {
      if (busy || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (e.target.closest?.('button, a') && (e.key === 'Enter' || e.key === ' ')) return   // the focused control's own action
      if (!current || !active) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); goQuestion(e.key === 'ArrowRight' ? 1 : -1) }
        return
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const u = active
      if (missingId === u.id) {
        if (k === 'Enter') { e.preventDefault(); act(u, 'missing') } else if (k === 'Escape') { e.preventDefault(); cancel() }
        return
      }
      if (k === 'Enter') { if (current.verifyUnits.some(x => x.id === u.id)) { e.preventDefault(); verifyQuestion() } }
      else if (k === 'l' && current.verifyUnits.length) { e.preventDefault(); verifyQuestion() }   // the rest of this question, from any unit
      else if (k === 'k' && u.canKeep) { e.preventDefault(); act(u, 'keep') }
      else if (k === 's' && u.suggestion) { e.preventDefault(); act(u, 'suggestion') }
      else if (k === 'p' && u.digitRepair) { e.preventDefault(); act(u, 'digits') }
      else if (k === 'e' && u.open) { e.preventDefault(); act(u, 'edit') }
      else if (k === 'm' && u.canMarkMissing) { e.preventDefault(); act(u, 'askMissing') }
      else if (k === 'd' && u.canDefer) { e.preventDefault(); act(u, 'defer') }
      else if (k === 'f' && u.kind === 'BLOCK' && u.open) { e.preventDefault(); act(u, 'fixed') }
      else if (k === 'ArrowDown' || k === 'j') {
        e.preventDefault(); const us = current.openUnits; const i = us.findIndex(x => x.id === u.id); if (us[i + 1]) { setUnitId(us[i + 1].id); cancel() }
      } else if (k === 'ArrowUp') {
        e.preventDefault(); const us = current.openUnits; const i = us.findIndex(x => x.id === u.id); if (i > 0) { setUnitId(us[i - 1].id); cancel() }
      } else if (k === 'ArrowRight' || k === 'n') { e.preventDefault(); goQuestion(1) }
      else if (k === 'ArrowLeft') { e.preventDefault(); goQuestion(-1) }
    }
    if (!['quick', 'exception', 'optional'].includes(lane)) return undefined
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Keep the active unit in view without the teacher scrolling back to a list.
  useEffect(() => { if (unitId) document.querySelector(`[data-unit-id="${unitId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [unitId])

  const tabCount = { quick: counts.quick, exception: counts.exception, passages: counts.passages, repeated: counts.repeated, optional: counts.optional }
  const optionContext = current ? (ix.optionsByQuestion.get(current.id) || []).filter(o => !current.units.some(u => u.option?.id === o.id)) : []

  return <div ref={rootRef} className="space-y-4" data-testid="telugu-review">
    <nav aria-label="Telugu review lanes" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
      {LANES.map(([k, label]) => <button key={k} type="button" aria-pressed={lane === k} onClick={() => { blurInside(); setLane(k); setQid(null); setUnitId(null); cancel() }}
        className={cx('shrink-0 rounded-full px-3 py-1 text-sm font-semibold ring-1', lane === k ? 'bg-blue-700 text-white ring-blue-700' : 'bg-white text-slate-800 ring-slate-300')}>
        {label} <span className="opacity-80">{tabCount[k]}</span></button>)}
    </nav>

    {flash && <p role={flash.kind === 'error' ? 'alert' : 'status'} className={cx('rounded p-2 text-sm', flash.kind === 'error' ? 'bg-rose-50 text-rose-900' : 'bg-emerald-50 text-emerald-900')}>{flash.text}</p>}

    {['quick', 'exception', 'optional'].includes(lane) && (!current
      ? <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-4 text-slate-700"><CheckCircle2 size={18} className="text-emerald-700" aria-hidden="true" />No questions left in this lane.</p>
      : <section aria-label={`Question ${current.number}`} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{LANES.find(l => l[0] === lane)[1]} · {position + 1} of {list.length}</p>
              <h3 className="text-lg font-bold">Q{current.number}</h3>
              <p className="text-xs text-slate-600">{LANE_HELP[lane]}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {current.verifyUnits.length > 0 && <Btn tone="green" disabled={busy} onClick={verifyQuestion} data-testid="verify-question">
                {lane === 'exception' ? 'Rest looks correct' : 'Looks correct'} · {current.verifyUnits.length} unit{current.verifyUnits.length === 1 ? '' : 's'} <Kbd>{lane === 'exception' ? 'L' : 'Enter'}</Kbd></Btn>}
              <ReadinessChip r={ix.readinessByQuestion.get(current.id)} />
              <Btn onClick={() => goQuestion(-1)} disabled={position <= 0} aria-label="Previous question"><ChevronLeft size={16} aria-hidden="true" /><span className="sm:hidden">Previous</span></Btn>
              <Btn onClick={() => goQuestion(1)} disabled={position >= list.length - 1} aria-label="Next question"><span className="sm:hidden">Next</span><ChevronRight size={16} aria-hidden="true" /></Btn>
            </div>
          </div>
          {(current.otherBlocking > 0 || current.materialOpen) && <p className="rounded bg-amber-50 p-2 text-sm text-amber-950">
            {current.otherBlocking > 0 && <>This question also has {current.otherBlocking} non-Telugu issue{current.otherBlocking === 1 ? '' : 's'} in the Exception queue. </>}
            {current.materialOpen && <>Its shared passage still needs its Telugu (see Shared passages).</>}</p>}
          <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <p><span className="font-semibold">English question (reference):</span> {current.question.content || '—'}</p>
            {optionContext.length > 0 && <ul className="mt-1 flex flex-wrap gap-x-4 text-xs text-slate-600">{optionContext.map(o => {
              const t = ix.optionText.get(o.id)
              return <li key={o.id}>{o.marker}) {o.content}{t?.text_quality === 'SCRIPT_NEUTRAL' ? ' · same in Telugu' : t?.content ? <> · <span lang="te" className={TE}>{t.content}</span></> : ''}</li>
            })}</ul>}
          </div>
          <div className="space-y-3">{current.units.map(u => <div key={u.id} data-unit-id={u.id}>
            <UnitCard u={u} active={active?.id === u.id} urls={urls} busy={busy} editing={editingId === u.id} editText={editText} setEditText={setEditText}
              confirmMissing={missingId === u.id} onActivate={() => { if (u.open && active?.id !== u.id) { setUnitId(u.id); if (editingId !== u.id) cancel() } }}
              act={what => act(u, what)} onJump={jump} onGroup={fp => { blurInside(); setLane('repeated'); setGroupFp(fp); setGroupText(null) }} /></div>)}</div>
          <p className="hidden text-xs text-slate-500 sm:block">Keys: Enter looks correct (every confidence-only unit, one decision) · L the same from any unit · K keep this unit · S use suggestion · P printed digits · E edit (Ctrl+Enter save, Esc cancel) · M missing · D defer · ↓/↑ unit · → / ← question</p>
          <p className="text-xs text-slate-500">“Looks correct” verifies only units whose sole remaining question is OCR confidence; a unit with a specific problem is always decided on its own. Answers are never confirmed here.</p>
        </section>)}

    {lane === 'passages' && <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside aria-label="Shared passages" className="rounded-lg border border-slate-200 bg-white">
        <ol>{review.passages.map((p, i) => <li key={p.id}><button type="button" onClick={() => { blurInside(); setPassageId(p.id); setPEditing(false); setPMissing(false); setPText(null) }} aria-current={passage?.id === p.id ? 'true' : undefined}
          className={cx('block min-h-11 w-full border-b border-slate-100 px-3 py-2 text-left text-sm', passage?.id === p.id ? 'bg-blue-50' : 'hover:bg-slate-50')}>
          <span className="block font-semibold">Passage {i + 1} · {p.range}</span>
          <span className="block text-xs text-slate-600">{p.open ? `${p.item.status === 'DEFERRED' ? 'Deferred · ' : ''}${p.proposal ? 'OCR reading to check' : 'to type'} · ${p.crops.length} source part${p.crops.length === 1 ? '' : 's'}` : teluguState(p.text).label}</span></button></li>)}</ol>
      </aside>
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4" data-testid="passage-panel">
        {!passage ? <p className="text-slate-600">No shared passages need Telugu.</p>
          : passage.proposal && passage.open ? <PassageCheck p={passage} ix={ix} urls={urls} busy={busy} text={pText} setText={setPText} onAccept={acceptPassage} onSave={savePassage}
              onDefer={() => decideItem(passage.item, 'defer', {}).then(ok => ok && nextPassage())} />
          : <MaterialPanel key={passage.id} ix={ix} item={passage.item} urls={urls} busy={busy} editing={pEditing} setEditing={setPEditing} confirmMissing={pMissing} setConfirmMissing={setPMissing}
              decide={(action, payload) => decideItem(passage.item, action, payload).then(ok => { if (ok) { setPEditing(false); setPMissing(false); nextPassage() } })} />}
      </section>
    </div>}

    {lane === 'repeated' && <section className="space-y-3" aria-label="Repeated printed text">
      <p className="rounded bg-indigo-50 p-2 text-sm text-indigo-950">Each card is one Telugu text printed <b>identically</b> (same glyphs, same digits) in several places, so every place must read the same.
        Decide it once: <b>Looks correct</b> when every place reads the same and matches the source, or <b>Correct once</b> to save the right text in every place. A place that changed since you looked is never overwritten; it is listed for you.</p>
      {!groups.length && <p className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-4 text-slate-700"><CheckCircle2 size={18} className="text-emerald-700" aria-hidden="true" />No repeated printed text left to decide.</p>}
      {groups.map(g => {
        const active = group?.fp === g.fp
        const result = groupResult[g.fp]
        return <article key={g.fp} onClick={() => { if (!active) { setGroupFp(g.fp); setGroupText(null) } }} data-testid="repeated-group" aria-current={active ? 'true' : undefined}
          className={cx('grid gap-3 rounded-lg border bg-white p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]', active ? 'border-blue-500 ring-2 ring-blue-200' : 'border-slate-200')}>
          <div className="min-w-0">{g.crop && urls[g.crop.storage_path] ? <img src={urls[g.crop.storage_path]} alt="The printed text (identical in every place listed)" className="h-auto max-h-40 max-w-full rounded border border-slate-200 object-contain" /> : null}
            <p className="mt-1 text-xs text-slate-600">Printed identically in {g.places.length} places · {g.open.length} still open{g.readings.length > 1 ? ` · the OCR read it ${g.readings.length} different ways` : ''}
              {g.blockingOpen === 0 && <span className="ml-1 rounded bg-sky-50 px-1.5 text-sky-800">optional checks only</span>}</p></div>
          <div className="min-w-0 space-y-2">
            <ul className="space-y-1 text-sm">{g.places.map(p => {
              const r = result?.find(x => x.item_id === p.item?.id)
              return <li key={p.key} className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={e => { e.stopPropagation(); if (p.question) jump(p.question.id) }} className="font-semibold text-blue-700 underline">{p.label}</button>
                <button type="button" disabled={!active || !p.reading} onClick={e => { e.stopPropagation(); setGroupText(p.reading) }} title="Start the correction from this reading"
                  lang="te" className={cx(TE, 'rounded bg-slate-50 px-1 text-left', active && 'hover:bg-indigo-50')}>{p.reading || '—'}</button>
                {p.decided && <span className="rounded bg-emerald-50 px-1.5 text-xs text-emerald-800">decided</span>}
                {r && ['CONFLICT', 'REFUSED'].includes(r.outcome) && <span className="rounded bg-rose-50 px-1.5 text-xs font-semibold text-rose-800">not changed: {r.reason === 'STALE_VIEW' ? 'changed since you looked' : r.reason === 'ALREADY_DECIDED' ? 'already decided differently' : r.reason === 'READING_DIFFERS' ? 'reads differently — use Correct once' : 'refused'}</span>}
              </li>
            })}</ul>
            {active && (groupText != null
              ? <div className="space-y-2">
                  <textarea autoFocus value={groupText} onChange={e => setGroupText(e.target.value)} rows={2} lang="te" aria-label="Correct Telugu for every place"
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); decideGroup(g, 'CORRECT_SOURCE_TEXT', groupText) } if (e.key === 'Escape') { e.preventDefault(); setGroupText(null) } }}
                    className={cx(TE, 'w-full rounded border border-blue-300 p-2 text-lg')} />
                  <div className="flex flex-wrap gap-2"><Btn tone="blue" disabled={busy || !groupText.trim()} onClick={() => decideGroup(g, 'CORRECT_SOURCE_TEXT', groupText)}>Save for all {g.open.length} places <Kbd>Ctrl+Enter</Kbd></Btn>
                    <Btn disabled={busy} onClick={() => setGroupText(null)}>Cancel <Kbd>Esc</Kbd></Btn></div>
                  <p className="text-xs text-slate-600">Tip: click one of the readings above to start from it.</p>
                </div>
              : <div className="flex flex-wrap gap-2">
                  {g.readings.length === 1 && <Btn tone="green" disabled={busy} onClick={() => decideGroup(g, 'VERIFY_SOURCE_AS_CORRECT', g.readings[0])} data-testid="verify-group">Looks correct in all {g.open.length} <Kbd>Enter</Kbd></Btn>}
                  <Btn tone="blue" disabled={busy} onClick={() => setGroupText(mostCommon(g))} data-testid="correct-group">Correct once for all {g.open.length} <Kbd>E</Kbd></Btn>
                </div>)}
          </div>
        </article>
      })}
    </section>}
  </div>
}
