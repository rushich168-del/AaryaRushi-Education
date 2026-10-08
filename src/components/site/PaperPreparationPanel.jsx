import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Circle, Loader2 } from 'lucide-react'
import { paperPreparationService, STAGES, stageLabel } from '../../services/paperPreparationService.js'

// B4.7 — Prepare Paper Automatically: Upload → Prepare → processing → Prepared Draft → Review.
// Everything shown here is derived from the persisted preparation state (0029); this tab's live
// progress only adds detail while this tab is the one running the pipeline.

const cx = (...c) => c.filter(Boolean).join(' ')

function stageText(key, d = {}) {
  if (!d || !Object.keys(d).length) return null
  switch (key) {
    case 'READING_PAPER': return d.pages ? `Page ${d.page} of ${d.pages}` : null
    case 'DETECTING_QUESTIONS': return d.questions != null ? `${d.questions} questions (${d.fourOptions} with four options) · ${d.sharedMaterials} shared materials · ${d.answerKeyEntries} answer-key entries` : null
    case 'DETECTING_FIGURES': return d.figuresAttached != null ? `${d.figuresAttached} figure crops attached · ${d.candidatesForReview} left for review · ${d.materialTeluguCrops} shared-material Telugu crops`
      : d.renderedPages ? `Page ${d.renderedPages} of ${d.pages} checked` : null
    case 'READING_TELUGU': return d.units != null ? `${d.units} Telugu stems/options read (${d.questionsWithTelugu} questions)`
      : d.pagesTotal ? `Page ${d.pagesDone} of ${d.pagesTotal} · ${d.runsDone} of ${d.runsTotal} Telugu lines` : null
    case 'SAVING_DRAFT': return d.questionVisuals != null ? `${d.questions} questions · ${d.options} options · ${d.materials} shared materials · ${d.uploads} source crops saved`
      : d.totalUploads ? `${d.uploads} of ${d.totalUploads} source crops saved` : null
    case 'PREPARING_REVIEW': return d.reviewItems != null ? `${d.reviewItems} review items generated` : null
    default: return null
  }
}

// The alert title already names the stage; the stored message starts with it too.
const withoutStagePrefix = (msg, stage) => (msg && stage && msg.startsWith(`${stageLabel(stage)}: `) ? msg.slice(stageLabel(stage).length + 2) : msg)

function Stat({ label, value, tone = 'text-slate-900', testid }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-3" data-testid={testid}><p className="text-xs font-semibold text-slate-500">{label}</p><p className={cx('text-xl font-bold', tone)}>{value ?? '—'}</p></div>
}

