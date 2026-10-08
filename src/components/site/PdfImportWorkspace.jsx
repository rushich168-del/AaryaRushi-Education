import { useState, useEffect, useRef } from 'react'
import { testImportService } from '../../services/testImportService.js'
import AcademicContext from './AcademicContext.jsx'
import { contextFromUrl } from '../../services/programService.js'
import { FileText, Upload, AlertCircle, Clock, Plus, ChevronRight, Check, X, Edit2, CheckCircle2 } from 'lucide-react'
import React from 'react'
import PaperPreparationPanel from './PaperPreparationPanel.jsx'
import { paperPreparationService } from '../../services/paperPreparationService.js'
import { draftPaperService, isTeacherWorkBlockedError, TEACHER_WORK_BLOCKED_MESSAGE, optionRemovalMessage, conflictResolutionMessage, languageTextMessage } from '../../services/draftPaperService.js'
import {
  DRAFT_OPTION_SLOTS, optionRowsBySlot, planDraftEdit, resolveSlotOptionId,
  suggestMissingNumber, teacherAddedReference, manualInsertPosition, groupDraftMedia, compareDraftOptions,
  detectOptionConflicts, confirmTargetOptionId, groupLanguageTexts, canMarkScriptNeutral,
  validateTeluguInput, containsUnreadableGlyphs,
} from '../../services/draftPaperMapping.js'
import { draftMediaService } from '../../services/draftMediaService.js'
import SourceRegionCapture from './SourceRegionCapture.jsx'
import { createSingleFlight, saveDraftQuestionEdit } from '../../services/draftEditSave.js'
import { supabase } from '../../lib/supabaseClient.js'

// Map a durable draft_questions row (with draft_options) onto the shape the
// REVIEW cards render. `optionRows` is retained so edit/confirm can address
// options by their real ids.
function draftToCard(q) {
  const opts = (q.draft_options || []).slice().sort(compareDraftOptions)
  const proposedIdx = opts.findIndex(o => o.is_proposed_correct)
  const confirmedIdx = opts.findIndex(o => o.is_confirmed_correct)
  return {
    id: q.id,
    question_number: q.source_question_number,
    question_text: q.content,
    options: opts.map(o => o.content || ''),
    optionRows: opts,
    proposed_correct_index: proposedIdx >= 0 ? proposedIdx : null,
    confirmed_correct_index: confirmedIdx >= 0 ? confirmedIdx : null,
    status: q.extraction_status,
    is_confirmed: q.teacher_review_status === 'CONFIRMED',
    warnings: Array.isArray(q.warnings) ? q.warnings : [],
    source_page: q.source_page,
    origin: q.origin || 'EXTRACTED',
    position: q.position,
    // P0-B2 visuals: question-owned and per-option, independent of answer flags.
    // TEXT_REGION crops belong to the P0-B3 language workflow, not the visuals list.
    ...groupDraftMedia(q),
    questionVisuals: groupDraftMedia(q).questionMedia.filter(m => m.media_kind !== 'TEXT_REGION'),
    questionTextRegions: groupDraftMedia(q).questionMedia.filter(m => m.media_kind === 'TEXT_REGION'),
    optionVisuals: Object.fromEntries(Object.entries(groupDraftMedia(q).optionMedia)
      .map(([id, list]) => [id, list.filter(m => m.media_kind !== 'TEXT_REGION')])),
    // P0-B3: language versions of the SAME logical question/options.
    ...groupLanguageTexts(q),
    // Positions with competing option rows; they block editing until resolved.
    optionConflicts: detectOptionConflicts(opts),
  }
}

async function loadDraftCards(importId) {
  const paper = await draftPaperService.getDraftPaperByImport(importId)
  if (!paper) return { paper: null, cards: [] }
  const questions = await draftPaperService.getDraftQuestions(paper.id)
  return { paper, cards: questions.map(draftToCard) }
}

const PREPARATION_LABELS = { UPLOADED: 'Not prepared yet', RUNNING: 'Preparing…', FAILED: 'Preparation failed', INTERRUPTED: 'Preparation interrupted', PREPARED: 'Prepared' }

// B4.7: the open import is kept in the URL (?import=<id>) so a refresh reopens it; its preparation
// state is always re-read from the database.
function setImportParam(id) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('import', id); else url.searchParams.delete('import')
  window.history.replaceState(window.history.state, '', url.pathname + url.search)
}

