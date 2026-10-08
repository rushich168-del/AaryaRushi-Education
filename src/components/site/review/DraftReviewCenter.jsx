import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react'
import { draftReviewService } from '../../../services/draftReviewService.js'
import { paperPreparationService, stageLabel } from '../../../services/paperPreparationService.js'
import {
  FILTERS, TELUGU_ROW_TYPES, TELUGU_RPC_TYPES, allowedActions, buildQueue, filterCounts, indexDraft, isOpen, itemLabel, itemQuestion,
  itemTextRow, nextAfter, reviewErrorMessage, summarize, ITEM_TITLES,
} from '../../../services/draftReviewModel.js'
import { ManualPanel, MaterialPanel, TeluguPanel, cx } from './ReviewPanels.jsx'
import FullDraftView from './FullDraftView.jsx'
import MathRecoveryQueue from './MathRecoveryQueue.jsx'
import TeluguReview from './TeluguReview.jsx'
import { buildTeluguReview, laneCounts } from '../../../services/teluguReviewModel.js'
import { groupMathImages } from '../../../../scripts/lib/math-image-recovery.mjs'

// B4.6 — Teacher Preparation & Exception Review Center.
// Prepared Paper -> Review Exceptions -> Draft Ready. The default experience is the exception
// queue; the full paper is a secondary inspection mode. All counts are derived from persisted
// review state; every decision is one of the 0027/0028 review RPCs.

const READINESS_WORDS = { READY: 'no blocking issues', QUICK_CHECK: 'quick check', MANUAL_REVIEW: 'manual review' }

function Stat({ label, value, tone = 'slate', testid }) {
  const tones = { slate: 'text-slate-900', emerald: 'text-emerald-800', amber: 'text-amber-800', rose: 'text-rose-800', sky: 'text-sky-800' }
  return <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid={testid}>
    <p className="text-xs font-semibold text-slate-500">{label}</p><p className={cx('text-2xl font-bold', tones[tone])}>{value}</p></div>
}
function Bar({ label, done, total, muted = false, testid }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return <div className="space-y-1" data-testid={testid}>
    <div className="flex justify-between text-sm"><span className={muted ? 'text-slate-500' : 'font-semibold'}>{label}: {done} / {total}</span><span className="text-slate-500">{pct}%</span></div>
    <div className="h-2 rounded bg-slate-200" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <div className={cx('h-2 rounded', muted ? 'bg-slate-400' : 'bg-emerald-600')} style={{ width: `${pct}%` }} /></div></div>
}