export default function PaperPreparationPanel({ importRecord, onOpenDraftEditor }) {
  const [status, setStatus] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [live, setLive] = useState(null)          // this tab's run: { stage, detail, t0 }
  const [error, setError] = useState(null)
  const [now, setNow] = useState(Date.now())
  const running = useRef(false)

  const refresh = useCallback(async () => {
    try { setStatus(await paperPreparationService.getStatus(importRecord.id)); setLoadError(null) }
    catch { setLoadError('The preparation status could not be loaded. Check the connection and retry.') }
  }, [importRecord.id])
  useEffect(() => { refresh() }, [refresh])

  // Another tab/session is running: follow the persisted state (it turns INTERRUPTED if that run stops).
  useEffect(() => {
    if (live || status?.state !== 'RUNNING') return
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [live, status?.state, refresh])
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    const warn = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => { clearInterval(t); window.removeEventListener('beforeunload', warn) }
  }, [live])

  async function start() {
    if (running.current) return                    // double click / repeated Enter
    running.current = true
    setError(null)
    setLive({ stage: 'READING_PAPER', detail: {}, t0: Date.now(), at: Date.now() })
    try {
      await paperPreparationService.prepare(importRecord, { onProgress: p => setLive(l => ({ ...(l || {}), stage: p.stage, detail: p.detail, t0: l?.t0 ?? Date.now(), at: Date.now() })) })
    } catch (e) {
      setError(e?.message || 'Preparation stopped unexpectedly.')
    } finally {
      running.current = false
      setLive(null)
      await refresh()
    }
  }

  if (loadError) return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{loadError} <button type="button" onClick={refresh} className="font-semibold underline">Retry</button></div>
  if (!status) return <p role="status" className="flex items-center gap-2 text-slate-600"><Loader2 size={16} className="animate-spin" aria-hidden="true" />Loading preparation status…</p>

  const state = live ? 'RUNNING_HERE' : status.state
  const currentStage = live?.stage || status.stage
  const detail = live?.detail || status.stage_detail || {}
  const idx = STAGES.findIndex(s => s.key === currentStage)
  const canStart = !status.teacher_work && !['RUNNING'].includes(status.state) && !live
  const reviewHref = status.draft_paper_id ? `/dashboard/admin/draft-review/${status.draft_paper_id}` : null
  const c = status.counts || {}

  const stageList = <ol className="space-y-2" aria-label="Preparation stages">{STAGES.map((s, i) => {
    const done = state === 'PREPARED' || i < idx
    const current = (state === 'RUNNING_HERE' || state === 'RUNNING') && i === idx
    const failedHere = ['FAILED', 'INTERRUPTED'].includes(state) && s.key === (status.failure_stage || status.stage)
    const text = current || failedHere ? stageText(s.key, detail) : null
    return <li key={s.key} className="flex items-start gap-2" data-stage={s.key} data-state={done ? 'done' : current ? 'current' : failedHere ? 'failed' : 'pending'}>
      {done ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
        : current ? <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-blue-700" aria-hidden="true" />
        : failedHere ? <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-600" aria-hidden="true" />
        : <Circle size={18} className="mt-0.5 shrink-0 text-slate-300" aria-hidden="true" />}
      <div><p className={cx('text-sm', current || failedHere ? 'font-semibold text-slate-900' : done ? 'text-slate-700' : 'text-slate-400')}>{s.label}</p>
        {text && <p className="text-xs text-slate-600">{text}</p>}</div>
    </li>
  })}</ol>

  return <section aria-label="Automatic preparation" className="space-y-4" data-state={state}>
    {error && error !== status.failure_message && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

    {state === 'UPLOADED' && <>
      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-700">Uploaded — not prepared yet.
        {status.draft_paper_id && ' An older Draft exists for this upload (created before automatic preparation).'}</p>
      {status.teacher_work && <p className="text-sm text-slate-700" data-testid="prep-blocked-teacher-work">That Draft contains teacher changes, so automatic preparation will not run over it — your work is protected. To try automatic preparation, upload the paper again as a new import.</p>}
      <button type="button" onClick={start} disabled={!canStart} className="rounded-lg bg-blue-700 px-5 py-2.5 font-semibold text-white disabled:opacity-50">Prepare Paper Automatically</button>
      <p className="text-sm text-slate-600">Detects questions, options, shared materials, figures, the answer key and the Telugu text, then lists only what needs a teacher. It runs in this browser tab — keep it open (a few minutes; a 28-page Telugu paper took about five minutes in testing). Answers stay proposed; nothing is confirmed automatically.</p>
    </>}

    {(state === 'RUNNING_HERE' || state === 'RUNNING') && <div className="space-y-3">
      <p role="status" className="flex items-center gap-2 font-semibold text-blue-800"><Loader2 size={18} className="animate-spin" aria-hidden="true" />
        {state === 'RUNNING_HERE' ? `Preparing — ${stageLabel(currentStage)} (${Math.round((now - live.t0) / 1000)} s)` : `Preparation is running in another tab or session — ${stageLabel(currentStage)}`}</p>
      {state === 'RUNNING_HERE' && now - live.at > 120_000 && <p role="alert" className="text-sm font-semibold text-red-800">No progress for {Math.floor((now - live.at) / 60_000)} min. If this continues, refresh the page; the run is then marked interrupted and can be started again.</p>}
      {state === 'RUNNING_HERE' ? <p className="text-sm text-amber-800">Keep this tab open until preparation completes; closing or refreshing it stops the run (it can be started again).</p>
        : <p className="text-sm text-slate-600">Last update {status.seconds_since_heartbeat ?? '?'} s ago. This page follows it automatically; a run with no update for two minutes is treated as interrupted.</p>}
      {stageList}
    </div>}

    {(state === 'FAILED' || state === 'INTERRUPTED') && <div className="space-y-3">
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900">
        <p className="font-bold">{state === 'INTERRUPTED' ? 'Preparation was interrupted' : 'Preparation failed'}{status.failure_stage || status.stage ? ` — ${stageLabel(status.failure_stage || status.stage)}` : ''}</p>
        <p className="text-sm">{withoutStagePrefix(status.failure_message, status.failure_stage) || 'The run stopped before it finished.'}{/shown as prepared/i.test(status.failure_message || '') ? '' : ' The paper is not shown as prepared.'}</p>
      </div>
      {stageList}
      {status.teacher_work
        ? <p className="text-sm text-slate-700">Automatic preparation cannot run again because this Draft contains teacher changes; your work is protected.</p>
        : <button type="button" onClick={start} disabled={!canStart} className="rounded-lg bg-blue-700 px-5 py-2.5 font-semibold text-white disabled:opacity-50">Try Again</button>}
    </div>}

    {state === 'PREPARED' && <div className="space-y-3">
      <p className="flex items-center gap-2 font-semibold text-emerald-800"><CheckCircle2 size={18} aria-hidden="true" />Prepared{status.prepared_at ? ` · ${new Date(status.prepared_at).toLocaleString()}` : ''}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Prepared paper summary">
        <Stat label="Questions prepared" value={c.questions} testid="prep-questions" />
        <Stat label="No blocking issues" value={c.ready} tone="text-emerald-800" testid="prep-ready" />
        <Stat label="Quick Check" value={c.quick_check} tone="text-amber-800" testid="prep-quick" />
        <Stat label="Manual Review" value={c.manual_review} tone="text-rose-800" testid="prep-manual" />
        <Stat label="Unresolved blocking items" value={c.open_blocking} testid="prep-blocking" />
        <Stat label="Optional verification" value={c.open_optional} tone="text-sky-800" testid="prep-optional" />
      </div>
      <p className="text-xs text-slate-500">“No blocking issues” does not mean the OCR was verified; high-confidence text stays an optional check. Answers are proposed from the answer key, never confirmed.</p>
      <div className="flex flex-wrap gap-3">
        {reviewHref && <a href={reviewHref} className="rounded-lg bg-blue-700 px-5 py-2.5 font-semibold text-white">Review Prepared Paper</a>}
        {onOpenDraftEditor && <button type="button" onClick={onOpenDraftEditor} className="rounded-lg px-4 py-2.5 font-semibold text-slate-800 ring-1 ring-slate-300">Open Draft editor</button>}
        {!status.teacher_work && <button type="button" onClick={() => { if (window.confirm('Prepare this paper again? The automatic Draft is replaced; it has no teacher changes.')) start() }} disabled={!canStart}
          className="rounded-lg px-4 py-2.5 font-semibold text-slate-700 ring-1 ring-slate-300 disabled:opacity-50">Prepare again</button>}
      </div>
      {status.teacher_work && <p className="text-sm text-slate-600">This Draft contains teacher changes, so automatic preparation will not run again over it.</p>}
    </div>}
  </section>
}