export default function PdfImportWorkspace({ onBack }) {
  const [viewMode, setViewMode] = useState(() => new URLSearchParams(window.location.search).has('import') ? 'OPENING' : 'LIST') // 'LIST', 'NEW', 'VIEW', 'REVIEW'
  const [recentImports, setRecentImports] = useState([])
  const [loadingRecent, setLoadingRecent] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [candidates, setCandidates] = useState([])

  const [context, setContext] = useState(contextFromUrl)
  const [testType, setTestType] = useState('MODEL')
  const [testName, setTestName] = useState('')
  const [duration, setDuration] = useState('')
  const [file, setFile] = useState(null)
  
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [importRecord, setImportRecord] = useState(null)
  const [localCandidateCount, setLocalCandidateCount] = useState(null)

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('import')
    if (!id) return
    let alive = true
    testImportService.getImportRecord(id)
      .then(record => { if (alive) { setImportRecord(record); setViewMode('VIEW') } })
      .catch(() => { if (alive) { setImportParam(null); setError('That import could not be opened.'); setViewMode('LIST') } })
    return () => { alive = false }
  }, [])
  useEffect(() => { if (viewMode === 'LIST' || viewMode === 'NEW') setImportParam(null); else if (importRecord?.id) setImportParam(importRecord.id) }, [viewMode, importRecord?.id])

  useEffect(() => {
    if (viewMode === 'VIEW' && importRecord) {
      let isMounted = true
      // Inherit what LIST view loaded, or fetch if undefined
      if (importRecord.candidate_count !== undefined) {
        setLocalCandidateCount(importRecord.candidate_count)
      } else {
        testImportService.getCandidateCount(importRecord.id)
          .then(count => { if (isMounted) setLocalCandidateCount(count) })
          .catch(err => console.error(err))
      }
      return () => { isMounted = false }
    }
  }, [viewMode, importRecord])
  const [previewUrls, setPreviewUrls] = useState({})
  
  const [filterMode, setFilterMode] = useState('ALL')
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [expectedQ, setExpectedQ] = useState(200)
  // P0-B1: manual (teacher-added) draft questions.
  const [draftPaper, setDraftPaper] = useState(null)
  const [addingAfter, setAddingAfter] = useState(null) // index in candidates; -1 = before first
  const [addForm, setAddForm] = useState(null)
  const [savingNew, setSavingNew] = useState(false)
  // Single-flight guards: a repeated Save while one is running is ignored, so the
  // same option slots can never be inserted twice by overlapping saves.
  const editSaveFlight = useRef(createSingleFlight())
  const newSaveFlight = useRef(createSingleFlight())
  const [savingEdit, setSavingEdit] = useState(false)
  // Option-slot conflict resolution: per "questionId:position" -> { keepId, moveVisual }.
  const [conflictChoices, setConflictChoices] = useState({})
  const [resolvingSlot, setResolvingSlot] = useState(null)
  const resolveFlight = useRef(createSingleFlight())
  // P0-B3: Languages panel (English stays the primary Draft content; Telugu is a version).
  const [languageOpen, setLanguageOpen] = useState({})
  const [langDrafts, setLangDrafts] = useState({})
  const [savingLang, setSavingLang] = useState(null)
  const langFlight = useRef(createSingleFlight())
  // P0-B2: source-region capture target and fresh signed URLs for Draft visuals.
  const [capture, setCapture] = useState(null) // { owner, label, initialPage }
  const [mediaUrls, setMediaUrls] = useState({})

  useEffect(() => {
    const paths = candidates.flatMap(c => [
      ...(c.questionMedia || []),
      ...Object.values(c.optionMedia || {}).flat(),
    ]).map(m => m.storage_path)
    if (!paths.length) { setMediaUrls({}); return }
    let alive = true
    draftMediaService.signedUrls(paths)
      .then(urls => { if (alive) setMediaUrls(urls) })
      .catch(err => console.error('[draftMedia] Could not create signed URLs:', err))
    return () => { alive = false }
  }, [candidates])
  const [savingQ, setSavingQ] = useState(false)

  useEffect(() => {
    if (viewMode === 'LIST') {
      let isMounted = true
      setLoadingRecent(true)
      testImportService.getRecentImports()
        .then(async (data) => {
          if (!isMounted) return
          const [counts, preps] = await Promise.all([
            Promise.all(data.map(imp => testImportService.getCandidateCount(imp.id))),
            Promise.all(data.map(imp => paperPreparationService.getStatus(imp.id).catch(() => null))),
          ])
          const enriched = data.map((imp, i) => ({ ...imp, candidate_count: counts[i], preparation: preps[i] }))
          if (isMounted) {
            setRecentImports(enriched)
            // Auto-advance to NEW if empty
            if (enriched.length === 0) setViewMode('NEW')
          }
        })
        .catch(err => { if (isMounted) setError(err.message) })
        .finally(() => { if (isMounted) setLoadingRecent(false) })
      return () => { isMounted = false }
    }
  }, [viewMode])
  
  const testTypes = {
    FULL_MOCK: 'Full Mock Test',
    SUBJECT: 'Subject Test',
    CHAPTER: 'Chapter / Topic Practice',
    MODEL: 'Model Paper',
    PREVIOUS: 'Previous Year Paper'
  }

  const handleStartImport = async (e) => {
    e.preventDefault()
    if (!context.exam_id) return setError('Program is required.')
    if (!testType) return setError('Test Type is required.')
    if (!testName.trim()) return setError('Test Name is required.')
    if (!file) return setError('Source PDF is required.')
    
    setUploading(true)
    setError(null)
    
    try {
      const record = await testImportService.uploadSourceDocument(file, {
        exam_id: context.exam_id,
        level_id: context.level_id || null,
        test_kind: testType,
        test_name: testName,
        duration_minutes: duration ? parseInt(duration, 10) : null
      })
      
      const fullRecord = await testImportService.getImportRecord(record.id)
      setImportRecord(fullRecord)
      setViewMode('VIEW')
      testImportService.getRecentImports().then(setRecentImports).catch(console.error)
    } catch (err) {
      setError(err.message || 'Failed to upload PDF')
    } finally {
      setUploading(false)
    }
  }

  const handleOpenPreparationWorkspace = async () => {
    setAnalyzing(true)
    setError(null)
    try {
      const { paper, cards } = await loadDraftCards(importRecord.id)
      setDraftPaper(paper)
      setCandidates(cards)
      if (importRecord.expected_questions) {
        setExpectedQ(importRecord.expected_questions)
      }
      setViewMode('REVIEW')
    } catch (err) {
      console.error("Failed to load draft questions:", err)
      setError("Failed to load draft questions: " + err.message)
    } finally {
      setAnalyzing(false)
    }
  }
  
  if (viewMode === 'VIEW' && importRecord) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-bold">Import Workspace</h2>
          <button onClick={() => { setImportRecord(null); setViewMode('LIST'); }} className="text-blue-700 underline">Back to Recent Imports</button>
        </div>
        
        <div className="bg-white border rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">SOURCE</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8 text-sm">
            <div><span className="text-slate-500 block mb-1">Filename</span> <span className="font-medium text-slate-900">{importRecord.filename}</span></div>
            <div><span className="text-slate-500 block mb-1">Upload time</span> <span className="font-medium text-slate-900">{new Date(importRecord.created_at).toLocaleString()}</span></div>
            <div><span className="text-slate-500 block mb-1">Program</span> <span className="font-medium text-slate-900">{importRecord.exams?.name || 'Unknown'}</span></div>
            {importRecord.level_id && (
              <div><span className="text-slate-500 block mb-1">Track/Class</span> <span className="font-medium text-slate-900">{importRecord.exam_levels?.name || 'Unknown'}</span></div>
            )}
            <div><span className="text-slate-500 block mb-1">Test Type</span> <span className="font-medium text-slate-900">{testTypes[importRecord.test_kind] || importRecord.test_kind}</span></div>
            <div><span className="text-slate-500 block mb-1">Test Name</span> <span className="font-medium text-slate-900">{importRecord.test_name}</span></div>
            {importRecord.duration_minutes && (
              <div><span className="text-slate-500 block mb-1">Duration</span> <span className="font-medium text-slate-900">{importRecord.duration_minutes} minutes</span></div>
            )}
          </div>
        </div>
        
        <div className="bg-white border rounded-xl p-6 shadow-sm">
          <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">AUTOMATIC PREPARATION</h3>
          {error && (
            <div className="bg-red-50 text-red-700 p-4 rounded-lg border border-red-200 mb-6 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="text-sm">{error}</div>
            </div>
          )}
          {/* B4.7: the persisted preparation lifecycle replaces the prototype "Analyze" path. */}
          <PaperPreparationPanel key={importRecord.id} importRecord={importRecord} onOpenDraftEditor={handleOpenPreparationWorkspace} />
        </div>
      </div>
    )
  }

  const handleTogglePreview = async (candidate) => {
    if (!candidate.source_page || !importRecord?.storage_path) return
    const key = candidate.question_number
    if (previewUrls[key]) {
      setPreviewUrls(prev => ({ ...prev, [key]: null }))
      return
    }
    try {
      const { data, err } = await supabase.storage
        .from('ksc-source-documents')
        .createSignedUrl(importRecord.storage_path, 300)
      if (err) throw err
      if (data?.signedUrl) {
        setPreviewUrls(prev => ({
          ...prev,
          [key]: `${data.signedUrl}#page=${candidate.source_page}&view=FitH`
        }))
      } else {
        throw new Error("No signed URL returned")
      }
    } catch (e) {
      console.error('Failed to open source page:', e)
      alert('Could not generate secure viewing link. Please try again.')
    }
  }
  

  const handleToggleConfirm = async (c) => {
    if (c.optionConflicts?.length) {
      alert('Resolve the option conflicts for this question first.')
      return
    }
    const newConfirmed = !c.is_confirmed
    try {
      if (newConfirmed) {
        // Confirm the currently confirmed/proposed option by SLOT (or none if unknown).
        await draftPaperService.confirmSingleChoice(c.id, confirmTargetOptionId(c.optionRows || []))
      } else {
        await draftPaperService.unconfirmSingleChoice(c.id)
      }
    } catch (e) {
      alert('Could not update confirmation.')
      console.error(e)
      return
    }
    setCandidates(prev => prev.map(cand => cand.id === c.id ? { ...cand, is_confirmed: newConfirmed } : cand))
  }

  const handleSaveExpected = async () => {
    setSavingQ(true)
    try {
      const { error } = await supabase.from('test_imports').update({ expected_questions: expectedQ }).eq('id', importRecord.id)
      if (error) throw error
      setImportRecord({ ...importRecord, expected_questions: expectedQ })
      alert("Saved expected questions.")
    } catch (e) {
      console.warn("Could not save expected questions. Migration 0016 may be missing on live.", e)
      setImportRecord({ ...importRecord, expected_questions: expectedQ })
      alert("Saved expected questions locally (Migration 0016 not applied remotely).")
    }
    setSavingQ(false)
  }

  const handleEditClick = (c) => {
    if (c.optionConflicts?.length) {
      alert('Resolve the option conflicts for this question first.')
      return
    }
    // Slots are addressed by option position so text and rows stay aligned.
    const slots = optionRowsBySlot(c.optionRows || [])
    const confirmedRow = slots.find(r => r?.is_confirmed_correct)
    const proposedRow = slots.find(r => r?.is_proposed_correct)
    setEditingId(c.id)
    setEditForm({
      question_text: c.question_text || '',
      options: slots.map(r => r?.content ?? ''),
      // Only a teacher-confirmed answer is pre-selected; the parser proposal is a hint.
      selectedSlot: confirmedRow ? confirmedRow.position : null,
      proposedSlot: proposedRow ? proposedRow.position : null,
      answerChosen: false,
    })
  }

  const handleCancelEdit = () => {
    setEditingId(null)
  }

  const handleSaveEdit = (c) => editSaveFlight.current.run(async () => {
    setSavingEdit(true)
    try {
      // Plans against option rows re-read from the database, not the card snapshot.
      const result = await saveDraftQuestionEdit({ questionId: c.id, form: editForm, service: draftPaperService })
      if (result.status === 'SLOT_CONFLICT') {
        alert('This question has option conflicts. Nothing was saved. Resolve the conflicts first.')
        return
      }
      if (result.status === 'BLANK_EXISTING') {
        const which = result.plan.blankedExisting.map(p => p + 1).join(', ')
        alert(`Option ${which} is empty. Nothing was saved. To delete an option, use its Remove button.`)
        return
      }
      if (result.status === 'CONFIRM_BLOCKED') {
        alert('The selected answer option is empty. Enter its text before choosing it as the answer.')
        return
      }
      // Reload from the durable store so ids/flags stay authoritative.
      const { cards } = await loadDraftCards(importRecord.id)
      setCandidates(cards)
      setEditingId(null)
    } catch (e) {
      alert("Could not save edit.")
      console.error(e)
    } finally {
      setSavingEdit(false)
    }
  })

  // Teacher-approved resolution of one conflicting slot. The teacher must pick the row
  // to keep; nothing is chosen automatically. The server re-checks that the competing
  // rows are exactly the ones shown here.
  const handleResolveConflict = (c, conflict) => resolveFlight.current.run(async () => {
    const key = `${c.id}:${conflict.position}`
    const choice = conflictChoices[key]
    if (!choice?.keepId) {
      alert('Choose which option to keep for this slot.')
      return
    }
    const kept = conflict.rows.find(r => r.id === choice.keepId)
    const discarded = conflict.rows.filter(r => r.id !== choice.keepId)
    const summary = `Keep "${kept?.content || '[blank]'}" for option ${conflict.position + 1} and discard ${discarded.map(r => `"${r.content || '[blank]'}"`).join(', ')}?`
    if (!window.confirm(summary)) return
    setResolvingSlot(key)
    try {
      await draftPaperService.resolveOptionSlotConflict({
        questionId: c.id,
        position: conflict.position,
        keepOptionId: choice.keepId,
        expectedOptionIds: conflict.rows.map(r => r.id),
        moveVisual: !!choice.moveVisual,
      })
      setConflictChoices(prev => { const next = { ...prev }; delete next[key]; return next })
      await reloadDraft()
    } catch (e) {
      alert(conflictResolutionMessage(e))
      console.error(e)
    } finally {
      setResolvingSlot(null)
    }
  })

  const renderConflictPanel = (c) => {
    const conflictPositions = new Set(c.optionConflicts.map(x => x.position))
    const slotRows = optionRowsBySlot((c.optionRows || []).filter(r => !conflictPositions.has(r.position)))
    return (
      <div className="mb-4 border-2 border-red-300 rounded-lg bg-red-50 p-3 space-y-3">
        <div className="font-bold text-red-800 text-sm">OPTION CONFLICT — REVIEW REQUIRED</div>
        <p className="text-xs text-red-800">
          Some option slots have more than one saved value. Choose which one to keep for each slot.
          Editing, confirming and option visuals are paused for this question until every slot is resolved.
        </p>
        {Array.from({ length: DRAFT_OPTION_SLOTS }, (_, pos) => pos).map(pos => {
          const conflict = c.optionConflicts.find(x => x.position === pos)
          if (!conflict) {
            const row = slotRows[pos]
            return (
              <div key={pos} className="text-sm bg-white border rounded p-2">
                <span className="font-semibold">Option {pos + 1}:</span> {row ? (row.content || '[blank]') : <span className="text-slate-400">no option</span>}
              </div>
            )
          }
          const key = `${c.id}:${pos}`
          const choice = conflictChoices[key] || {}
          const discardedHasVisual = conflict.rows.some(r => r.id !== choice.keepId && (c.optionMedia?.[r.id] || []).length > 0)
          return (
            <div key={pos} className="bg-white border border-red-200 rounded p-2 text-sm space-y-1">
              <div className="font-semibold">Option {pos + 1} conflict — keep one:</div>
              {conflict.rows.map(r => {
                const visuals = (c.optionMedia?.[r.id] || []).length
                return (
                  <label key={r.id} className="flex items-start gap-2 p-1 rounded hover:bg-slate-50 cursor-pointer">
                    <input
                      type="radio"
                      name={`keep_${key}`}
                      checked={choice.keepId === r.id}
                      onChange={() => setConflictChoices(prev => ({ ...prev, [key]: { ...prev[key], keepId: r.id } }))}
                      className="mt-1"
                    />
                    <span className="flex-1">
                      <span className="font-medium">{r.content ? r.content : <span className="italic text-slate-500">[blank]</span>}</span>
                      <span className="ml-2 text-[11px] text-slate-500">
                        {r.origin || 'EXTRACTED'} · saved {r.created_at ? new Date(r.created_at).toLocaleString() : '—'}
                        {r.updated_at && r.created_at && r.updated_at > r.created_at ? ` · edited ${new Date(r.updated_at).toLocaleString()}` : ''}
                      </span>
                      {r.is_confirmed_correct && <span className="ml-2 text-[10px] font-bold px-1.5 rounded bg-blue-600 text-white">CONFIRMED</span>}
                      {r.is_proposed_correct && <span className="ml-2 text-[10px] font-bold px-1.5 rounded bg-green-100 text-green-800">PROPOSED</span>}
                      {visuals > 0 && <span className="ml-2 text-[10px] font-bold px-1.5 rounded bg-slate-200 text-slate-700">{visuals} visual{visuals > 1 ? 's' : ''}</span>}
                    </span>
                  </label>
                )
              })}
              {choice.keepId && discardedHasVisual && (
                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!choice.moveVisual}
                    onChange={e => setConflictChoices(prev => ({ ...prev, [key]: { ...prev[key], moveVisual: e.target.checked } }))}
                  />
                  Move its visual to the kept option
                </label>
              )}
              <div className="flex justify-end">
                <button
                  onClick={() => handleResolveConflict(c, conflict)}
                  disabled={!choice.keepId || resolvingSlot !== null}
                  className="px-3 py-1 text-xs font-medium bg-red-700 text-white rounded hover:bg-red-800 disabled:opacity-40"
                >
                  {resolvingSlot === key ? 'Resolving…' : `Resolve option ${pos + 1}`}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  // Explicit option removal. Blocked for the confirmed answer and for options with a
  // visual (checked here for a clear message, and enforced by the database).
  const handleRemoveOption = (c, row, slotIndex) => editSaveFlight.current.run(async () => {
    if (row.is_confirmed_correct) {
      alert('This option is the confirmed answer. Unconfirm the answer before removing it.')
      return
    }
    if ((c.optionMedia?.[row.id] || []).length > 0) {
      alert('This option has an attached visual. Remove the visual first.')
      return
    }
    if (!window.confirm(`Remove option ${slotIndex + 1} ("${row.content || ''}")? Unsaved changes in this edit will be discarded.`)) return
    setSavingEdit(true)
    try {
      await draftPaperService.removeDraftOption(row.id)
      const { cards } = await loadDraftCards(importRecord.id)
      setCandidates(cards)
      setEditingId(null)
    } catch (e) {
      alert(optionRemovalMessage(e))
      console.error(e)
    } finally {
      setSavingEdit(false)
    }
  })

  // ---- P0-B1: teacher adds a missing question at an explicit point ----------
  const handleOpenAdd = (afterIndex) => {
    const prev = afterIndex >= 0 ? candidates[afterIndex] : null
    const next = candidates[afterIndex + 1] || null
    setEditingId(null)
    setAddingAfter(afterIndex)
    setAddForm({
      question_number: suggestMissingNumber(prev?.question_number, next ? next.question_number : undefined) || '',
      question_text: '',
      options: Array(DRAFT_OPTION_SLOTS).fill(''),
      selectedSlot: null,
      answerChosen: false,
    })
  }

  const handleCancelAdd = () => {
    setAddingAfter(null)
    setAddForm(null)
  }

  const handleSaveNewQuestion = () => newSaveFlight.current.run(async () => {
    if (!draftPaper?.id || addingAfter === null || !addForm) return
    const plan = planDraftEdit({
      rows: [],
      formOptions: addForm.options,
      selectedSlot: addForm.selectedSlot,
      answerChosen: addForm.answerChosen,
    })
    if (plan.confirmBlocked) {
      alert('The selected answer option is empty. Enter its text before choosing it as the answer.')
      return
    }
    setSavingNew(true)
    try {
      const prev = addingAfter >= 0 ? candidates[addingAfter] : null
      const next = candidates[addingAfter + 1] || null
      const created = await draftPaperService.insertDraftQuestionAt({
        draftPaperId: draftPaper.id,
        position: manualInsertPosition(candidates, addingAfter),
        sourceQuestionNumber: addForm.question_number,
        content: addForm.question_text,
        sourceReference: teacherAddedReference(prev?.question_number, next?.question_number),
      })
      const inserted = []
      for (const ins of plan.inserts) {
        inserted.push(await draftPaperService.insertDraftOption(created.id, ins.position, ins.content))
      }
      // Confirm only when the teacher explicitly chose an answer.
      if (plan.confirmSlot !== null) {
        const optionId = resolveSlotOptionId(plan.confirmSlot, [], inserted)
        if (optionId) await draftPaperService.confirmSingleChoice(created.id, optionId)
      }
      const { paper, cards } = await loadDraftCards(importRecord.id)
      setDraftPaper(paper)
      setCandidates(cards)
      setAddingAfter(null)
      setAddForm(null)
    } catch (e) {
      alert('Could not add the question.')
      console.error(e)
    } finally {
      setSavingNew(false)
    }
  })

  const renderAddSlot = (afterIndex) => {
    if (filterMode !== 'ALL' || !draftPaper) return null
    if (addingAfter !== afterIndex) {
      return (
        <div className="flex justify-center">
          <button
            onClick={() => handleOpenAdd(afterIndex)}
            disabled={addingAfter !== null}
            className="text-xs text-blue-700 border border-dashed border-blue-300 rounded-full px-3 py-1 hover:bg-blue-50 disabled:opacity-40"
          >
            + Add Question Here
          </button>
        </div>
      )
    }
    return (
      <div className="p-4 border-2 border-dashed border-blue-300 rounded-xl bg-white space-y-3">
        <div className="text-sm font-bold text-slate-700">New teacher-added question</div>
        <div className="flex items-center gap-2">
          <label className="text-xs font-bold text-slate-500 uppercase">Question No.</label>
          <input
            type="text"
            className="w-24 border rounded p-1.5 text-sm"
            value={addForm.question_number}
            onChange={(e) => setAddForm({ ...addForm, question_number: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Question Text</label>
          <textarea
            className="w-full border rounded p-2 text-sm min-h-[60px]"
            value={addForm.question_text}
            onChange={(e) => setAddForm({ ...addForm, question_text: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Options (Single choice)</label>
          <div className="space-y-2">
            {Array.from({ length: DRAFT_OPTION_SLOTS }, (_, i) => i).map(i => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="correct_new_question"
                  checked={addForm.selectedSlot === i}
                  onChange={() => setAddForm({ ...addForm, selectedSlot: i, answerChosen: true })}
                  className="w-4 h-4 text-blue-600"
                  title="Choose as teacher-confirmed answer"
                />
                <input
                  type="text"
                  className="flex-1 border rounded p-1.5 text-sm"
                  placeholder={`Option ${i + 1}`}
                  value={addForm.options[i]}
                  onChange={(e) => {
                    const opts = [...addForm.options]
                    opts[i] = e.target.value
                    setAddForm({ ...addForm, options: opts })
                  }}
                />
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Select a radio button only to confirm the answer. No answer is confirmed otherwise.
          </p>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button onClick={handleCancelAdd} className="px-4 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded">Cancel</button>
          <button
            onClick={handleSaveNewQuestion}
            disabled={savingNew}
            className="px-4 py-1.5 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {savingNew ? 'Saving…' : 'Save Question'}
          </button>
        </div>
      </div>
    )
  }

  // ---- P0-B2: source-faithful visuals --------------------------------------
  const reloadDraft = async () => {
    const { paper, cards } = await loadDraftCards(importRecord.id)
    setDraftPaper(paper)
    setCandidates(cards)
  }

  const openCapture = (card, owner, label) => {
    if (!importRecord?.storage_path || !draftPaper?.id) return
    setCapture({ owner, label, initialPage: card.source_page || 1, purpose: 'VISUAL' })
  }

  // Capture the Telugu source block for a question. One question-level crop may back the
  // stem and its options; separate crops per option are not required.
  const openTeluguCapture = (card) => {
    if (!importRecord?.storage_path || !draftPaper?.id) return
    setCapture({
      owner: { questionId: card.id },
      label: `Q${card.question_number ?? ''} Telugu source`,
      initialPage: card.source_page || 1,
      purpose: 'TEXT_SOURCE',
      questionId: card.id,
      allowedKinds: ['TEXT_REGION'],
    })
  }

  const handleAttachVisual = async (payload) => {
    const media = await draftMediaService.attachRegionCrop({
      ...payload,
      draftPaperId: draftPaper.id,
      owner: capture.owner,
      sourceImportId: importRecord.id,
    })
    // A Telugu source capture is linked to the question's Telugu version. No text is
    // invented: the version stays UNRELIABLE until the teacher types the Telugu.
    if (capture.purpose === 'TEXT_SOURCE' && capture.questionId) {
      const card = candidates.find(x => x.id === capture.questionId)
      const existing = card?.questionTexts?.te
      await draftPaperService.upsertQuestionText({
        questionId: capture.questionId,
        language: 'te',
        content: existing?.content ?? null,
        textQuality: existing?.content ? existing.text_quality : 'UNRELIABLE',
        sourceMediaId: media.id,
      })
    }
    setCapture(null)
    await reloadDraft()
  }

  // ---- P0-B3: language versions. These never touch proposed/confirmed answers. ----
  const langKey = (kind, id) => `${kind}:${id}:te`
  const teluguValue = (key, existing) => (langDrafts[key] !== undefined ? langDrafts[key] : (existing?.content ?? ''))

  const saveLanguage = (key, task) => langFlight.current.run(async () => {
    setSavingLang(key)
    try {
      await task()
      setLangDrafts(prev => { const next = { ...prev }; delete next[key]; return next })
      await reloadDraft()
    } catch (e) {
      alert(languageTextMessage(e))
      console.error(e)
    } finally {
      setSavingLang(null)
    }
  })

  // Refuses text made of the PDF's legacy glyphs (it would show as boxes), and asks for
  // confirmation when nothing Telugu was typed. Returns false to stop the save.
  const teluguInputAccepted = (text) => {
    const check = validateTeluguInput(text)
    if (!check.ok) { alert(check.message); return false }
    if (check.warn && !window.confirm('This text contains no Telugu characters. Save it as the Telugu version anyway?')) return false
    return true
  }

  const handleSaveQuestionTelugu = (c) => {
    const key = langKey('q', c.id)
    const text = teluguValue(key, c.questionTexts?.te).trim()
    if (!teluguInputAccepted(text)) return
    return saveLanguage(key, () => draftPaperService.upsertQuestionText({
      questionId: c.id,
      language: 'te',
      content: text || null,
      textQuality: text ? 'TEACHER_ENTERED' : (c.questionTexts?.te?.source_media_id ? 'UNRELIABLE' : 'MISSING'),
      sourceMediaId: c.questionTexts?.te?.source_media_id ?? null,
      primaryContent: c.question_text ?? '',
    }))
  }

  const handleSaveOptionTelugu = (c, optionRow) => {
    const key = langKey('o', optionRow.id)
    const text = teluguValue(key, c.optionTexts?.[optionRow.id]?.te).trim()
    if (!teluguInputAccepted(text)) return
    return saveLanguage(key, () => draftPaperService.upsertOptionText({
      optionId: optionRow.id,
      language: 'te',
      content: text || null,
      textQuality: text ? 'TEACHER_ENTERED' : 'MISSING',
      sourceMediaId: c.optionTexts?.[optionRow.id]?.te?.source_media_id ?? null,
      primaryContent: optionRow.content ?? '',
    }))
  }

  // Digits and symbols read the same in every language (Q6's 15/19/22/24). Words never do.
  const handleMarkScriptNeutral = (c, optionRow) => {
    const key = langKey('o', optionRow.id)
    if (!canMarkScriptNeutral(optionRow.content ?? '')) {
      alert('Only digits or symbols can be marked as the same in both languages. Type the Telugu for this option instead.')
      return
    }
    return saveLanguage(key, () => draftPaperService.upsertOptionText({
      optionId: optionRow.id, language: 'te', content: null, textQuality: 'SCRIPT_NEUTRAL',
      primaryContent: optionRow.content ?? '',
    }))
  }

  // Reverse "Same": the Telugu version becomes editable again. The logical option, its
  // answer flags and any captured source region are untouched.
  const handleEnterTeluguInstead = (c, optionRow) => {
    const key = langKey('o', optionRow.id)
    return saveLanguage(key, () => draftPaperService.upsertOptionText({
      optionId: optionRow.id, language: 'te', content: null, textQuality: 'MISSING',
      sourceMediaId: c.optionTexts?.[optionRow.id]?.te?.source_media_id ?? null,
      primaryContent: optionRow.content ?? '',
    }))
  }

  const QUALITY_LABEL = {
    TEACHER_ENTERED: 'Teacher entered', UNRELIABLE: 'Source captured — not yet typed',
    SCRIPT_NEUTRAL: 'Same in both languages', VALID_UNICODE: 'Extracted (Unicode)', MISSING: 'Missing',
  }
  const qualityBadge = (row) => {
    const q = row?.text_quality || 'MISSING'
    const tone = q === 'TEACHER_ENTERED' ? 'bg-green-100 text-green-800'
      : q === 'SCRIPT_NEUTRAL' ? 'bg-slate-200 text-slate-700'
        : q === 'UNRELIABLE' ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'
    return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${tone}`}>{QUALITY_LABEL[q]}</span>
  }

  const renderLanguagePanel = (c) => {
    const key = langKey('q', c.id)
    const teQ = c.questionTexts?.te
    const busy = savingLang !== null
    return (
      <div className="mt-4 border rounded-lg bg-slate-50 p-3 space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-bold text-slate-700">Languages</span>
          <span className="text-[11px] text-slate-500">English is the primary draft content. Telugu is a version of the same question.</span>
        </div>

        <div className="bg-white border rounded p-2 space-y-2">
          <div><span className="text-[11px] font-bold text-slate-500">QUESTION · EN</span>
            <div className="ksc-telugu whitespace-pre-wrap">{c.question_text || <span className="text-slate-400">—</span>}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold text-slate-500">QUESTION · TE</span>
            {qualityBadge(teQ)}
          </div>
          <textarea
            className="ksc-telugu w-full border rounded p-2 min-h-[56px]"
            placeholder="Type the Telugu question text from the source reference…"
            value={teluguValue(key, teQ)}
            onChange={e => setLangDrafts(prev => ({ ...prev, [key]: e.target.value }))}
          />
          {containsUnreadableGlyphs(teluguValue(key, teQ)) && (
            <div className="p-2 rounded bg-red-50 border border-red-200 text-xs text-red-800">
              These characters are the PDF's legacy font glyphs, not Telugu, so they show as boxes.
              Text copied out of this PDF cannot be used — type the Telugu instead.
            </div>
          )}
          {c.questionTextRegions?.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] font-bold text-amber-800">
                Source reference — Telugu could not be extracted reliably
              </div>
              <div className="text-[11px] text-slate-600">
                This crop of the original page is a reference for typing the Telugu. It is not the Telugu text itself.
              </div>
              <div className="flex flex-wrap gap-2">
                {c.questionTextRegions.map(m => (
                  <img key={m.id} src={mediaUrls[m.storage_path]} alt={`Telugu source reference from page ${m.source_page}`}
                    className="border rounded max-h-32" />
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => handleSaveQuestionTelugu(c)} disabled={busy}
              className="px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              {savingLang === key ? 'Saving…' : 'Save Telugu'}
            </button>
            <button onClick={() => openTeluguCapture(c)} disabled={busy || !draftPaper || !importRecord?.storage_path}
              className="px-3 py-1 text-xs font-medium border rounded bg-white hover:bg-slate-50 disabled:opacity-40">
              Capture Telugu source
            </button>
          </div>
        </div>

        {(c.optionRows || []).map((row, idx) => {
          const oKey = langKey('o', row.id)
          const teO = c.optionTexts?.[row.id]?.te
          return (
            <div key={row.id} className="bg-white border rounded p-2 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-bold text-slate-500">OPTION {idx + 1} · EN</span>
                <span className="ksc-telugu">{row.content || <span className="text-slate-400">[blank]</span>}</span>
                {qualityBadge(teO)}
              </div>
              {teO?.text_quality !== 'SCRIPT_NEUTRAL' && (
                <input
                  type="text"
                  className="ksc-telugu w-full border rounded p-1.5"
                  placeholder="Telugu version of this option…"
                  value={teluguValue(oKey, teO)}
                  onChange={e => setLangDrafts(prev => ({ ...prev, [oKey]: e.target.value }))}
                />
              )}
              {containsUnreadableGlyphs(teluguValue(oKey, teO)) && (
                <div className="text-[11px] text-red-800">Legacy PDF glyphs, not Telugu — type the Telugu instead.</div>
              )}
              <div className="flex gap-2">
                {teO?.text_quality === 'SCRIPT_NEUTRAL' ? (
                  <button onClick={() => handleEnterTeluguInstead(c, row)} disabled={busy}
                    title="Make the Telugu version editable again"
                    className="px-2 py-0.5 text-[11px] font-medium border rounded bg-white hover:bg-slate-50 disabled:opacity-40">
                    {savingLang === oKey ? 'Working…' : 'Enter Telugu instead'}
                  </button>
                ) : (
                  <>
                    <button onClick={() => handleSaveOptionTelugu(c, row)} disabled={busy}
                      className="px-2 py-0.5 text-[11px] font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                      {savingLang === oKey ? 'Saving…' : 'Save'}
                    </button>
                    <button onClick={() => handleMarkScriptNeutral(c, row)}
                      disabled={busy || !canMarkScriptNeutral(row.content ?? '')}
                      title={canMarkScriptNeutral(row.content ?? '')
                        ? 'Digits/symbols read the same in both languages'
                        : 'Only digits or symbols can be the same in both languages — type the Telugu for this option'}
                      className="px-2 py-0.5 text-[11px] font-medium border rounded bg-white hover:bg-slate-50 disabled:opacity-40">
                      Same (script-neutral)
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  const handleViewMedia = async (media) => {
    try {
      const urls = await draftMediaService.signedUrls([media.storage_path])
      if (urls[media.storage_path]) window.open(urls[media.storage_path], '_blank', 'noopener,noreferrer')
    } catch (e) {
      alert('Could not open the visual. Please try again.')
      console.error(e)
    }
  }

  const handleRemoveMedia = async (media) => {
    if (!window.confirm('Remove this visual from the draft question?')) return
    try {
      await draftMediaService.removeMedia(media)
      await reloadDraft()
    } catch (e) {
      alert('Could not remove the visual.')
      console.error(e)
    }
  }

  const KIND_LABEL = { DIAGRAM: 'Diagram', FIGURE: 'Figure', IMAGE: 'Image', TABLE: 'Table', CHART: 'Chart', MAP: 'Map', TEXT_REGION: 'Text region', OTHER: 'Other' }
  const renderMediaList = (list = []) => (list.length === 0 ? null : (
    <div className="flex flex-wrap gap-3 mt-2">
      {list.map(m => (
        <div key={m.id} className="border rounded bg-white p-2 w-48">
          {mediaUrls[m.storage_path]
            ? <img src={mediaUrls[m.storage_path]} alt={`${KIND_LABEL[m.media_kind] || m.media_kind} from source page ${m.source_page}`} className="w-full h-auto max-h-40 object-contain border" />
            : <div className="h-24 flex items-center justify-center text-xs text-slate-400 border">Loading visual…</div>}
          <div className="mt-1 flex items-center justify-between text-[11px] text-slate-600">
            <span className="font-semibold">{KIND_LABEL[m.media_kind] || m.media_kind}</span>
            {m.source_page && <span>Source p.{m.source_page}</span>}
          </div>
          <div className="mt-1 flex gap-2 text-[11px]">
            <button onClick={() => handleViewMedia(m)} className="text-blue-700 hover:underline">View</button>
            <button onClick={() => handleRemoveMedia(m)} className="text-red-700 hover:underline">Remove</button>
          </div>
        </div>
      ))}
    </div>
  ))

  if (viewMode === 'REVIEW') {
    const coverageIssues = []
    let possibleMissingCount = 0
    let readyCount = 0
    let needsReviewCount = 0
    let confirmedCount = 0
    
    const numberCounts = {}
    candidates.forEach(c => {
      if (c.status === 'READY') readyCount++
      else needsReviewCount++
      if (c.is_confirmed) confirmedCount++
      const n = parseInt(c.question_number, 10)
      if (!isNaN(n)) numberCounts[n] = (numberCounts[n] || 0) + 1
    })

    for (const [num, count] of Object.entries(numberCounts)) {
      if (count > 1) coverageIssues.push({ type: 'DUPLICATE', text: `Duplicate numbering: Question ${num} appears ${count} times.` })
    }

    let lastQNum = -1
    for (const c of candidates) {
      const num = parseInt(c.question_number, 10)
      if (!isNaN(num)) {
        if (lastQNum !== -1 && num > lastQNum + 1) {
          const missingLen = num - lastQNum - 1
          possibleMissingCount += missingLen
          coverageIssues.push({
            type: 'GAP',
            text: `Possible missing question(s): ${Array.from({length: missingLen}, (_, k) => `Q${lastQNum + k + 1}`).join(', ')}. Detected sequence jumped from Q${lastQNum} to Q${num}.`
          })
        }
        lastQNum = num
      }
    }

    const filteredCandidates = candidates.filter(c => {
      if (filterMode === 'ALL') return true
      if (filterMode === 'READY') return c.status === 'READY'
      if (filterMode === 'NEEDS_REVIEW') return c.status !== 'READY'
      if (filterMode === 'CONFIRMED') return c.is_confirmed
      return true
    })

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-bold">Paper Preparation Workspace</h2>
          <div className="flex flex-wrap items-center gap-3">
            {/* B4.6: exception review for the prepared Draft (review items exist once 0027 is applied). */}
            {draftPaper?.id && <a href={`/dashboard/admin/draft-review/${draftPaper.id}`} className="rounded bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white">Open Review Center</a>}
            <button onClick={() => setViewMode('VIEW')} className="text-blue-700 underline">Back to Import Summary</button>
          </div>
        </div>
        
        {error && (
          <div className="p-4 bg-red-50 text-red-700 border border-red-200 rounded-lg flex items-center gap-2">
            <AlertCircle size={18} /> {error}
          </div>
        )}

        <div className="bg-white border rounded-xl shadow-sm overflow-hidden mb-6">
          <div className="bg-slate-50 border-b px-6 py-4 flex flex-wrap gap-6 justify-between items-center">
            <div>
              <div className="text-sm font-bold text-slate-500 uppercase">Expected Questions</div>
              <div className="flex items-center gap-2 mt-1">
                <input 
                  type="number" min="1"
                  className="border border-slate-300 rounded px-2 py-1 w-24 text-sm"
                  value={expectedQ}
                  onChange={(e) => setExpectedQ(parseInt(e.target.value, 10))}
                />
                <button onClick={handleSaveExpected} disabled={savingQ} className="text-blue-600 text-sm font-medium hover:underline">
                  {savingQ ? 'Saving...' : 'Update'}
                </button>
              </div>
            </div>
            <div className="flex gap-8 text-center">
              <div>
                <div className="text-sm font-bold text-slate-500 uppercase">Detected</div>
                <div className="font-bold text-xl">{candidates.length}</div>
              </div>
              <div>
                <div className="text-sm font-bold text-slate-500 uppercase">Ready</div>
                <div className="font-bold text-xl text-green-700">{readyCount}</div>
              </div>
              <div>
                <div className="text-sm font-bold text-slate-500 uppercase">Needs Review</div>
                <div className="font-bold text-xl text-amber-600">{needsReviewCount}</div>
              </div>
              <div>
                <div className="text-sm font-bold text-slate-500 uppercase">Missing</div>
                <div className="font-bold text-xl text-red-600">{possibleMissingCount}</div>
              </div>
              <div>
                <div className="text-sm font-bold text-slate-500 uppercase">Confirmed</div>
                <div className="font-bold text-xl text-blue-700">{confirmedCount}</div>
              </div>
            </div>
          </div>
          
          <div className="p-4 border-b bg-slate-50 flex items-center gap-2 overflow-x-auto">
            <span className="text-sm font-bold text-slate-500 mr-2 uppercase">Filter:</span>
            {['ALL', 'READY', 'NEEDS_REVIEW', 'CONFIRMED'].map(mode => (
              <button 
                key={mode}
                onClick={() => setFilterMode(mode)}
                className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                  filterMode === mode 
                    ? 'bg-slate-800 text-white' 
                    : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-100'
                }`}
              >
                {mode.replace('_', ' ')}
              </button>
            ))}
          </div>
          
          {coverageIssues.length > 0 && filterMode === 'ALL' && (
            <div className="p-4 bg-amber-50 border-b border-amber-200">
              <h4 className="font-bold text-amber-800 flex items-center gap-2 mb-2">
                <AlertCircle size={16} /> Coverage Validation Issues
              </h4>
              <ul className="list-disc pl-6 space-y-1 text-sm text-amber-700">
                {coverageIssues.map((iss, i) => (
                  <li key={i}><strong>{iss.type}:</strong> {iss.text}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="space-y-4">
          {renderAddSlot(-1)}
          {filteredCandidates.map((c, cIdx) => {
            const isEditing = editingId === c.id
            const isConfirmed = !!c.is_confirmed

            return (
              <React.Fragment key={c.id}>
              <div className={`p-5 border rounded-xl shadow-sm transition-all ${
                isConfirmed ? 'bg-blue-50 border-blue-200' :
                c.status !== 'READY' ? 'bg-amber-50 border-amber-300' : 'bg-white border-slate-200'
              }`}>
                <div className="flex items-center justify-between mb-4 border-b pb-3">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-xl">Q{c.question_number}</span>
                    {c.origin === 'TEACHER' && (
                      <span className="text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded border border-slate-300 text-slate-600 bg-white">
                        TEACHER ADDED
                      </span>
                    )}
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                      isConfirmed ? 'bg-blue-600 text-white' :
                      c.status !== 'READY' ? 'bg-amber-200 text-amber-800' : 'bg-green-100 text-green-800'
                    }`}>
                      {isConfirmed ? 'CONFIRMED' : (c.status === 'READY' ? 'READY' : 'NEEDS REVIEW')}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    {!isEditing && (
                      <>
                        <button
                          onClick={() => handleEditClick(c)}
                          disabled={c.optionConflicts?.length > 0}
                          title={c.optionConflicts?.length > 0 ? 'Resolve option conflicts first' : undefined}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 transition disabled:opacity-40"
                        >
                          <Edit2 size={14} /> Edit
                        </button>
                        <button
                          onClick={() => handleToggleConfirm(c)}
                          disabled={c.optionConflicts?.length > 0}
                          title={c.optionConflicts?.length > 0 ? 'Resolve option conflicts first' : undefined}
                          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded transition disabled:opacity-40 ${
                            isConfirmed 
                              ? 'bg-white border border-blue-300 text-blue-700 hover:bg-blue-50' 
                              : 'bg-blue-600 border border-blue-600 text-white hover:bg-blue-700'
                          }`}
                        >
                          <CheckCircle2 size={16} />
                          {isConfirmed ? 'Unconfirm' : 'Confirm'}
                        </button>
                        <button
                          onClick={() => openCapture(c, { questionId: c.id }, `Q${c.question_number ?? ''} question`)}
                          disabled={!draftPaper || !importRecord?.storage_path}
                          className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40"
                        >
                          Add visual from source
                        </button>
                        <button
                          onClick={() => setLanguageOpen(prev => ({ ...prev, [c.id]: !prev[c.id] }))}
                          disabled={c.optionConflicts?.length > 0}
                          title={c.optionConflicts?.length > 0 ? 'Resolve option conflicts first' : 'English / Telugu versions of this question'}
                          className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 disabled:opacity-40"
                        >
                          {languageOpen[c.id] ? 'Hide languages' : 'Languages'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                
                {isEditing ? (
                  <div className="space-y-4 bg-white p-4 rounded border">
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Question Text</label>
                      <textarea 
                        className="w-full border rounded p-2 text-sm min-h-[60px]"
                        value={editForm.question_text}
                        onChange={(e) => setEditForm({...editForm, question_text: e.target.value})}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Options</label>
                      <div className="space-y-2">
                        {Array.from({ length: DRAFT_OPTION_SLOTS }, (_, i) => i).map(i => (
                          <div key={i} className="flex items-center gap-2">
                            <input
                              type="radio"
                              name={`correct_${c.id}`}
                              checked={editForm.selectedSlot === i}
                              onChange={() => setEditForm({...editForm, selectedSlot: i, answerChosen: true})}
                              className="w-4 h-4 text-blue-600"
                              title="Choose as teacher-confirmed answer"
                            />
                            <input 
                              type="text" 
                              className="flex-1 border rounded p-1.5 text-sm"
                              placeholder={`Option ${i+1}`}
                              value={editForm.options[i] || ''}
                              onChange={(e) => {
                                const newOpts = [...(editForm.options || [])]
                                newOpts[i] = e.target.value
                                setEditForm({...editForm, options: newOpts})
                              }}
                            />
                            {editForm.proposedSlot === i && (
                              <span className="text-xs text-amber-700 whitespace-nowrap">Parser suggestion</span>
                            )}
                            {(() => {
                              const slotRow = optionRowsBySlot(c.optionRows || [])[i]
                              return slotRow ? (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveOption(c, slotRow, i)}
                                  disabled={savingEdit}
                                  className="text-xs text-red-700 hover:underline whitespace-nowrap disabled:opacity-40"
                                  title="Remove this option"
                                >
                                  Remove
                                </button>
                              ) : null
                            })()}
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        Select a radio button only to confirm the answer. Editing text alone does not confirm an answer.
                        To delete an existing option use Remove; clearing its text will not delete it.
                      </p>
                    </div>
                    <div className="flex justify-end gap-2 pt-2 border-t">
                      <button onClick={handleCancelEdit} className="px-4 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded">Cancel</button>
                      <button
                        onClick={() => handleSaveEdit(c)}
                        disabled={savingEdit}
                        className="px-4 py-1.5 text-sm font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                      >
                        {savingEdit ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="text-slate-800 whitespace-pre-wrap mb-4 text-sm font-medium">
                      {c.question_text}
                    </div>
                    {c.questionVisuals?.length > 0 && <div className="mb-4">{renderMediaList(c.questionVisuals)}</div>}

                    {c.optionConflicts?.length > 0 && renderConflictPanel(c)}

                    {!(c.optionConflicts?.length > 0) && c.options && c.options.length > 0 && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-4">
                        {c.options.map((opt, oIdx) => {
                          const optRow = c.optionRows?.[oIdx]
                          return (
                          <div key={oIdx} className={`p-2 border rounded text-sm ${c.proposed_correct_index === oIdx ? 'bg-green-100 border-green-400 font-bold text-green-900' : 'bg-white border-slate-200'}`}>
                            {oIdx + 1}) {opt}
                            {optRow && renderMediaList(c.optionVisuals?.[optRow.id])}
                            {optRow && (
                              <div>
                                <button
                                  onClick={() => openCapture(c, { optionId: optRow.id }, `Q${c.question_number ?? ''} option ${oIdx + 1}`)}
                                  disabled={!draftPaper || !importRecord?.storage_path}
                                  className="mt-1 text-[11px] font-normal text-blue-700 hover:underline disabled:opacity-40"
                                >
                                  + Add visual to option {oIdx + 1}
                                </button>
                              </div>
                            )}
                          </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
                
                {!isEditing && languageOpen[c.id] && !(c.optionConflicts?.length > 0) && renderLanguagePanel(c)}

                {c.source_page && (
                  <div className="mt-4 pt-4 border-t border-slate-200/60">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold text-slate-500 uppercase">Original Source Region</span>
                      <button 
                        onClick={() => handleTogglePreview(c)}
                        disabled={!c.source_page || !importRecord?.storage_path}
                        className="text-xs bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 px-3 py-1.5 rounded font-medium transition flex items-center gap-1 disabled:opacity-50"
                      >
                        {previewUrls[c.question_number] ? 'Hide Preview' : `Visual Preview (Page ${c.source_page})`}
                      </button>
                    </div>
                    {previewUrls[c.question_number] && (
                      <div className="w-full border-2 border-slate-300 rounded overflow-hidden relative shadow-inner">
                        <div className="bg-slate-100 p-2 text-xs flex justify-between items-center border-b border-slate-300">
                          <span className="text-slate-600 font-medium">Inline Preview (Page {c.source_page})</span>
                          <a href={previewUrls[c.question_number]} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">
                            Open in new tab instead
                          </a>
                        </div>
                        <iframe 
                          src={previewUrls[c.question_number]} 
                          className="w-full h-[600px] bg-slate-50"
                          title={`Preview Page ${c.source_page}`}
                        />
                      </div>
                    )}
                  </div>
                )}

                {!isEditing && c.warnings && c.warnings.length > 0 && (
                  <div className="mt-4 text-sm text-amber-700 bg-amber-50/50 p-3 rounded border border-amber-200 space-y-1">
                    <div className="font-bold flex items-center gap-1"><AlertCircle size={14} /> Extraction Notes:</div>
                    <ul className="list-disc pl-5">
                      {c.warnings.map((w, wIdx) => <li key={wIdx}>{w}</li>)}
                    </ul>
                  </div>
                )}
              </div>
              {renderAddSlot(cIdx)}
              </React.Fragment>
            )
          })}
        </div>

        {capture && (
          <SourceRegionCapture
            storagePath={importRecord.storage_path}
            initialPage={capture.initialPage}
            targetLabel={capture.label}
            onAttach={handleAttachVisual}
            onClose={() => setCapture(null)}
            {...(capture.allowedKinds ? { allowedKinds: capture.allowedKinds } : {})}
          />
        )}
      </div>
    )
  }

  if (viewMode === 'OPENING') return <p role="status" className="text-slate-600">Opening import…</p>

  if (viewMode === 'LIST') {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-bold">Current / Recent PDF Imports</h2>
          <button onClick={onBack} className="text-blue-700 underline">Back to Question Bank</button>
        </div>
        
        {error && (
          <div className="p-4 bg-red-50 text-red-700 border border-red-200 rounded-lg flex items-center gap-2">
            <AlertCircle size={18} /> {error}
          </div>
        )}

        <div className="bg-white border rounded-xl shadow-sm overflow-hidden">
          {loadingRecent ? (
            <div className="p-8 text-center text-slate-500">Loading recent imports...</div>
          ) : recentImports.length === 0 ? (
            <div className="p-8 text-center text-slate-500">No recent imports found.</div>
          ) : (
              <ul className="divide-y divide-slate-100">
                {recentImports.map(imp => (
                  <li key={imp.id} className="p-5 hover:bg-slate-50 transition flex items-center justify-between gap-4">
                    <div>
                      <h3 className="font-bold text-slate-800 text-lg mb-1">{imp.filename}</h3>
                      <div className="text-sm text-slate-500 flex flex-wrap gap-x-4 gap-y-1 mb-2">
                        <span>{new Date(imp.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                        <span>•</span>
                        <span>Preparation: <span className="font-medium text-slate-700" data-testid="import-preparation-state">{PREPARATION_LABELS[imp.preparation?.state] || 'Unknown'}</span>
                          {imp.preparation?.state === 'PREPARED' && ` · ${imp.preparation.counts?.questions ?? 0} questions · ${imp.preparation.counts?.open_blocking ?? 0} blocking items open`}</span>
                        <span>•</span>
                        <span className="font-mono text-xs">Import: {imp.id.substring(0, 8)}...</span>
                      </div>

                      {imp.status === 'REVIEW_CANDIDATES' && imp.candidate_count === 0 && !imp.preparation?.draft_paper_id && (
                        <div className="text-sm text-amber-700 bg-amber-50 px-3 py-1.5 rounded inline-flex items-center gap-2 mt-1">
                          <AlertCircle size={14} />
                          Preparation incomplete — no persisted candidates found.
                        </div>
                      )}
                    </div>
                    <button 
                      onClick={() => { setImportRecord(imp); setViewMode('VIEW'); }}
                      className="flex items-center gap-1 bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-lg font-medium hover:bg-slate-50 transition shrink-0"
                    >
                      Resume <ChevronRight size={16} />
                    </button>
                  </li>
                ))}
              </ul>
          )}
        </div>
        
        <div className="flex justify-end pt-2">
          <button 
            onClick={() => setViewMode('NEW')}
            className="flex items-center gap-2 bg-blue-600 text-white px-5 py-2.5 rounded-lg font-medium hover:bg-blue-700 transition"
          >
            <Plus size={18} /> New PDF Import
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold">Import PDF Question Paper</h2>
        <button 
          onClick={recentImports.length > 0 ? () => setViewMode('LIST') : onBack} 
          className="text-blue-700 underline"
        >
          {recentImports.length > 0 ? 'Cancel / Back to Recent Imports' : 'Back to Question Bank'}
        </button>
      </div>
      
      {error && (
        <div className="p-4 bg-red-50 text-red-700 border border-red-200 rounded-lg flex items-center gap-2">
          <AlertCircle size={18} /> {error}
        </div>
      )}
      
      <form onSubmit={handleStartImport} className="bg-white border rounded-xl p-6 shadow-sm space-y-6 max-w-3xl">
        <AcademicContext value={context} onChange={setContext} depth="level" syncUrl={false} />
        
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Test Type *</label>
            <select 
              className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-blue-500 outline-none"
              value={testType} 
              onChange={e=>setTestType(e.target.value)}
              required
            >
              {Object.entries(testTypes).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Duration (minutes)</label>
            <input 
              type="number" min="1"
              className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-blue-500 outline-none"
              value={duration} 
              onChange={e=>setDuration(e.target.value)}
              placeholder="e.g. 150"
            />
          </div>
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Test Name *</label>
          <input 
            type="text" 
            className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-blue-500 outline-none"
            value={testName} 
            onChange={e=>setTestName(e.target.value)}
            placeholder="e.g. SI/Constable Model Test"
            required
          />
        </div>
        
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-2">Source PDF *</label>
          <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center hover:bg-slate-50 transition relative">
            <input 
              type="file" 
              accept=".pdf,application/pdf"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f && f.type !== 'application/pdf' && !f.name.endsWith('.pdf')) {
                  setError('Only PDF files are allowed.')
                  e.target.value = ''
                  setFile(null)
                  return
                }
                setError(null)
                setFile(f || null)
              }}
              required
            />
            <FileText className="w-10 h-10 text-slate-400 mx-auto mb-3" />
            {file ? (
              <div className="text-slate-700 font-medium">{file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</div>
            ) : (
              <div>
                <span className="text-blue-600 font-medium">Choose PDF</span>
                <span className="text-slate-500 ml-1">or drag and drop</span>
              </div>
            )}
          </div>
        </div>
        
        <div className="pt-4 border-t border-slate-100 flex justify-end">
          <button 
            type="submit" 
            disabled={uploading}
            className="flex items-center gap-2 bg-blue-600 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-blue-700 transition disabled:opacity-70"
          >
            {uploading ? 'Uploading...' : <><Upload size={18} /> Start Import</>}
          </button>
        </div>
      </form>
    </div>
  )
}

function CheckCircle(props) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
}
