import { createClient } from '@supabase/supabase-js'
import { requireDisposableTestTarget } from './lib/live-test-guard.mjs'

// Fail-closed live-test guard (incident 2026-09-23): refuses KSC production, unknown, mismatched or
// unapproved targets BEFORE any auth, table or CLI call. See scripts/lib/live-test-guard.mjs.
const { url, key } = requireDisposableTestTarget({ script: 'test-qb', usesLinkedCli: true })

async function run() {
  console.log('--- QA: QUESTION BANK WORKFLOW ---')
  
  // Login with existing test users or create new if not available.
  // Wait, I can just signup new ones to guarantee fresh state.
  const supabaseTeacher = createClient(url, key)
  const teacherEmail = 'teacher_qb_' + Date.now() + '@test.com'
  const { data: tData } = await supabaseTeacher.auth.signUp({ email: teacherEmail, password: 'Password123!' })
  const teacherId = tData.user.id
  
  import('child_process').then(({ execSync }) => {
    execSync(`npx supabase db query "INSERT INTO public.teacher_profiles (id, full_name, role) VALUES ('${teacherId}', 'QB Teacher', 'teacher');" --linked`)
    console.log('Teacher Profile created')
  })

  const supabaseStudent = createClient(url, key)
  const studentEmail = 'student_qb_' + Date.now() + '@test.com'
  const { data: sData } = await supabaseStudent.auth.signUp({ email: studentEmail, password: 'Password123!' })
  const studentId = sData.user.id

  import('child_process').then(({ execSync }) => {
    execSync(`npx supabase db query "INSERT INTO public.student_profiles (id, full_name) VALUES ('${studentId}', 'QB Student');" --linked`)
    console.log('Student Profile created')
  })

  // We need an Exam and Subject
  const { data: examData } = await supabaseTeacher.from('exams').insert({ name: 'QB Exam', slug: 'qb-exam-' + Date.now() }).select().single()
  const { data: subjData } = await supabaseTeacher.from('exam_subjects').insert({ exam_id: examData.id, name: 'QB Math' }).select().single()

  console.log('\n--- 1. TEACHER AUTHORING ---')
  // Create Question
  const { data: qData, error: qErr } = await supabaseTeacher.from('questions').insert({
    exam_id: examData.id, subject_id: subjData.id, content: 'If $2x + 3 = 11$, what is the value of $x$?', status: 'DRAFT', difficulty: 'MEDIUM'
  }).select().single()
  console.log('Insert Question:', qErr ? 'FAIL: ' + qErr.message : 'PASS')

  // Options
  const { data: optData, error: oErr } = await supabaseTeacher.from('question_options').insert([
    { question_id: qData.id, content: '2', sort_order: 0 },
    { question_id: qData.id, content: '3', sort_order: 1 },
    { question_id: qData.id, content: '4', sort_order: 2 }, // Correct
    { question_id: qData.id, content: '5', sort_order: 3 }
  ]).select()
  console.log('Insert Options:', oErr ? 'FAIL: ' + oErr.message : 'PASS')

  // Answer Key
  const correctOptId = optData.find(o => o.content === '4').id
  const { error: kErr } = await supabaseTeacher.from('question_answer_keys').insert({
    question_id: qData.id, correct_option_id: correctOptId
  })
  console.log('Insert Answer Key:', kErr ? 'FAIL: ' + kErr.message : 'PASS')

  console.log('\n--- 2. STUDENT PENETRATION ---')
  // Try to read DRAFT question
  const { data: sQ } = await supabaseStudent.from('questions').select('*').eq('id', qData.id)
  console.log('Student read DRAFT question (Expect empty):', sQ && sQ.length === 0 ? 'PASS' : 'FAIL')

  // Try to insert question
  const { error: sInsErr } = await supabaseStudent.from('questions').insert({ content: 'Hack' })
  console.log('Student insert question (Expect Denied):', sInsErr ? 'PASS (Denied)' : 'FAIL')

  // Try to read answer keys
  const { data: sKeys } = await supabaseStudent.from('question_answer_keys').select('*').eq('question_id', qData.id)
  console.log('Student read Answer Keys (Expect empty):', sKeys && sKeys.length === 0 ? 'PASS' : 'FAIL')

  console.log('\n--- 3. TEACHER REVIEW/APPROVE ---')
  const { error: appErr } = await supabaseTeacher.from('questions').update({ status: 'APPROVED' }).eq('id', qData.id)
  console.log('Teacher Approve Question:', appErr ? 'FAIL: ' + appErr.message : 'PASS')

  // Even approved, student can't see it until it's in a published test
  const { data: sQ2 } = await supabaseStudent.from('questions').select('*').eq('id', qData.id)
  console.log('Student read APPROVED (unpublished) question (Expect empty):', sQ2 && sQ2.length === 0 ? 'PASS' : 'FAIL')

  console.log('\n--- QA COMPLETE ---')
}

// Timeout to allow profile insertion to finish via execSync
setTimeout(() => run().catch(console.error), 2000)
