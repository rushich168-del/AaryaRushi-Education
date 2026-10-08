// Navodaya sign-up data migration on a throwaway PostgreSQL with the real KSC chain.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createLocalKscDb} from './lib/local-draft-db.mjs'

test('0048 opens Navodaya under School & Military with Class VI and Class IX tracks and is safe to re-run',async()=>{
 const db=await createLocalKscDb();try{
  await db.pool.query("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}'")
  for(const f of ['202610020036_staff_accounts.sql','202610020037_creator_accounts.sql','202610020038_student_program_onboarding.sql','202610020039_program_families.sql','202610030040_teaching_result_review.sql','202610030041_student_program_memberships.sql','202610030042_student_enrollment_audit.sql','202610040043_exam_library_delivery.sql','202610060044_library_archive.sql','202610060045_simple_library_sharing.sql','202610060046_program_paper_publishing.sql','202610070047_admin_delete_tests_results.sql'])await db.applyMigration(f)
  const catalogue=async()=>(await db.runner.rpc(null,'ksc_signup_catalogue')).programs
  assert.equal((await catalogue()).some(p=>p.name==='Navodaya'),false,'not open before 0048')
  const before=(await catalogue()).length
  await db.applyMigration('202610070048_navodaya_signup.sql')
  await db.applyMigration('202610070048_navodaya_signup.sql')
  const programs=await catalogue()
  const navodaya=programs.find(p=>p.name==='Navodaya')
  assert.ok(navodaya,'Navodaya is listed');assert.equal(navodaya.category,'School & Military Entrance')
  assert.deepEqual(navodaya.tracks.map(t=>t.name),['Class VI','Class IX'])
  assert.equal(programs.length,before+1)
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM exams WHERE slug='navodaya'")).rows[0].n,1)
 }finally{await db.stop()}
})
