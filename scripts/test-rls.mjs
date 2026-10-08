import { createClient } from '@supabase/supabase-js'
import { requireDisposableTestTarget } from './lib/live-test-guard.mjs'
import { execSync } from 'child_process'

// Fail-closed live-test guard (incident 2026-09-23): refuses KSC production, unknown, mismatched or
// unapproved targets BEFORE any auth, table or CLI call. See scripts/lib/live-test-guard.mjs.
const { url, key } = requireDisposableTestTarget({ script: 'test-rls', usesLinkedCli: true })

async function run() {
  console.log('--- STARTING QA SCRIPT ---')

  // 1. Create Teacher
  const supabaseTeacher = createClient(url, key)
  const teacherEmail = 'teacher_' + Date.now() + '@test.com'
  const { data: teacherData, error: tErr } = await supabaseTeacher.auth.signUp({
    email: teacherEmail, password: 'Password123!'
  })
  if (tErr) throw tErr
  const teacherId = teacherData.user.id
  console.log('Created Teacher Auth:', teacherId)

  // Force insert teacher profile
  execSync(`npx supabase db query "INSERT INTO public.teacher_profiles (id, full_name, role) VALUES ('${teacherId}', 'QA Teacher', 'teacher');" --linked`)
  console.log('Inserted Teacher Profile directly')

  // 2. Create Student
  const supabaseStudent = createClient(url, key)
  const studentEmail = 'student_' + Date.now() + '@test.com'
  const { data: studentData, error: sErr } = await supabaseStudent.auth.signUp({
    email: studentEmail, password: 'Password123!'
  })
  if (sErr) throw sErr
  const studentId = studentData.user.id
  console.log('Created Student Auth:', studentId)

  // Force insert student profile
  execSync(`npx supabase db query "INSERT INTO public.student_profiles (id, full_name, class_standard) VALUES ('${studentId}', 'QA Student', 'Class 6');" --linked`)
  console.log('Inserted Student Profile directly')

  console.log('\n--- VERIFY TEACHER CRUD ---')
  // Teacher: Insert Exam
  const { data: examData, error: examErr } = await supabaseTeacher.from('exams').insert({
    name: 'QA Test Exam', slug: 'qa-test-exam-' + Date.now(), target_class: 'QA'
  }).select().single()
  console.log('Teacher Insert Exam:', examErr ? 'FAILED: ' + examErr.message : 'PASS')
  
  // Teacher: Update Exam
  const { error: examUpdErr } = await supabaseTeacher.from('exams').update({ description: 'Updated' }).eq('id', examData.id)
  console.log('Teacher Update Exam:', examUpdErr ? 'FAILED: ' + examUpdErr.message : 'PASS')

  // Teacher: Insert Subject
  const { data: subjData, error: subjErr } = await supabaseTeacher.from('exam_subjects').insert({
    exam_id: examData.id, name: 'QA Mathematics'
  }).select().single()
  console.log('Teacher Insert Subject:', subjErr ? 'FAILED: ' + subjErr.message : 'PASS')

  // Teacher: Update Subject
  const { error: subjUpdErr } = await supabaseTeacher.from('exam_subjects').update({ description: 'Math updated' }).eq('id', subjData.id)
  console.log('Teacher Update Subject:', subjUpdErr ? 'FAILED: ' + subjUpdErr.message : 'PASS')

  console.log('\n--- VERIFY STUDENT SECURITY ---')
  // Student: Try to insert Exam
  const { error: sExamErr } = await supabaseStudent.from('exams').insert({
    name: 'Student Hack', slug: 'hack'
  })
  console.log('Student Insert Exam (Expect Denied):', sExamErr && sExamErr.code === '42501' ? 'PASS (Denied)' : 'FAIL: ' + (sExamErr ? sExamErr.message : 'Allowed'))

  // Student: Try to insert Subject
  const { error: sSubjErr } = await supabaseStudent.from('exam_subjects').insert({
    exam_id: examData.id, name: 'Student Hack'
  })
  console.log('Student Insert Subject (Expect Denied):', sSubjErr && sSubjErr.code === '42501' ? 'PASS (Denied)' : 'FAIL: ' + (sSubjErr ? sSubjErr.message : 'Allowed'))

  // Student: Try to update Exam
  const { error: sExamUpdErr } = await supabaseStudent.from('exams').update({ description: 'Hack' }).eq('id', examData.id)
  console.log('Student Update Exam (Expect Denied/Empty):', sExamUpdErr ? 'Error: ' + sExamUpdErr.message : 'No error, but rows affected: 0 (RLS silent deny)')

  // Student: Try to delete Exam
  const { error: sExamDelErr } = await supabaseStudent.from('exams').delete().eq('id', examData.id)
  console.log('Student Delete Exam (Expect Denied/Empty):', sExamDelErr ? 'Error: ' + sExamDelErr.message : 'No error, but rows affected: 0 (RLS silent deny)')

  console.log('\n--- VERIFY ANSWER KEY PENETRATION ---')
  const { data: keysData, error: keysErr } = await supabaseStudent.from('question_answer_keys').select('*')
  console.log('Student Select Answer Keys (Expect Denied/Empty):', keysErr ? 'Denied: ' + keysErr.message : (keysData.length === 0 ? 'PASS (Returns empty)' : 'FAIL (Keys visible)'))

  console.log('\n--- VERIFY DRAFT QUESTION VISIBILITY ---')
  // Create Draft Question as Teacher
  const { data: qData, error: qErr } = await supabaseTeacher.from('questions').insert({
    exam_id: examData.id, subject_id: subjData.id, content: 'What is 2+2?', status: 'DRAFT', difficulty: 'EASY'
  }).select().single()
  console.log('Teacher Insert Draft Question:', qErr ? 'FAILED: ' + qErr.message : 'PASS')

  const { data: sQData, error: sQErr } = await supabaseStudent.from('questions').select('*').eq('id', qData.id)
  console.log('Student Read Draft Question (Expect Empty):', sQData && sQData.length === 0 ? 'PASS (Empty)' : 'FAIL (Visible)')

  // Create Published Test & Question
  const { data: testData } = await supabaseTeacher.from('tests').insert({
    exam_id: examData.id, name: 'QA Test 1', is_published: true
  }).select().single()

  const { data: qAppr } = await supabaseTeacher.from('questions').insert({
    exam_id: examData.id, subject_id: subjData.id, content: 'What is 3+3?', status: 'APPROVED', difficulty: 'EASY'
  }).select().single()

  await supabaseTeacher.from('test_questions').insert({
    test_id: testData.id, question_id: qAppr.id
  })
  console.log('Teacher created Approved Question & Published Test: PASS')

  const { data: sQApprData } = await supabaseStudent.from('questions').select('*').eq('id', qAppr.id)
  console.log('Student Read Approved Published Question (Expect Visible):', sQApprData && sQApprData.length === 1 ? 'PASS (Visible)' : 'FAIL (Empty)')

  console.log('\n--- VERIFY is_teacher() RPC ---')
  const { data: tRpc } = await supabaseTeacher.rpc('is_teacher')
  console.log('Teacher is_teacher():', tRpc === true ? 'PASS' : 'FAIL')

  const { data: sRpc } = await supabaseStudent.rpc('is_teacher')
  console.log('Student is_teacher():', sRpc === false ? 'PASS' : 'FAIL')

  const supabaseAnon = createClient(url, key)
  const { data: aRpc } = await supabaseAnon.rpc('is_teacher')
  console.log('Anon is_teacher():', aRpc === false ? 'PASS' : 'FAIL')

  // Clean up
  console.log('\n--- CLEANING UP ---')
  await supabaseTeacher.from('exams').delete().eq('id', examData.id)
  console.log('Cleanup complete.')
}
run()
