import { planDraftEdit, resolveSlotOptionId } from './draftPaperMapping.js'

// Repeat-safe saving for the Draft question edit card.
// Kept free of React/Supabase so it can be unit-tested with fakes.

// Runs at most one async task at a time. A call made while a task is running is
// ignored (returns null) instead of starting a second, overlapping save.
export function createSingleFlight() {
  let running = null
  return {
    get busy() { return running !== null },
    run(task) {
      if (running) return null
      running = (async () => {
        try { return await task() } finally { running = null }
      })()
      return running
    },
  }
}

// Save one edit. Option rows are re-read from the database immediately before
// planning, so slots filled by an earlier (possibly partially failed) save are
// updated rather than inserted again. An answer is confirmed only when the
// teacher explicitly chose one in this edit.
//   service: { getDraftOptions, updateDraftQuestionText, updateDraftOptionText,
//              insertDraftOption, confirmSingleChoice }
export async function saveDraftQuestionEdit({ questionId, form, service }) {
  const rows = await service.getDraftOptions(questionId)
  const plan = planDraftEdit({
    rows,
    formOptions: form.options || [],
    selectedSlot: form.selectedSlot,
    answerChosen: form.answerChosen,
  })
  // Never pick one of several competing rows for a slot: refuse and write nothing.
  if (plan.conflicts.length) return { status: 'SLOT_CONFLICT', plan }
  if (plan.blankedExisting.length) return { status: 'BLANK_EXISTING', plan }
  if (plan.confirmBlocked) return { status: 'CONFIRM_BLOCKED', plan }

  await service.updateDraftQuestionText(questionId, form.question_text)
  for (const u of plan.updates) {
    await service.updateDraftOptionText(u.id, u.content)
  }
  const inserted = []
  for (const ins of plan.inserts) {
    inserted.push(await service.insertDraftOption(questionId, ins.position, ins.content))
  }
  if (plan.confirmSlot !== null) {
    const optionId = resolveSlotOptionId(plan.confirmSlot, rows, inserted)
    if (optionId) await service.confirmSingleChoice(questionId, optionId)
  }
  return { status: 'SAVED', plan, inserted }
}