export default function DraftReviewCenter({ draftPaperId }) {
  const [base, setBase] = useState(null)
  const [data, setData] = useState(null)
  const [urls, setUrls] = useState({})
  const [loadError, setLoadError] = useState(null)
  const [filter, setFilter] = useState('blocking')
  const [selectedId, setSelectedId] = useState(null)
  const [mode, setMode] = useState('queue')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)
  const [editing, setEditing] = useState(false)
  const [confirmMissing, setConfirmMissing] = useState(false)
  const [focusQuestionId, setFocusQuestionId] = useState(null)
  const [prep, setPrep] = useState(null)   // B4.7 persisted preparation status of this paper's import
  const panelRef = useRef(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const b = await draftReviewService.loadPaper(draftPaperId)
      if (!b) { setLoadError('This Draft paper was not found, or it belongs to another teacher.'); return }
      // Items made obsolete by earlier edits are closed first (never blocks loading).
      const reconciled = await draftReviewService.reconcile(draftPaperId).catch(() => null)
      const d = await draftReviewService.loadDraft(draftPaperId)
      setBase(b); setData(d)
      if (reconciled > 0) setFlash({ kind: 'ok', text: `${reconciled} review ${reconciled === 1 ? 'item was' : 'items were'} closed automatically: earlier edits to the Draft already fixed ${reconciled === 1 ? 'it' : 'them'}.` })
      if (b.paper.source_import_id) paperPreparationService.getStatus(b.paper.source_import_id).then(setPrep).catch(() => setPrep({ state: 'UNKNOWN' }))
      draftReviewService.signedUrls(d.media.map(m => m.storage_path)).then(setUrls).catch(() => setFlash({ kind: 'error', text: 'Source crops could not be loaded. Reload to try again.' }))
    } catch {
      setLoadError('The Draft could not be loaded. Check your connection and try again.')
    }
  }, [draftPaperId])
  useEffect(() => { load() }, [load])

  const ix = useMemo(() => (data ? indexDraft({ ...data, paper: base?.paper }) : null), [data, base])
  const queue = useMemo(() => (ix ? buildQueue(ix, filter) : []), [ix, filter])
  const counts = useMemo(() => (ix ? filterCounts(ix) : {}), [ix])
  const summary = useMemo(() => (ix ? summarize(ix) : null), [ix])
  // B4.8.3C: distinct maths bitmaps recorded by preparation (the Math Recovery tab appears only if any).
  const mathImages = useMemo(() => (data ? groupMathImages(data.questions).filter(g => g.fp).length : 0), [data])
  // B4.8.4C: questions with blocking Telugu work + shared passages still to verify.
  const teluguWork = useMemo(() => { if (!ix) return 0; const c = laneCounts(buildTeluguReview(ix)); return c.quick + c.exception + c.passages }, [ix])
  const selected = ix && selectedId ? ix.items.find(i => i.id === selectedId) : null
  useEffect(() => { if (ix && (!selectedId || !ix.items.some(i => i.id === selectedId))) setSelectedId(queue[0]?.id ?? null) }, [ix, queue, selectedId])
  useEffect(() => { setEditing(false); setConfirmMissing(false) }, [selectedId])

  const pick = id => { setSelectedId(id); setFlash(null); requestAnimationFrame(() => panelRef.current?.focus()) }
  const chooseFilter = key => {
    setFilter(key); const q = ix ? buildQueue(ix, key) : []; setSelectedId(q[0]?.id ?? null); setFlash(null)
    requestAnimationFrame(() => panelRef.current?.focus())   // keyboard review continues without an extra click
  }
  const step = delta => {
    if (!queue.length) return
    const at = queue.findIndex(i => i.id === selectedId)
    pick(queue[Math.min(queue.length - 1, Math.max(0, (at < 0 ? -1 : at) + delta))].id)
  }

  const affectedQuestions = item => item.draft_material_id ? (ix.questionsByMaterial.get(item.draft_material_id) || []) : [itemQuestion(ix, item)].filter(Boolean)

  // One decision on one item, through the 0027/0028 review RPCs only (shared by the exception queue and the
  // B4.8.4C Telugu Review). Returns false for edits that are not themselves a review decision.
  async function perform(item, action, payload = {}) {
    if (action === 'accept') { await draftReviewService.teluguDecision(item.id, 'ACCEPT', { note: payload.note ?? null }); return true }
    if (action === 'edit' || action === 'missing') {
      if (TELUGU_ROW_TYPES.has(item.item_type)) {
        const t = itemTextRow(ix, item)
        await draftReviewService.reviseText(t.row.id, t.owner, action === 'edit' ? 'REPLACE' : 'CLEAR', { text: action === 'edit' ? payload.text : null, note: payload.note ?? null })
      } else await draftReviewService.teluguDecision(item.id, action === 'edit' ? 'EDIT' : 'MARK_MISSING', { text: action === 'edit' ? payload.text : null, note: payload.note ?? null })
      return true
    }
    if (action === 'defer') {
      if (TELUGU_RPC_TYPES.has(item.item_type)) await draftReviewService.teluguDecision(item.id, 'DEFER')
      else await draftReviewService.resolveItem(item.id, 'DEFER')
      return true
    }
    if (action === 'resolve') { await draftReviewService.resolveItem(item.id, 'RESOLVED', payload.note ?? null); return true }
    if (action === 'acceptAsIs') { await draftReviewService.resolveItem(item.id, 'ACCEPTED_AS_IS', payload.note); return true }
    if (action === 'saveOption') { await draftReviewService.updateOptionText(payload.optionId, payload.text); return false }
    if (action === 'typeStem') { await draftReviewService.reviseText(item.target_question_text_id, 'QUESTION', 'REPLACE', { text: payload.text }); return false }
    throw new Error(`Unknown action ${action}`)
  }

  // Re-read only what a decision on `item` can change: review state + the affected rows.
  async function refreshAfter(item, { withOptions = false } = {}) {
    return refreshFor(affectedQuestions(item).map(q => q.id), item.draft_material_id ? [item.draft_material_id] : [], { withOptions })
  }
  async function refreshFor(qIds, mIds, { withOptions = false } = {}) {
    const oIds = data.options.filter(o => qIds.includes(o.draft_question_id)).map(o => o.id)
    const [review, texts, freshOptions] = await Promise.all([
      draftReviewService.loadReviewState(draftPaperId),
      draftReviewService.loadTexts({ questionIds: qIds, optionIds: oIds, materialIds: mIds }),
      withOptions ? draftReviewService.loadOptions(qIds) : Promise.resolve(null),
    ])
    const merge = (rows, fresh, key, ids) => [...rows.filter(r => !ids.includes(r[key])), ...fresh]
    const next = { ...data, ...review,
      questionTexts: merge(data.questionTexts, texts.questionTexts, 'draft_question_id', qIds),
      optionTexts: merge(data.optionTexts, texts.optionTexts, 'draft_option_id', oIds),
      materialTexts: merge(data.materialTexts, texts.materialTexts, 'draft_material_id', mIds),
      options: freshOptions ? merge(data.options, freshOptions, 'draft_question_id', qIds) : data.options }
    setData(next)
    return { review, nix: indexDraft({ ...next, paper: base?.paper }) }
  }

  // B4.8.4C Telugu Review: one decision on an explicit item (the page moves on itself). True when saved.
  async function decideItem(item, action, payload = {}) {
    if (!item || busy) return false
    const before = new Map(affectedQuestions(item).map(q => [q.id, ix.readinessByQuestion.get(q.id)?.readiness]))
    setBusy(true); setFlash(null)
    try {
      await perform(item, action, payload)
      const { nix } = await refreshAfter(item)
      const changed = affectedQuestions(item).map(q => [q, before.get(q.id), nix.readinessByQuestion.get(q.id)?.readiness]).filter(([, a, b]) => a !== b)
      setFlash({ kind: 'ok', text: `Saved: ${itemLabel(ix, item)}.${changed.length ? ` Now: ${changed.map(([q, , b]) => `Q${q.source_question_number} ${READINESS_WORDS[b]}`).join(', ')}.` : ''}` })
      return true
    } catch (e) {
      setFlash({ kind: 'error', text: reviewErrorMessage(e) })
      if (/ALREADY_RESOLVED/.test(String(e?.message))) draftReviewService.loadReviewState(draftPaperId).then(r => setData(d => ({ ...d, ...r }))).catch(() => {})
      return false
    } finally { setBusy(false) }
  }

  // B4.8.4C (0033): one batch decision (question "Looks correct", one printed text for all its places, a passage).
  // run() makes ONE RPC call; the page then re-reads the affected questions/passages. Resolves the RPC result or null.
  async function decideBatch(run, { questionIds = [], materialIds = [], label = 'Saved.' } = {}) {
    if (busy) return null
    setBusy(true); setFlash(null)
    try {
      const res = await run()
      await refreshFor(questionIds, materialIds)
      const conflicts = (res?.occurrences || []).filter(o => o.outcome === 'CONFLICT' || o.outcome === 'REFUSED').length
      setFlash(conflicts ? { kind: 'error', text: `${label} ${conflicts} place${conflicts === 1 ? ' was' : 's were'} NOT changed because ${conflicts === 1 ? 'it' : 'they'} changed or ${conflicts === 1 ? 'was' : 'were'} decided differently since you looked; ${conflicts === 1 ? 'it is' : 'they are'} listed below.` }
        : { kind: 'ok', text: res?.status === 'ALREADY_APPLIED' || res?.reused ? 'Already saved (nothing changed).' : label })
      return res
    } catch (e) {
      setFlash({ kind: 'error', text: reviewErrorMessage(e) })
      if (/STALE|ALREADY_RESOLVED/.test(String(e?.message))) await refreshFor(questionIds, materialIds).catch(() => {})
      return null
    } finally { setBusy(false) }
  }

  async function decide(action, payload = {}) {
    const item = selected
    if (!item || busy) return
    const prevQueue = queue
    const before = new Map(affectedQuestions(item).map(q => [q.id, ix.readinessByQuestion.get(q.id)?.readiness]))
    setBusy(true); setFlash(null)
    try {
      const decision = await perform(item, action, payload)
      const { review, nix } = await refreshAfter(item, { withOptions: action === 'saveOption' })
      const changed = affectedQuestions(item).map(q => [q, before.get(q.id), nix.readinessByQuestion.get(q.id)?.readiness]).filter(([, a, b]) => a !== b)
      const readinessText = changed.length ? ` Now: ${changed.map(([q, , b]) => `Q${q.source_question_number} ${READINESS_WORDS[b]}`).join(', ')}.` : ''
      // An edit can remove a defect; the database then closes those items itself (0031, RECONCILED).
      const wasOpen = new Set(data.items.filter(i => i.status !== 'RESOLVED').map(i => i.id))
      const autoClosed = review.items.filter(i => wasOpen.has(i.id) && i.resolution === 'RECONCILED')
      if (!decision && autoClosed.length) {
        setSelectedId(nextAfter(prevQueue, buildQueue(nix, filter), item.id))
        setFlash({ kind: 'ok', text: `Saved. The edit fixed ${autoClosed.length === 1 ? 'an issue' : `${autoClosed.length} issues`} on this question, so ${autoClosed.length === 1 ? 'it was' : 'they were'} closed automatically.${readinessText}` })
      } else if (decision) {
        setSelectedId(nextAfter(prevQueue, buildQueue(nix, filter), item.id))
        setFlash({ kind: 'ok', text: `Saved: ${itemLabel(ix, item)} — ${ITEM_TITLES[item.item_type] || ''}.${readinessText}` })
      } else setFlash({ kind: 'ok', text: action === 'saveOption' ? 'Option text saved. If the source is now fully represented, choose “Mark fixed”.' : 'Telugu stem saved (OCR history kept). Choose “Mark fixed” when the question is complete.' })
    } catch (e) {
      setFlash({ kind: 'error', text: reviewErrorMessage(e) })
      if (/ALREADY_RESOLVED/.test(String(e?.message))) draftReviewService.loadReviewState(draftPaperId).then(r => setData(d => ({ ...d, ...r }))).catch(() => {})
    } finally {
      setBusy(false); setEditing(false); setConfirmMissing(false)
      requestAnimationFrame(() => panelRef.current?.focus())
    }
  }

  // Keyboard: Enter accept (Telugu OCR only, where safe) · E edit · M mark missing · D defer · → / J next · ← / K previous.
  useEffect(() => {
    function onKey(e) {
      const canReview = prep?.state === 'PREPARED' || (prep?.state === 'UPLOADED' && ix?.items.length > 0)
      if (!canReview || mode !== 'queue' || !selected || busy || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target.closest?.('input, textarea, select, button, a, [contenteditable="true"]')) return
      const acts = allowedActions(ix, selected)
      if (confirmMissing) {
        if (e.key === 'Enter') { e.preventDefault(); decide('missing') } else if (e.key === 'Escape') { e.preventDefault(); setConfirmMissing(false) }
        return
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (k === 'Enter') { if (acts.accept) { e.preventDefault(); decide('accept') } }
      else if (k === 'e' && acts.edit) { e.preventDefault(); setEditing(true) }
      else if (k === 'm' && acts.markMissing) { e.preventDefault(); setConfirmMissing(true) }
      else if (k === 'd' && acts.defer) { e.preventDefault(); decide('defer') }
      else if (k === 'ArrowRight' || k === 'j') { e.preventDefault(); step(1) }
      else if (k === 'ArrowLeft' || k === 'k') { e.preventDefault(); step(-1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const reviewQuestion = qid => {
    const open = ix.items.filter(i => isOpen(i) && (i.draft_question_id === qid || ix.optionById.get(i.draft_option_id)?.draft_question_id === qid))
    const target = open.find(i => i.blocking) || open[0]
    if (!target) return
    setFilter(target.blocking ? 'blocking' : 'optional'); setSelectedId(target.id); setMode('queue'); setFlash(null)
  }

  if (loadError) return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6"><div className="max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-6">
    <h1 className="text-xl font-bold">Review Center unavailable</h1><p role="alert">{loadError}</p>
    <button type="button" onClick={load} className="font-semibold text-blue-700">Try again</button></div></main>
  if (!ix || !summary) return <main className="flex min-h-screen items-center justify-center bg-slate-50"><p role="status" className="flex items-center gap-2 text-slate-600"><Loader2 className="animate-spin" size={18} aria-hidden="true" />Loading the prepared paper…</p></main>

  const acts = selected ? allowedActions(ix, selected) : null
  const panelProps = { ix, item: selected, urls, busy, decide, editing, setEditing, confirmMissing, setConfirmMissing, pdfPath: base?.importRecord?.storage_path,
    onOpenQuestion: qid => { setFocusQuestionId(qid); setMode('full') } }
  // A Draft is only "prepared" when its latest automatic preparation completed (0029); after a failed
  // or interrupted run the Draft may be partial, and "no open items" must never read as Draft Ready.
  const prepared = prep?.state === 'PREPARED'
  const draftReady = prepared && summary.draftReady
  // Readiness figures and the exception queue exist only for a prepared paper (a failed run has no or
  // stale review items, so "0 blocking" would look clean). A pre-B4.7 Draft keeps its existing queue.
  const reviewable = prepared || (prep?.state === 'UPLOADED' && ix.items.length > 0)
  const view = reviewable ? mode : 'full'
  const stepState = [['Prepared Paper', prepared], ['Review Exceptions', prepared && !draftReady], ['Draft Ready', draftReady]]

  return <main className="min-h-screen bg-slate-50 pb-16 font-sans text-slate-900">
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-5 sm:px-6">
      <header className="space-y-3">
        <a href={base.paper.source_import_id ? `/dashboard/admin/questions?import=${base.paper.source_import_id}` : '/dashboard/admin/questions'} className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700"><ArrowLeft size={16} aria-hidden="true" />Back to the import</a>
        {prep && !prepared && <div role="alert" data-testid="not-prepared" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          {prep.state === 'FAILED' || prep.state === 'INTERRUPTED'
            ? <>Automatic preparation of this paper did not complete ({prep.state === 'INTERRUPTED' ? 'interrupted' : 'failed'}{prep.failure_stage ? ` at “${stageLabel(prep.failure_stage)}”` : ''}). This Draft may be incomplete and is <b>not</b> prepared; return to the import to prepare it again.</>
            : prep.state === 'RUNNING' ? <>Automatic preparation of this paper is still running. Review becomes available when it completes.</>
            : <>This Draft was not produced by automatic preparation, so its review list may be empty or incomplete. Prepare the paper from its import first.</>}
        </div>}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Teacher Preparation &amp; Exception Review</p>
            <h1 className="text-2xl font-bold">{base.paper.title}</h1>
            <p className="text-sm text-slate-600">{base.importRecord?.original_filename || base.paper.source_filename || ''}</p></div>
          <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Preparation steps">{stepState.map(([label, active], i) =>
            <li key={label} className="flex items-center gap-2">{i > 0 && <span aria-hidden="true" className="text-slate-400">→</span>}
              <span className={cx('rounded-full px-3 py-1 font-semibold', i === 0 && active ? 'bg-slate-200 text-slate-700' : active ? 'bg-blue-700 text-white' : 'bg-white text-slate-500 ring-1 ring-slate-300')}
                aria-current={active && i > 0 ? 'step' : undefined}>{label}</span></li>)}</ol>
        </div>
      </header>

      {!prep && <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="animate-spin" size={16} aria-hidden="true" />Checking the preparation status…</p>}
      {reviewable && <>
      <section aria-label="Summary" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Total questions" value={summary.totalQuestions} testid="stat-total" />
        <Stat label="No blocking issues" value={summary.noBlocking} tone="emerald" testid="stat-ready" />
        <Stat label="Quick Check questions" value={summary.quickCheck} tone="amber" testid="stat-quick" />
        <Stat label="Manual Review questions" value={summary.manualReview} tone="rose" testid="stat-manual" />
        <Stat label="Unresolved blocking items" value={summary.blockingOpen} testid="stat-blocking-open" />
        <Stat label="Optional verification items" value={summary.optionalOpen} tone="sky" testid="stat-optional" />
      </section>
      <section aria-label="Progress" className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <Bar label="Blocking issues resolved" done={summary.blockingResolved} total={summary.blockingTotal} testid="progress-blocking" />
        <Bar label="Questions with no blocking issues" done={summary.noBlocking} total={summary.totalQuestions} testid="progress-questions" />
        <Bar label="Optional verification checked" done={summary.optionalResolved} total={summary.optionalTotal} muted testid="progress-optional" />
        <p className="text-xs text-slate-500">“No blocking issues” means nothing blocks the question; it does not mean the OCR was verified. {summary.readyWithOptionalOutstanding} of those questions still have optional checks.
          {summary.blockingDeferred ? ` ${summary.blockingDeferred} blocking item(s) are deferred and still block.` : ''}</p>
        {draftReady && <p className="flex items-center gap-2 rounded bg-emerald-50 p-2 text-sm font-semibold text-emerald-900" role="status"><CheckCircle2 size={16} aria-hidden="true" />
          Draft Ready: no blocking issues remain. Optional checks outstanding: {summary.optionalOpen}. Promotion to the Question Bank is a separate, later step.</p>}
      </section>
      </>}

      {prep && <div role="tablist" aria-label="View" className="-mx-4 flex gap-2 overflow-x-auto border-b border-slate-200 px-4 sm:mx-0 sm:px-0">
        {[...(reviewable ? [['queue', 'Exception queue'], ['telugu', `Telugu review (${teluguWork})`], ...(mathImages ? [['math', `Math images (${mathImages})`]] : [])] : []), ['full', 'View full Draft']].map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setMode(k)}
          className={cx('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold', view === k ? 'border-blue-700 text-blue-800' : 'border-transparent text-slate-600')}>{label}</button>)}
      </div>}

      {!prep ? null : view === 'full' ? <FullDraftView ix={ix} urls={urls} focusQuestionId={focusQuestionId} onReviewQuestion={reviewQuestion} reviewable={reviewable} />
        : view === 'telugu' ? <TeluguReview ix={ix} urls={urls} busy={busy} decideItem={decideItem} decideBatch={decideBatch} draftPaperId={draftPaperId} flash={flash} />
        : view === 'math' ? <MathRecoveryQueue draftPaperId={draftPaperId} pdfPath={base?.importRecord?.storage_path} questions={data.questions} options={data.options} onChanged={load} /> : <>
        <nav aria-label="Filters" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">{FILTERS.map(f =>
          <button key={f.key} type="button" onClick={() => chooseFilter(f.key)} aria-pressed={filter === f.key}
            className={cx('shrink-0 rounded-full px-3 py-1 text-sm font-semibold ring-1', filter === f.key ? 'bg-blue-700 text-white ring-blue-700' : f.key === 'optional' || f.key === 'resolved' ? 'bg-white text-slate-600 ring-slate-300' : 'bg-white text-slate-800 ring-slate-300')}>
            {f.label} <span className="opacity-80">{counts[f.key]}</span></button>)}</nav>

        {flash && <p role={flash.kind === 'error' ? 'alert' : 'status'} className={cx('rounded p-2 text-sm', flash.kind === 'error' ? 'bg-rose-50 text-rose-900' : 'bg-emerald-50 text-emerald-900')}>{flash.text}</p>}

        <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <section ref={panelRef} tabIndex={-1} aria-label="Review item" className="order-1 min-w-0 rounded-lg border border-slate-200 bg-white p-4 outline-none focus:ring-2 focus:ring-blue-200 lg:order-2">
            {!selected ? <p className="text-slate-600">{filter === 'resolved' ? 'Nothing resolved yet.' : 'No open items in this filter.'}</p>
              : acts.kind === 'telugu' ? <TeluguPanel key={selected.id} {...panelProps} />
              : selected.draft_material_id ? <MaterialPanel key={selected.id} {...panelProps} />
              : <ManualPanel key={selected.id} {...panelProps} />}
            {selected && <p className="mt-4 hidden text-xs text-slate-500 sm:block">Keys: Enter accept &amp; verify (Telugu OCR only) · E edit · M mark missing · D defer · → / J next · ← / K previous · Ctrl+Enter save · Esc cancel</p>}
            {selected && <div className="mt-4 flex justify-between gap-2 sm:hidden"><button type="button" onClick={() => step(-1)} className="rounded px-3 py-1.5 text-sm font-semibold ring-1 ring-slate-300">Previous</button>
              <span className="self-center text-xs text-slate-500">{queue.findIndex(i => i.id === selectedId) + 1} / {queue.length}</span>
              <button type="button" onClick={() => step(1)} className="rounded px-3 py-1.5 text-sm font-semibold ring-1 ring-slate-300">Next</button></div>}
          </section>
          <aside aria-label="Queue" className="order-2 lg:order-1">
            <details open className="rounded-lg border border-slate-200 bg-white">
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">{FILTERS.find(f => f.key === filter).label}: {queue.length} item{queue.length === 1 ? '' : 's'}</summary>
              <ol className="max-h-[32rem] overflow-y-auto border-t border-slate-100 lg:max-h-[70vh]">{queue.map(i => <li key={i.id}>
                <button type="button" onClick={() => pick(i.id)} aria-current={i.id === selectedId ? 'true' : undefined}
                  className={cx('block w-full border-b border-slate-100 px-3 py-2 text-left text-sm', i.id === selectedId ? 'bg-blue-50' : 'hover:bg-slate-50')}>
                  <span className="block font-semibold">{itemLabel(ix, i)}</span>
                  <span className="block text-xs text-slate-600">{ITEM_TITLES[i.item_type]}{i.status === 'DEFERRED' ? ' · deferred' : ''}{i.status === 'RESOLVED' ? ` · ${i.resolution?.toLowerCase().replace(/_/g, ' ')}` : ''}</span>
                </button></li>)}</ol>
            </details>
          </aside>
        </div>
      </>}
    </div>
  </main>
}
