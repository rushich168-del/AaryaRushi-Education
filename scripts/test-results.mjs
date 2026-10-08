import { createClient } from '@supabase/supabase-js'
import { requireDisposableTestTarget } from './lib/live-test-guard.mjs'

// Fail-closed live-test guard (incident 2026-09-23): refuses KSC production, unknown, mismatched or
// unapproved targets BEFORE any auth, table or CLI call. See scripts/lib/live-test-guard.mjs.
const { url, key } = requireDisposableTestTarget({ script: 'test-results', usesLinkedCli: true })

async function run() {
  console.log('--- QA: RESULTS & PERFORMANCE ---')
  
  const supabaseTeacher = createClient(url, key)
  const teacherEmail = 'teacher_res_' + Date.now() + '@test.com'
  const { data: tData } = await supabaseTeacher.auth.signUp({ email: teacherEmail, password: 'Password123!' })
  const teacherId = tData.user.id
  
  const supabaseStudent = createClient(url, key)
  const studentEmail = 'student_res_' + Date.now() + '@test.com'
  const { data: sData } = await supabaseStudent.auth.signUp({ email: studentEmail, password: 'Password123!' })
  const studentId = sData.user.id

  import('child_process').then(({ execSync }) => {
    execSync(`npx supabase db query "INSERT INTO public.teacher_profiles (id, full_name, role) VALUES ('${teacherId}', 'Res Teacher', 'teacher');" --linked`)
    execSync(`npx supabase db query "INSERT INTO public.student_profiles (id, full_name) VALUES ('${studentId}', 'Res Student');" --linked`)
  })

  await new Promise(r => setTimeout(r, 4000))

  console.log('\n--- 1. EXAM SETUP ---')
  const { data: examData } = await supabaseTeacher.from('exams').insert({ name: 'Res Exam', slug: 'res-exam-' + Date.now() }).select().single()
  const { data: subjData } = await supabaseTeacher.from('exam_subjects').insert({ exam_id: examData.id, name: 'Res Math' }).select().single()
  const { data: patData } = await supabaseTeacher.from('exam_patterns').insert({ exam_id: examData.id, name: 'Res Pattern', status: 'ACTIVE', total_marks: 3, total_duration_minutes: 10 }).select().single()
  
  const { data: secData } = await supabaseTeacher.from('exam_pattern_sections').insert({
    pattern_id: patData.id, subject_id: subjData.id, section_name: 'Mathematics', question_count: 3, marks_per_question: 2, negative_marks: 0.5
  }).select().single()
  
  const qIds = []
  const correctOptionIds = []
  const incorrectOptionIds = []
  for (let i=1; i<=3; i++) {
    const { data: qData } = await supabaseTeacher.from('questions').insert({ exam_id: examData.id, subject_id: subjData.id, content: `Q${i}`, status: 'APPROVED' }).select().single()
    qIds.push(qData.id)
    const { data: oData } = await supabaseTeacher.from('question_options').insert([
      { question_id: qData.id, content: 'Opt A' }, { question_id: qData.id, content: 'Opt B' }
    ]).select()
    correctOptionIds.push(oData[0].id)
    incorrectOptionIds.push(oData[1].id)
    await supabaseTeacher.from('question_answer_keys').insert({ question_id: qData.id, correct_option_id: oData[0].id })
  }
  
  // Test 1: SUMMARY_ONLY
  const { data: test1Data } = await supabaseTeacher.from('tests').insert({
    exam_id: examData.id, pattern_id: patData.id, name: 'Res Test 1 (Summary)', status: 'DRAFT', is_published: false, review_policy: 'SUMMARY_ONLY'
  }).select().single()

  // Test 2: AFTER_SUBMISSION
  const { data: test2Data } = await supabaseTeacher.from('tests').insert({
    exam_id: examData.id, pattern_id: patData.id, name: 'Res Test 2 (Review)', status: 'DRAFT', is_published: false, review_policy: 'AFTER_SUBMISSION'
  }).select().single()

  for (let i=0; i<3; i++) {
    await supabaseTeacher.from('test_questions').insert({ test_id: test1Data.id, question_id: qIds[i], section_id: secData.id })
    await supabaseTeacher.from('test_questions').insert({ test_id: test2Data.id, question_id: qIds[i], section_id: secData.id })
  }
  await supabaseTeacher.rpc('publish_test', { p_test_id: test1Data.id })
  await supabaseTeacher.rpc('publish_test', { p_test_id: test2Data.id })

  const { data: optSnaps } = await supabaseTeacher.from('test_option_snapshots').select('*')
  const snapId = (tId, origId) => optSnaps.find(o => o.test_id === tId && o.original_option_id === origId)?.id || origId

  console.log('\n--- 2. EXPIRED OFFLINE QA ---')
  const { data: attempt1Id } = await supabaseStudent.rpc('start_test_attempt', { p_test_id: test1Data.id })
  await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attempt1Id, p_question_id: qIds[0], p_option_id: snapId(test1Data.id, correctOptionIds[0]), p_is_marked: false, p_clear: false })
  
  // Force expire in DB
  import('child_process').then(({ execSync }) => {
    execSync(`npx supabase db query "UPDATE public.test_attempts SET expires_at = NOW() - interval '1 hour' WHERE id = '${attempt1Id}';" --linked`)
  })
  await new Promise(r => setTimeout(r, 2000))

  // Run finalization RPC
  await supabaseTeacher.rpc('finalize_expired_attempts')
  
  const { data: final1 } = await supabaseTeacher.from('test_attempts').select('*').eq('id', attempt1Id).single()
  console.log('Expired attempt finalized automatically:', final1.status === 'SUBMITTED' ? 'PASS' : 'FAIL (' + final1.status + ')')
  console.log('Expired score correct:', final1.score === 2 ? 'PASS' : 'FAIL')

  console.log('\n--- 3. STUDENT REVIEW POLICY QA ---')
  const { error: rev1Err } = await supabaseStudent.rpc('get_attempt_review', { p_attempt_id: attempt1Id })
  console.log('SUMMARY_ONLY attempt detailed review:', rev1Err ? 'PASS (Denied)' : 'FAIL (Allowed)')

  const { data: attempt2Id } = await supabaseStudent.rpc('start_test_attempt', { p_test_id: test2Data.id })
  await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attempt2Id, p_question_id: qIds[0], p_option_id: snapId(test2Data.id, correctOptionIds[0]), p_is_marked: false, p_clear: false })
  await supabaseStudent.rpc('submit_test_attempt', { p_attempt_id: attempt2Id })
  
  const { data: rev2Data, error: rev2Err } = await supabaseStudent.rpc('get_attempt_review', { p_attempt_id: attempt2Id })
  if (rev2Err) console.error("REV2 ERR:", rev2Err)
  console.log('AFTER_SUBMISSION attempt detailed review:', !rev2Err && rev2Data.length === 3 ? 'PASS (Allowed)' : 'FAIL')

  console.log('\n--- 4. SECTION PERFORMANCE QA ---')
  const { data: secPerf, error: secErr } = await supabaseStudent.rpc('get_attempt_section_performance', { p_attempt_id: attempt2Id })
  if (secErr) console.error("SEC ERR:", secErr)
  
  if (secPerf && secPerf.length > 0) {
    const perf = secPerf[0]
    console.log('Section performance rows:', secPerf.length === 1 ? 'PASS' : 'FAIL')
    console.log('Section correct:', perf.correct_count === 1 ? 'PASS' : 'FAIL')
    console.log('Section score:', parseFloat(perf.score) === 2 ? 'PASS' : 'FAIL')
  } else {
    console.log("Section performance QA failed, secPerf is null/empty")
  }
  
  console.log('\n--- QA COMPLETE ---')
}

run().catch(console.error)
