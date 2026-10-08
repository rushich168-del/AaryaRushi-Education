import { supabase } from '../lib/supabaseClient.js'
import { inTeacherWorkspace, teacherCourse } from './staffAccountService.js'
const unwrap = async request => {
  const { data, error } = await request
  if (error) {
    if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(error.code)) throw new Error('Paper-to-test publishing is not enabled yet. Ask your administrator to apply the paper-to-test update; keep this tab open to preserve your preview.')
    throw error
  }
  return data
}
export const printedPaperService = {
  list: () => inTeacherWorkspace() ? unwrap(supabase.rpc('ksc_staff_paper_list', {p_course:teacherCourse()})) : unwrap(supabase.from('printed_papers').select('id,metadata,test_id,revision,updated_at').order('updated_at', { ascending: false }).limit(20)),
  async load(id) {
    if (inTeacherWorkspace()) return unwrap(supabase.rpc('ksc_staff_paper_load', {p_course:teacherCourse(),p_id:id}))
    const paper = await unwrap(supabase.from('printed_papers').select('*').eq('id', id).single())
    const rows = await unwrap(supabase.from('printed_paper_questions').select('position,question').eq('paper_id', id).order('position').limit(500))
    return { paper, questions: rows.map(r => r.question) }
  },
  save: (paper, metadata, questions) => unwrap(supabase.rpc(inTeacherWorkspace() ? 'ksc_staff_paper_save' : 'ksc_save_printed_paper', { ...(inTeacherWorkspace() ? {p_course:teacherCourse()} : {}), p_id: paper?.id || null, p_revision: paper?.revision ?? null, p_metadata: metadata, p_questions: questions })),
  publish: paper => unwrap(supabase.rpc(inTeacherWorkspace() ? 'ksc_staff_paper_publish' : 'ksc_publish_printed_paper', { ...(inTeacherWorkspace() ? {p_course:teacherCourse()} : {}), p_id: paper.id, p_revision: paper.revision, p_reviewed: true })),
}
