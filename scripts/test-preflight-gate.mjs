import { createClient } from '@supabase/supabase-js'
import { requireDisposableTestTarget } from './lib/live-test-guard.mjs'

// Fail-closed live-test guard (incident 2026-09-23): refuses KSC production, unknown, mismatched or
// unapproved targets BEFORE any auth, table or CLI call. See scripts/lib/live-test-guard.mjs.
const { url, key } = requireDisposableTestTarget({ script: 'test-preflight-gate', usesLinkedCli: true })

async function run() {
  console.log('--- PRE-FLIGHT QA GATE: SECTION SCORING ---')
  const supabaseTeacher = createClient(url, key)
  const teacherEmail = 'teacher_pf_' + Date.now() + '@test.com'
  const { data: tData } = await supabaseTeacher.auth.signUp({ email: teacherEmail, password: 'Password123!' })
  const teacherId = tData.user.id
  
  const supabaseStudent = createClient(url, key)
  const studentEmail = 'student_pf_' + Date.now() + '@test.com'
  const { data: sData } = await supabaseStudent.auth.signUp({ email: studentEmail, password: 'Password123!' })
  const studentId = sData.user.id

  import('child_process').then(({ execSync }) => {
    execSync(`npx supabase db query "INSERT INTO public.teacher_profiles (id, full_name, role) VALUES ('${teacherId}', 'PF Teacher', 'teacher');" --linked`)
    execSync(`npx supabase db query "INSERT INTO public.student_profiles (id, full_name) VALUES ('${studentId}', 'PF Student');" --linked`)
  })

  await new Promise(r => setTimeout(r, 4000))

  const { data: examData } = await supabaseTeacher.from('exams').insert({ name: 'PF Exam', slug: 'pf-exam-' + Date.now() }).select().single()
  const { data: subjData } = await supabaseTeacher.from('exam_subjects').insert({ exam_id: examData.id, name: 'PF Math' }).select().single()
  const { data: patData } = await supabaseTeacher.from('exam_patterns').insert({ exam_id: examData.id, name: 'PF Pattern', status: 'ACTIVE', total_marks: 3, total_duration_minutes: 10 }).select().single()
  
  const { data: secData } = await supabaseTeacher.from('exam_pattern_sections').insert({
    pattern_id: patData.id, subject_id: subjData.id, section_name: 'Mathematics', question_count: 3, marks_per_question: 2, negative_marks: 0.5
  }).select().single()
  
  const qIds = [], correctOptionIds = [], incorrectOptionIds = []
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
    exam_id: examData.id, pattern_id: patData.id, name: 'PF Test', status: 'DRAFT', is_published: false
  }).select().single()

  for (let i=0; i<3; i++) await supabaseTeacher.from('test_questions').insert({ test_id: testData.id, question_id: qIds[i], section_id: secData.id })
  await supabaseTeacher.rpc('publish_test', { p_test_id: testData.id })

  const { data: optSnaps } = await supabaseTeacher.from('test_option_snapshots').select('*').eq('test_id', testData.id)
  const snapId = (origId) => optSnaps.find(o => o.original_option_id === origId)?.id || origId

  const { data: attemptId } = await supabaseStudent.rpc('start_test_attempt', { p_test_id: testData.id })
  
  // Q1: Correct (+2)
  await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attemptId, p_question_id: qIds[0], p_option_id: snapId(correctOptionIds[0]), p_is_marked: false, p_clear: false })
  // Q2: Incorrect (-0.5)
  await supabaseStudent.rpc('save_attempt_answer', { p_attempt_id: attemptId, p_question_id: qIds[1], p_option_id: snapId(incorrectOptionIds[1]), p_is_marked: false, p_clear: false })
  // Q3: Unanswered (0)
  
  await supabaseStudent.rpc('submit_test_attempt', { p_attempt_id: attemptId })
  
  const { data: secPerf } = await supabaseStudent.rpc('get_attempt_section_performance', { p_attempt_id: attemptId })
  const perf = secPerf[0]
  
  console.log('Expected section score: 1.5')
  console.log('Actual section score:', parseFloat(perf.score))
  console.log('Correct:', perf.correct_count, '| Expected: 1')
  console.log('Incorrect:', perf.incorrect_count, '| Expected: 1')
  console.log('Unanswered:', perf.unanswered_count, '| Expected: 1')
  console.log('Attempted:', perf.correct_count + perf.incorrect_count, '| Expected: 2')
  
  const accuracy = (perf.correct_count / (perf.correct_count + perf.incorrect_count)) * 100
  console.log('Accuracy:', accuracy + '% | Expected: 50%')

  if (parseFloat(perf.score) === 1.5 && accuracy === 50) {
    console.log('\n--- PRE-FLIGHT GATE: PASS ---')
  } else {
    console.log('\n--- PRE-FLIGHT GATE: FAIL ---')
  }
}

run().catch(console.error)
