import { createClient } from '@supabase/supabase-js'
import { requireDisposableTestTarget } from './lib/live-test-guard.mjs'

// Fail-closed live-test guard (incident 2026-09-23): refuses KSC production, unknown, mismatched or
// unapproved targets BEFORE any auth, table or CLI call. See scripts/lib/live-test-guard.mjs.
const { url, key } = requireDisposableTestTarget({ script: 'test-student-test-visibility', usesLinkedCli: true })

async function run() {
  console.log('--- QA: STUDENT PENETRATION & VISIBILITY ---')
  
  const supabaseStudent = createClient(url, key)
  const studentEmail = 'student_tb_' + Date.now() + '@test.com'
  const { data: sData } = await supabaseStudent.auth.signUp({ email: studentEmail, password: 'Password123!' })
  const studentId = sData.user.id

  import('child_process').then(({ execSync }) => {
    execSync(`npx supabase db query "INSERT INTO public.student_profiles (id, full_name) VALUES ('${studentId}', 'TB Student');" --linked`)
    console.log('Student Profile created')
  })

  // We need to fetch the last created PUBLISHED test and DRAFT test.
  // Using an admin client just to grab the IDs to test penetration.
  const supabaseAdmin = createClient(url, key, { auth: { persistSession: false } }) // Just anonymous for fetch, wait, I need admin to fetch drafts. I will just query using linked command or find the newly created test using test-patterns.mjs logic? 
  // Wait, I can just query the DB for the IDs using the teacher or student? No, student can't read drafts!
  
  // I will just try to select ANY draft test.
  setTimeout(async () => {
    console.log('\n--- 1. TEST VISIBILITY ---')
    // Attempt to read draft tests
    const { data: draftTests } = await supabaseStudent.from('tests').select('*').eq('status', 'DRAFT')
    console.log('Select DRAFT tests (Expect 0):', draftTests?.length === 0 ? 'PASS' : 'FAIL')

    // Attempt to read published tests
    const { data: pubTests } = await supabaseStudent.from('tests').select('*').eq('status', 'PUBLISHED')
    console.log('Select PUBLISHED tests (Expect >0 if test exists):', pubTests?.length > 0 ? 'PASS' : 'FAIL')
    
    if (pubTests?.length > 0) {
      const pTest = pubTests[0]
      // Attempt to read question snapshots for this test
      const { data: qs } = await supabaseStudent.from('test_question_snapshots').select('*').eq('test_id', pTest.id)
      console.log('Select Published Question Snapshots (Expect >0):', qs?.length > 0 ? 'PASS' : 'FAIL')

      // Attempt to read option snapshots
      const { data: os } = await supabaseStudent.from('test_option_snapshots').select('*').eq('test_id', pTest.id)
      console.log('Select Published Option Snapshots (Expect >0):', os?.length > 0 ? 'PASS' : 'FAIL')

      // Attempt to read answer key snapshots
      const { data: aks } = await supabaseStudent.from('test_answer_key_snapshots').select('*').eq('test_id', pTest.id)
      console.log('Select Published Answer Key Snapshots (Expect 0 / Denied):', aks?.length === 0 ? 'PASS' : 'FAIL')
    }

    console.log('\n--- 2. MUTATION PENETRATION ---')
    const { error: e1 } = await supabaseStudent.from('tests').insert({ name: 'Hacked' })
    console.log('Insert Test (Expect Denied):', e1 ? 'PASS (Denied)' : 'FAIL')

    const { error: e2 } = await supabaseStudent.from('test_questions').insert({ test_id: '123e4567-e89b-12d3-a456-426614174000', question_id: '123e4567-e89b-12d3-a456-426614174000' })
    console.log('Insert Test Question mapping (Expect Denied):', e2 ? 'PASS (Denied)' : 'FAIL')

    const { error: e3 } = await supabaseStudent.from('exam_patterns').insert({ name: 'Hacked' })
    console.log('Insert Exam Pattern (Expect Denied):', e3 ? 'PASS (Denied)' : 'FAIL')

    console.log('\n--- QA COMPLETE ---')
  }, 3000) // wait for child process insertion
}

run().catch(console.error)
