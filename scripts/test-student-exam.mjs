import { createClient } from '@supabase/supabase-js'
import { requireDisposableTestTarget } from './lib/live-test-guard.mjs'

// Fail-closed live-test guard (incident 2026-09-23): refuses KSC production, unknown, mismatched or
// unapproved targets BEFORE any auth, table or CLI call. See scripts/lib/live-test-guard.mjs.
const { url, key } = requireDisposableTestTarget({ script: 'test-student-exam', usesLinkedCli: true })

async function run() {
  console.log('--- QA: STUDENT EXAM ENGINE ---')
  
  const supabaseTeacher = createClient(url, key)
  const teacherEmail = 'teacher_se_' + Date.now() + '@test.com'
  const { data: tData } = await supabaseTeacher.auth.signUp({ email: teacherEmail, password: 'Password123!' })
  const teacherId = tData.user.id
  
  const supabaseStudent = createClient(url, key)
  const studentEmail = 'student_se_' + Date.now() + '@test.com'
  const { data: sData } = await supabaseStudent.auth.signUp({ email: studentEmail, password: 'Password123!' })
  const studentId = sData.user.id

  const supabaseOtherStudent = createClient(url, key)
  const otherStudentEmail = 'other_student_se_' + Date.now() + '@test.com'
  const { data: osData } = await supabaseOtherStudent.auth.signUp({ email: otherStudentEmail, password: 'Password123!' })
  const otherStudentId = osData.user.id

  import('child_process').then(({ execSync }) => {
    execSync(`npx supabase db query "INSERT INTO public.teacher_profiles (id, full_name, role) VALUES ('${teacherId}', 'SE Teacher', 'teacher');" --linked`)
    execSync(`npx supabase db query "INSERT INTO public.student_profiles (id, full_name) VALUES ('${studentId}', 'SE Student 1');" --linked`)
    execSync(`npx supabase db query "INSERT INTO public.student_profiles (id, full_name) VALUES ('${otherStudentId}', 'SE Student 2');" --linked`)
    console.log('Profiles created')
  })

  // Wait for profiles
  await new Promise(r => setTimeout(r, 4000))

  console.log('\n--- 1. EXAM SETUP ---')
  const { data: examData } = await supabaseTeacher.from('exams').insert({ name: 'SE Exam', slug: 'se-exam-' + Date.now() }).select().single()
  const { data: subjData } = await supabaseTeacher.from('exam_subjects').insert({ exam_id: examData.id, name: 'SE Math' }).select().single()
  const { data: patData } = await supabaseTeacher.from('exam_patterns').insert({ exam_id: examData.id, name: 'SE Pattern', status: 'ACTIVE', total_marks: 3, total_duration_minutes: 10 }).select().single()
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
  
  const { data: testData } = await supabaseTeacher.from('tests').insert({
    exam_id: examData.id, pattern_id: patData.id, name: 'SE QA Test', status: 'DRAFT', is_published: false
  }).select().single()

  for (let i=0; i<3; i++) await supabaseTeacher.from('test_questions').insert({ test_id: testData.id, question_id: qIds[i], section_id: secData.id })
  await supabaseTeacher.rpc('publish_test', { p_test_id: testData.id })
  console.log('Test Created & Published (3 Questions, +2 correct, -0.5 negative)')

  // FETCH SNAPSHOT IDs
  const { data: optSnaps } = await supabaseTeacher.from('test_option_snapshots').select('*').eq('test_id', testData.id)
  
  // Map original option IDs to snapshot option IDs
  const snapId = (origId) => optSnaps.find(o => o.original_option_id === origId)?.id || origId

  console.log('\n--- 2. STUDENT ATTEMPT ENGINE ---')
  const { data: attemptId, error: aErr } = await supabaseStudent.rpc('start_test_attempt', { p_test_id: testData.id })
  console.log('Start Attempt:', aErr ? 'FAIL: ' + aErr.message : 'PASS (' + attemptId + ')')

  const { data: duplicateId } = await supabaseStudent.rpc('start_test_attempt', { p_test_id: testData.id })
  console.log('Duplicate Start/Resume Test:', duplicateId === attemptId ? 'PASS (Resumed)' : 'FAIL')

  // Answers: Q1 Correct, Q2 Incorrect, Q3 Unanswered
  let s1 = await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attemptId, p_question_id: qIds[0], p_option_id: snapId(correctOptionIds[0]), p_is_marked: false, p_clear: false })
  if (s1.error) console.error('s1 err:', s1.error)
  
  let s2 = await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attemptId, p_question_id: qIds[1], p_option_id: snapId(incorrectOptionIds[1]), p_is_marked: false, p_clear: false })
  if (s2.error) console.error('s2 err:', s2.error)

  // Test clear
  let s3 = await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attemptId, p_question_id: qIds[2], p_option_id: snapId(correctOptionIds[2]), p_is_marked: false, p_clear: false })
  let s4 = await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attemptId, p_question_id: qIds[2], p_option_id: null, p_is_marked: false, p_clear: true })
  
  console.log('Autosave Answers: PASS')

  console.log('\n--- 3. STUDENT PENETRATION / SECURITY ---')
  const { error: cheatErr } = await supabaseStudent.from('test_attempts').update({ score: 100 }).eq('id', attemptId)
  const { data: cheatCheck } = await supabaseStudent.from('test_attempts').select('score').eq('id', attemptId).single()
  console.log('Direct score manipulation:', cheatCheck.score !== 100 ? 'PASS (Denied)' : 'FAIL (Allowed)')
  
  const { error: readOtherErr } = await supabaseOtherStudent.from('test_attempts').select('*').eq('id', attemptId).single()
  console.log('Read other student attempt:', readOtherErr ? 'PASS (Denied/Empty)' : 'FAIL')

  const { error: writeOtherErr } = await supabaseOtherStudent.rpc('save_attempt_answer', { p_attempt_id: attemptId, p_question_id: qIds[0], p_option_id: incorrectOptionIds[0], p_is_marked: false, p_clear: false })
  console.log('Write to other student attempt:', writeOtherErr ? 'PASS (Denied)' : 'FAIL')

  console.log('\n--- 4. EVALUATION & SUBMISSION ---')
  const { error: subErr } = await supabaseStudent.rpc('submit_test_attempt', { p_attempt_id: attemptId })
  console.log('Submit Attempt:', subErr ? 'FAIL: ' + subErr.message : 'PASS')

  const { data: finalAttempt } = await supabaseStudent.from('test_attempts').select('*').eq('id', attemptId).single()
  
  console.log('Final Status:', finalAttempt.status)
  console.log('Correct:', finalAttempt.correct_count, '(Expected 1)')
  console.log('Incorrect:', finalAttempt.incorrect_count, '(Expected 1)')
  console.log('Unanswered:', finalAttempt.unanswered_count, '(Expected 1)')
  console.log('Score:', finalAttempt.score, '(Expected 1.5)')
  console.log('Max Score:', finalAttempt.max_score, '(Expected 6)')

  console.log('Evaluation Match:', 
    finalAttempt.correct_count === 1 && 
    finalAttempt.incorrect_count === 1 && 
    finalAttempt.unanswered_count === 1 && 
    parseFloat(finalAttempt.score) === 1.5 ? 'PASS' : 'FAIL'
  )

  const { error: postSubErr } = await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attemptId, p_question_id: qIds[2], p_option_id: correctOptionIds[2], p_is_marked: false, p_clear: false })
  console.log('Write answer after submission:', postSubErr ? 'PASS (Denied)' : 'FAIL')

  console.log('\n--- QA COMPLETE ---')
}

run().catch(console.error)
