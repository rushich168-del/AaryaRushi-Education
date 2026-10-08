import { createClient } from '@supabase/supabase-js'
import { requireDisposableTestTarget } from './lib/live-test-guard.mjs'

// Fail-closed live-test guard (incident 2026-09-23): refuses KSC production, unknown, mismatched or
// unapproved targets BEFORE any auth, table or CLI call. See scripts/lib/live-test-guard.mjs.
const { url, key } = requireDisposableTestTarget({ script: 'test-patterns', usesLinkedCli: true })

async function run() {
  console.log('--- QA: EXAM PATTERN & TEST BUILDER ---')
  
  const supabaseTeacher = createClient(url, key)
  const teacherEmail = 'teacher_tb_' + Date.now() + '@test.com'
  const { data: tData } = await supabaseTeacher.auth.signUp({ email: teacherEmail, password: 'Password123!' })
  const teacherId = tData.user.id
  
  import('child_process').then(({ execSync }) => {
    execSync(`npx supabase db query "INSERT INTO public.teacher_profiles (id, full_name, role) VALUES ('${teacherId}', 'TB Teacher', 'teacher');" --linked`)
    console.log('Teacher Profile created')
  })

  // We need an Exam and Subject
  const { data: examData } = await supabaseTeacher.from('exams').insert({ name: 'TB Exam', slug: 'tb-exam-' + Date.now() }).select().single()
  const { data: subjData } = await supabaseTeacher.from('exam_subjects').insert({ exam_id: examData.id, name: 'TB Math' }).select().single()

  console.log('\n--- 1. PATTERN CONFIGURATION ---')
  const { data: patData, error: pErr } = await supabaseTeacher.from('exam_patterns').insert({
    exam_id: examData.id, name: 'QA Math Pattern', status: 'ACTIVE', total_marks: 6, total_duration_minutes: 10
  }).select().single()
  console.log('Insert Pattern:', pErr ? 'FAIL: ' + pErr.message : 'PASS')

  const { data: secData, error: sErr } = await supabaseTeacher.from('exam_pattern_sections').insert({
    pattern_id: patData.id, subject_id: subjData.id, section_name: 'Mathematics', question_count: 3, marks_per_question: 2
  }).select().single()
  console.log('Insert Section:', sErr ? 'FAIL: ' + sErr.message : 'PASS')

  console.log('\n--- 2. QUESTION BANK SETUP ---')
  // Need 3 questions
  const qIds = []
  for (let i=1; i<=3; i++) {
    const { data: qData } = await supabaseTeacher.from('questions').insert({
      exam_id: examData.id, subject_id: subjData.id, content: `Q${i} Math Content`, status: 'APPROVED'
    }).select().single()
    qIds.push(qData.id)
    
    const { data: oData } = await supabaseTeacher.from('question_options').insert([
      { question_id: qData.id, content: 'Opt A' }, { question_id: qData.id, content: 'Opt B' }
    ]).select()
    
    await supabaseTeacher.from('question_answer_keys').insert({
      question_id: qData.id, correct_option_id: oData[0].id
    })
  }
  console.log(`Created ${qIds.length} approved questions`)

  console.log('\n--- 3. TEST BUILDER ---')
  const { data: testData, error: tErr } = await supabaseTeacher.from('tests').insert({
    exam_id: examData.id, pattern_id: patData.id, name: 'QA Math Test', status: 'DRAFT', is_published: false
  }).select().single()
  console.log('Create Draft Test:', tErr ? 'FAIL: ' + tErr.message : 'PASS')

  for (let i=0; i<3; i++) {
    await supabaseTeacher.from('test_questions').insert({
      test_id: testData.id, question_id: qIds[i], section_id: secData.id
    })
  }
  console.log('Added 3 questions to test')

  console.log('\n--- 4. ATOMIC PUBLISH ---')
  const { data: pubData, error: pubErr } = await supabaseTeacher.rpc('publish_test', { p_test_id: testData.id })
  console.log('Publish Test RPC:', pubErr ? 'FAIL: ' + pubErr.message : 'PASS')

  const { data: finalTest } = await supabaseTeacher.from('tests').select('status, is_published').eq('id', testData.id).single()
  console.log('Test Status:', finalTest.status, finalTest.is_published ? 'PUBLISHED' : 'NOT PUBLISHED')

  console.log('\n--- 5. SNAPSHOT INTEGRITY ---')
  // Edit the original Question Bank question
  await supabaseTeacher.from('questions').update({ content: 'EDITED Q1 Math Content' }).eq('id', qIds[0])
  console.log('Modified original Question Bank question Q1')

  // Check the snapshot
  const { data: snapData } = await supabaseTeacher.from('test_question_snapshots').select('content').eq('test_id', testData.id).eq('question_id', qIds[0]).single()
  console.log('Snapshot Content:', snapData.content)
  console.log('Integrity Match:', snapData.content === 'Q1 Math Content' ? 'PASS (Isolated)' : 'FAIL (Leaked edit)')

  console.log('\n--- QA COMPLETE ---')
}

setTimeout(() => run().catch(console.error), 2000)
