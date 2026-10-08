// B4.7 preparation stages (shared by the orchestrator, the teacher UI and the tests). Tiny on purpose:
// the UI imports this eagerly, while the pipeline itself is loaded only when preparation starts.
export const STAGES = Object.freeze([
  { key: 'READING_PAPER', label: 'Reading paper' },
  { key: 'DETECTING_QUESTIONS', label: 'Detecting questions, shared materials and answer key' },
  { key: 'DETECTING_FIGURES', label: 'Detecting figures' },
  { key: 'READING_TELUGU', label: 'Reading Telugu' },
  { key: 'SAVING_DRAFT', label: 'Saving the prepared Draft' },
  { key: 'PREPARING_REVIEW', label: 'Preparing review' },
  { key: 'COMPLETE', label: 'Complete' },
])
export const stageLabel = key => STAGES.find(s => s.key === key)?.label || key
