import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import MathText from '../../math/MathText.jsx'
import SourceRegion from './SourceRegion.jsx'
import { cx } from './ReviewPanels.jsx'
import { groupMathImages, friendlyToLatex, placeAtAnchor } from '../../../../scripts/lib/math-image-recovery.mjs'
import { mathRecoveryService, mathRecoveryErrorMessage, OUTCOME_WORDS, REASON_WORDS } from '../../../services/mathRecoveryService.js'

// B4.8.3C — Math Recovery queue. One card per distinct maths bitmap (exact-pixel fingerprint):
// source image → friendly maths input → rendered preview → where it is used → Confirm & Next.
// The teacher types the maths once; the database (0032, ksc_resolve_math_image) places it at every
// English placement she saw, refuses any whose text changed, and never edits Telugu text or answers.

const HINT = 'Type ordinary maths — 8/11 · 3 1/2 · sqrt(3) · 70sqrt(3)/3 · 10^11 · 60°'
const INPUT_ERRORS = {
  EMPTY: 'Type the maths shown in the image.',
  WORDS_NOT_ALLOWED: 'Only maths can be stored here — no words or units.',
  UNBALANCED_BRACES: 'A bracket is not closed.',
  BARE_BRACE: 'Unexpected “{”. Type the maths without braces, e.g. 8/11.',
  ARGUMENT_NEEDS_BRACES: 'Write roots as sqrt(3) and powers as 10^11.',
  EMPTY_ARGUMENT: 'Something is missing in a fraction, root or power.',
  TOO_LONG: 'That is too long for one maths image.',
}
const inputError = code => INPUT_ERRORS[code] || (String(code).startsWith('COMMAND_NOT_ALLOWED') ? 'That command is not allowed. Use fractions, roots and powers.'
  : String(code).startsWith('CHARACTER_NOT_ALLOWED') ? 'That character cannot be stored in maths.' : 'That maths cannot be stored.')

const keyOf = o => `${o.page}@${o.box?.x},${o.box?.y}`
const boxOf = o => ({ x0: o.box.x, x1: o.box.x + o.box.w, y0: o.box.y, y1: o.box.y + o.box.h })

// Per fingerprint: the current verified value and which placements already carry it.
function statusOf(g, rec) {
  const current = rec.resolutions.find(r => r.fingerprint === g.fp && r.verification_state === 'TEACHER_VERIFIED') || null
  const revisions = rec.resolutions.filter(r => r.fingerprint === g.fp).length
  const entries = o => rec.log.filter(l => l.draft_question_id === o.questionId && l.placement_key === keyOf(o))
  const en = g.occurrences.filter(o => o.side === 'en')
  // Placed = its latest APPLIED entry belongs to the current revision. A problem = its latest entry is a
  // conflict/refusal (the text there was not changed).
  const placed = en.filter(o => current && entries(o).filter(l => l.outcome === 'APPLIED').at(-1)?.resolution_id === current.id)
  const problems = en.filter(o => ['CONFLICT', 'REFUSED'].includes(entries(o).at(-1)?.outcome))
  return { current, revisions, placed: placed.length, english: en.length, telugu: g.occurrences.length - en.length, problems,
    done: !!current && placed.length === en.length }
}

