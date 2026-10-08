import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createLocalKscDb} from './lib/local-draft-db.mjs'
test('all families have distinct IDs, complete class mappings and no legacy signup/history clash',async()=>{
 const db=await createLocalKscDb();try{
  await db.pool.query("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}'")
  db.applyMigration('202610020036_staff_accounts.sql');db.applyMigration('202610020037_creator_accounts.sql');db.applyMigration('202610020038_student_program_onboarding.sql')
  const old=(await db.pool.query("SELECT e.id exam,l.id level FROM exams e JOIN exam_levels l ON l.exam_id=e.id WHERE e.slug='neet' AND l.name='UG'")).rows[0]
  const student=randomUUID();await db.pool.query("INSERT INTO auth.users(id,email) VALUES($1,'family@ksc.test')",[student]);await db.pool.query('INSERT INTO ksc_student_program_preferences(user_id,level_id) VALUES($1,$2)',[student,old.level])
  db.applyMigration('202610020039_program_families.sql')
  const catalogue=await db.runner.rpc(null,'ksc_signup_catalogue'),programs=catalogue.programs
  assert.equal(programs.length,9);assert.equal(new Set(programs.map(p=>p.id)).size,9)
  for(const slug of ['cbse-school-foundation','icse-school-foundation','state-board-school-foundation','iit-neet-foundation'])assert.equal(programs.find(p=>p.slug===slug).tracks.length,5)
  for(const slug of ['jee-main','neet'])assert.deepEqual(programs.find(p=>p.slug===slug).tracks.map(t=>t.name),['Class XI','Class XII'])
  assert.equal((await db.runner.rpc(student,'ksc_student_program_state')).selection.level_id,old.level);assert.equal((await db.runner.rpc(student,'ksc_student_program_state')).selection.available,true)
  const other=randomUUID();await db.pool.query("INSERT INTO auth.users(id,email) VALUES($1,'newfamily@ksc.test')",[other]);await assert.rejects(db.runner.rpc(other,'ksc_set_student_program',{p_level:old.level,p_version:0,p_user:other}),/not open/)
  const target=programs.find(p=>p.slug==='cbse-school-foundation').tracks[0].id
  await db.runner.rpc(other,'ksc_set_student_program',{p_level:target,p_version:0,p_user:other});assert.equal((await db.runner.rpc(other,'ksc_student_program_state')).selection.level_id,target)
  assert.equal((await db.pool.query('SELECT count(*) n FROM ksc_enrollments WHERE student_id=$1',[other])).rows[0].n,0)
  assert.equal((await db.pool.query("SELECT count(*) n FROM syllabi WHERE description='KSC curriculum workspace; chapters and resources require institute review.' AND status='DRAFT'")).rows[0].n,77)
  assert.equal((await db.pool.query('SELECT id FROM exams WHERE id=$1',[old.exam])).rows[0].id,old.exam)
 }finally{await db.stop()}
})
