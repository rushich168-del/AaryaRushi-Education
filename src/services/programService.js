import { supabase } from '../lib/supabaseClient.js'
import { inTeacherWorkspace, teacherCourse } from './staffAccountService.js'

async function rows(table, columns = '*') {
  const result = []
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from(table).select(columns).order('id').range(offset, offset + 499)
    if (error) throw error
    result.push(...(data || []))
    if (!data || data.length < 500) return result
  }
}
async function unwrap(request) { const { data, error } = await request; if (error) throw error; return data }
export const emptyAcademicContext = { exam_id: '', level_id: '', subject_id: '', syllabus_id: '', chapter_id: '', topic_id: '' }
export function contextFromUrl() {
  const params = new URLSearchParams(window.location.search)
  return Object.fromEntries(Object.keys(emptyAcademicContext).map(key => [key, params.get(key) || '']))
}
export function contextQuery(context) {
  return new URLSearchParams(Object.entries(context).filter(([key, value]) => key in emptyAcademicContext && value)).toString()
}
export const testKinds = { GENERAL: 'General tests', FULL_MOCK: 'Full mock tests', SUBJECT: 'Subject tests', CHAPTER: 'Chapter / topic practice', MODEL: 'Model papers', PREVIOUS: 'Previous papers' }
export const programService = {
  async ensurePaperSubject(examId) {
    if (inTeacherWorkspace()) return unwrap(supabase.rpc('ksc_staff_paper_subject', {p_course:teacherCourse(),p_exam:examId}))
    const name = 'General / mixed subjects'
    const subjects = await unwrap(supabase.from('exam_subjects').select('id,name').eq('exam_id', examId))
    const existing = subjects.find(row => row.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing.id
    const subject = await this.create('exam_subjects', { exam_id: examId, name })
    return subject.id
  },
  async catalogue() {
    let [categories, exams, levels, subjects, syllabi, chapters, topics] = await Promise.all([
      rows('program_categories'), rows('exams'), rows('exam_levels'), rows('exam_subjects'), rows('syllabi'), rows('chapters'), rows('topics'),
    ])
    if (inTeacherWorkspace() && teacherCourse()) {
      const links = await this.courseTracks()
      const permittedLevels = new Set(links.filter(link => link.course_id === teacherCourse()).map(link => link.level_id))
      levels = levels.filter(level => permittedLevels.has(level.id))
      const permittedExams = new Set(levels.map(level => level.exam_id))
      exams = exams.filter(exam => permittedExams.has(exam.id))
      subjects = subjects.filter(subject => permittedExams.has(subject.exam_id))
      syllabi = syllabi.filter(syllabus => permittedLevels.has(syllabus.level_id))
      const syllabusIds = new Set(syllabi.map(syllabus => syllabus.id))
      chapters = chapters.filter(chapter => syllabusIds.has(chapter.syllabus_id))
      const chapterIds = new Set(chapters.map(chapter => chapter.id))
      topics = topics.filter(topic => chapterIds.has(topic.chapter_id))
      categories = categories.filter(category => exams.some(exam => exam.category_id === category.id))
    }
    return { categories: categories.sort((a,b)=>a.display_order-b.display_order), exams, levels, subjects, syllabi, chapters, topics }
  },
  async myTracks(userId) {
    // Courses can also be visible to staff. Explicit enrollments ensure "My" means enrolled.
    const enrollments = await unwrap(supabase.from('ksc_enrollments').select('batch_id,ksc_batches(course_id)').eq('student_id', userId))
    const courseIds = [...new Set((enrollments || []).map(e=>e.ksc_batches?.course_id).filter(Boolean))]
    if (!courseIds.length) return []
    return unwrap(supabase.from('ksc_course_tracks').select('course_id,level_id').in('course_id',courseIds))
  },
  courseTracks: () => unwrap(supabase.from('ksc_course_tracks').select('course_id,level_id')),
  linkCourse: (course_id, level_id) => unwrap(supabase.from('ksc_course_tracks').insert({course_id,level_id})),
  unlinkCourse: (course_id, level_id) => unwrap(supabase.from('ksc_course_tracks').delete().eq('course_id',course_id).eq('level_id',level_id)),
  create: (table, values) => {
    if (!['program_categories','exams','exam_levels','exam_subjects','syllabi','chapters','topics'].includes(table)) throw new Error('Unsupported curriculum entity')
    return unwrap(supabase.from(table).insert(values).select().single())
  },
}