export default function MathRecoveryQueue({ draftPaperId, pdfPath, questions, options, onChanged }) {
  const groups = useMemo(() => groupMathImages(questions), [questions])
  const readable = useMemo(() => groups.filter(g => g.fp), [groups])
  const [rec, setRec] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [selFp, setSelFp] = useState(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState(null)
  const inputRef = useRef(null)

  const reload = useCallback(async () => {
    try { setRec(await mathRecoveryService.load(draftPaperId)); setLoadError(null) } catch { setLoadError('Math recovery data could not be loaded. Reload to try again.') }
  }, [draftPaperId])
  useEffect(() => { reload() }, [reload])

  const status = useMemo(() => (rec ? new Map(readable.map(g => [g.fp, statusOf(g, rec)])) : new Map()), [readable, rec])
  const ordered = useMemo(() => [...readable.filter(g => !status.get(g.fp)?.done), ...readable.filter(g => status.get(g.fp)?.done)], [readable, status])
  const todo = ordered.filter(g => !status.get(g.fp)?.done).length
  const g = ordered.find(x => x.fp === selFp) || ordered[0] || null
  const st = g ? status.get(g.fp) : null

  // Selecting a card: prefill a correction with the current value, focus the input.
  useEffect(() => {
    if (!g) return
    setInput(st?.current?.teacher_input ?? '')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [g?.fp, st?.current?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const textOf = o => (o.side === 'te' ? null : o.owner === 'stem' ? questions.find(q => q.id === o.questionId)?.content
    : options.find(x => x.draft_question_id === o.questionId && x.marker === o.owner)?.content) ?? null
  const conv = input.trim() ? friendlyToLatex(input) : { ok: false, error: 'EMPTY' }
  const where = o => `Q${o.question} · ${o.side === 'te' ? 'Telugu text' : o.owner === 'stem' ? 'Question' : `Option ${o.owner}`}`

  const nextAfter = fp => {
    const i = ordered.findIndex(x => x.fp === fp)
    return [...ordered.slice(i + 1), ...ordered.slice(0, i)].find(x => !status.get(x.fp)?.done && x.fp !== fp)?.fp ?? null
  }

  async function confirm() {
    if (!g || busy || !conv.ok) return
    setBusy(true); setFlash(null)
    try {
      const placements = g.occurrences.map(o => ({ question_id: o.questionId, key: keyOf(o), expected: textOf(o) }))
      const res = await mathRecoveryService.resolve({ draftPaperId, fingerprint: g.fp, input: input.trim(), representation: conv.latex, placements })
      const en = res.placements.filter(p => p.side === 'en')
      const applied = en.filter(p => p.outcome === 'APPLIED').length
      const already = en.filter(p => p.outcome === 'ALREADY_APPLIED').length
      const bad = en.filter(p => p.outcome === 'CONFLICT' || p.outcome === 'REFUSED')
      const te = res.placements.filter(p => p.side === 'te').length
      const s = n => (n === 1 ? '' : 's')
      const parts = [
        applied && `placed in ${applied} English place${s(applied)}`,
        already && `${already} place${s(already)} already had it`,
        te && `${te} Telugu place${s(te)}: type it in the Telugu review (Telugu text is never changed automatically)`,
      ].filter(Boolean)
      const nothingNew = res.reused && !applied && !bad.length
      setFlash({ kind: bad.length ? 'warn' : 'ok', latex: res.representation,
        text: `${nothingNew ? 'Already saved — nothing changed' : `Saved (revision ${res.revision})`}: ${parts.join('; ')}.`
          + `${res.closedNotationItems ? ` ${res.closedNotationItems} maths review item${s(res.closedNotationItems)} closed.` : ''}`,
        problems: bad.map(p => `Q${p.question} ${p.owner === 'stem' ? 'question' : `option ${p.owner}`}: ${OUTCOME_WORDS[p.outcome]} — ${REASON_WORDS[p.reason] || p.reason}`) })
      const next = bad.length ? g.fp : nextAfter(g.fp)
      await Promise.all([onChanged?.(), reload()])
      setSelFp(next)
    } catch (e) {
      setFlash({ kind: 'error', text: mathRecoveryErrorMessage(e) })
    } finally {
      setBusy(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  if (loadError) return <p role="alert" className="rounded bg-rose-50 p-3 text-sm text-rose-900">{loadError}</p>
  if (!rec) return <p role="status" className="flex items-center gap-2 text-sm text-slate-600"><Loader2 className="animate-spin" size={16} aria-hidden="true" />Loading maths images…</p>
  if (!rec.available) return <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="math-unavailable">
    Math recovery needs database migration 0032, which is not applied to this environment yet.</p>
  if (!readable.length) return <p className="text-sm text-slate-600">This paper has no maths printed as images.</p>

  const placements = ordered.reduce((n, x) => n + x.occurrences.length, 0)
  return <section aria-label="Math recovery" className="space-y-4" data-testid="math-recovery">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <p className="text-sm text-slate-700"><b>{readable.length}</b> distinct maths images in <b>{placements}</b> places · <b data-testid="math-todo">{todo}</b> to resolve
        {groups.length > readable.length ? ` · ${groups.length - readable.length} unreadable (fix by hand)` : ''}</p>
      {todo === 0 && <p className="flex items-center gap-1 text-sm font-semibold text-emerald-800" role="status"><CheckCircle2 size={16} aria-hidden="true" />Every maths image has a verified value.</p>}
    </div>
    {flash && <div role={flash.kind === 'error' ? 'alert' : 'status'} data-testid="math-flash" className={cx('space-y-1 rounded p-2 text-sm', flash.kind === 'error' ? 'bg-rose-50 text-rose-900' : flash.kind === 'warn' ? 'bg-amber-50 text-amber-950' : 'bg-emerald-50 text-emerald-900')}>
      <p>{flash.text}</p>{flash.problems?.length > 0 && <ul className="list-disc pl-5">{flash.problems.map(p => <li key={p}>{p}</li>)}</ul>}</div>}

    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      {g && <article className="order-1 min-w-0 space-y-4 rounded-lg border border-slate-200 bg-white p-4 lg:order-2" aria-label="Maths image" data-testid="math-card" data-fp={g.fp}>
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold">Maths image {readable.indexOf(g) + 1} of {readable.length}</h2>
          <span className="text-sm text-slate-600" data-testid="math-used">Used in {g.occurrences.length} place{g.occurrences.length === 1 ? '' : 's'}</span>
        </header>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase text-slate-500">Source image (as printed)</p>
            <SourceRegion storagePath={pdfPath} page={g.occurrences[0].page} box={boxOf(g.occurrences[0])} pad={14} scale={4}
              label={`Page ${g.occurrences[0].page} · ${where(g.occurrences[0])}`} imgClassName="max-h-40 w-auto max-w-full rounded border border-slate-200 bg-white object-contain" />
          </div>
          <div className="space-y-2">
            <label htmlFor="math-input" className="text-xs font-semibold uppercase text-slate-500">{st?.current ? 'Correct the value' : 'Type the maths'}</label>
            <input id="math-input" ref={inputRef} value={input} onChange={e => setInput(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); confirm() } else if (e.key === 'Escape') { e.preventDefault(); setFlash(null); setSelFp(nextAfter(g.fp)) } }}
              aria-describedby="math-hint math-preview" className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-lg" placeholder="e.g. 8/11" data-testid="math-input" />
            <p id="math-hint" className="text-xs text-slate-500">{HINT}</p>
            <div id="math-preview" aria-live="polite" className="min-h-12 rounded border border-slate-200 bg-slate-50 p-2 text-2xl" data-testid="math-preview">
              {input.trim() ? conv.ok ? <MathText text={conv.latex} /> : <span className="text-sm text-rose-800">{inputError(conv.error)}</span>
                : <span className="text-sm text-slate-500">The rendered maths appears here before you confirm.</span>}
            </div>
            {st?.current && <p className="text-xs text-slate-600">Verified value: <MathText text={st.current.representation} /> · revision {st.current.revision}{st.revisions > 1 ? ` (${st.revisions} revisions kept)` : ''}</p>}
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold uppercase text-slate-500">Where it is used</p>
          <ul className="divide-y divide-slate-100 rounded border border-slate-200" data-testid="math-occurrences">{g.occurrences.map(o => {
            const text = textOf(o)
            const entries = rec.log.filter(l => l.draft_question_id === o.questionId && l.placement_key === keyOf(o))
            const log = entries.at(-1)
            const lastApplied = entries.filter(l => l.outcome === 'APPLIED').at(-1)
            const isPlaced = !!(st?.current && lastApplied?.resolution_id === st.current.id && conv.ok && conv.latex === st.current.representation)
            // Preview exactly as the server would place it: a correction re-places from the pre-recovery text.
            const prev = o.side === 'en' && conv.ok && !isPlaced ? placeAtAnchor(lastApplied ? lastApplied.base_content : text, o.anchor, conv.latex) : null
            return <li key={`${o.questionId}|${keyOf(o)}`} className="grid gap-1 p-2 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
              <span className="font-semibold">{where(o)}</span>
              {o.side === 'te' ? <span className="text-slate-600">Not changed automatically — type it in the Telugu review.</span>
                : <span className="min-w-0 break-words">{isPlaced ? <><MathText text={text} /> <span className="text-xs font-semibold text-emerald-800">✓ placed</span></>
                  : prev ? prev.ok ? <MathText text={prev.content} /> : <span className="text-amber-900">Cannot be placed automatically: {REASON_WORDS[prev.why] || prev.why}</span>
                  : <span className="text-slate-700">{text ? <MathText text={text} /> : <i className="text-slate-500">(empty)</i>}</span>}
                  {log && ['CONFLICT', 'REFUSED'].includes(log.outcome) && <span className="block text-xs text-amber-900">Last attempt not changed: {REASON_WORDS[log.reason] || log.reason}</span>}</span>}
            </li>
          })}</ul>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={confirm} disabled={busy || !conv.ok} data-testid="math-confirm"
            className="rounded bg-blue-700 px-4 py-2 font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Confirm & Next'}</button>
          <button type="button" onClick={() => { setFlash(null); setSelFp(nextAfter(g.fp)) }} disabled={busy} className="rounded px-3 py-2 text-sm font-semibold ring-1 ring-slate-300">Skip</button>
          <span className="hidden text-xs text-slate-500 sm:inline">Enter confirm &amp; next · Esc skip. Answers are never changed.</span>
        </div>
      </article>}

      <aside aria-label="Maths images" className="order-2 lg:order-1">
        <details open className="rounded-lg border border-slate-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Maths images: {todo} to resolve</summary>
          <ol className="max-h-[32rem] overflow-y-auto border-t border-slate-100 lg:max-h-[70vh]">{ordered.map(x => {
            const s = status.get(x.fp), i = readable.indexOf(x)
            return <li key={x.fp}><button type="button" onClick={() => { setFlash(null); setSelFp(x.fp) }} aria-current={x.fp === g?.fp ? 'true' : undefined}
              className={cx('flex w-full items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm', x.fp === g?.fp ? 'bg-blue-50' : 'hover:bg-slate-50')}>
              <span><span className="block font-semibold">Image {i + 1} · {x.occurrences.length}×</span>
                <span className="block text-xs text-slate-600">{[...new Set(x.occurrences.map(o => `Q${o.question}`))].join(', ')}</span></span>
              {s?.done ? <span className="text-base"><MathText text={s.current.representation} /></span>
                : s?.problems.length ? <span className="text-xs font-semibold text-amber-800">needs attention</span> : <span className="text-xs text-slate-500">to do</span>}
            </button></li>
          })}</ol>
        </details>
      </aside>
    </div>
  </section>
}
