import { supabase } from '../lib/supabaseClient.js'
async function result(request) { const {data,error}=await request; if(error) throw error; return data }
export const learningService = {
  teachingCourses: () => result(supabase.rpc('ksc_teaching_courses')),
  courses: () => result(supabase.from('ksc_courses').select('*').order('created_at')),
  programCourses: level => result(supabase.from('ksc_courses').select('*,ksc_course_tracks!inner(level_id)').eq('ksc_course_tracks.level_id',level).order('created_at')),
  institutes: () => result(supabase.from('ksc_institutes').select('*').order('name')),
  lessons: course => result(supabase.from('ksc_lessons').select('*').eq('course_id',course).order('sort_order').order('id')),
  batches: course => result(supabase.from('ksc_batches').select('*').eq('course_id',course).order('created_at')),
  completions: user => result(supabase.from('ksc_lesson_completions').select('*').eq('student_id',user)),
  progress: () => result(supabase.from('ksc_lesson_completions').select('*')),
  async students() {
    const [profiles,staff] = await Promise.all([
      result(supabase.from('student_profiles').select('id,full_name').order('full_name')),
      result(supabase.from('ksc_staff_access').select('user_id,role')),
    ])
    const staffIds=new Set(staff.filter(p=>['admin','teacher','creator'].includes(p.role)).map(p=>p.user_id))
    return profiles.filter(p=>!staffIds.has(p.id))
  },
  roster: batch => result(supabase.from('ksc_enrollments').select('student_id, student_profiles(full_name)').eq('batch_id',batch)),
  async confirmedLearner(email) {
    const id = await result(supabase.rpc('ksc_staff_lookup_existing', {p_email:email.trim().toLowerCase()}))
    const profile = await result(supabase.from('student_profiles').select('id,full_name').eq('id',id).single())
    if (!profile) throw new Error('This confirmed account does not have a student profile.')
    return {...profile,email:email.trim().toLowerCase()}
  },
  createCourse: (institute,name,description) => result(supabase.rpc('ksc_create_course',{p_institute:institute,p_name:name,p_description:description})),
  createBatch: (course,name) => result(supabase.rpc('ksc_create_batch',{p_course:course,p_name:name})),
  enroll: (batch,email,remove=false) => result(supabase.rpc('ksc_enroll_student',{p_batch:batch,p_email:email,p_remove:remove})),
  saveLesson: (course,lesson) => result(supabase.rpc('ksc_save_lesson',{p_id:lesson.id || null,p_course:course,p_title:lesson.title,p_body:lesson.body,p_order:Number(lesson.sort_order)||0,p_published:lesson.is_published})),
  complete: lesson => result(supabase.rpc('ksc_complete_lesson',{p_lesson:lesson})),
}
