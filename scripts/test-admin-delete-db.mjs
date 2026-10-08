// Admin "Delete published test" (withdraw) and "Delete student result" on a throwaway PostgreSQL with the real KSC chain.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createLocalKscDb} from './lib/local-draft-db.mjs'

test('admins withdraw published tests (results kept, republish allowed) and delete results (logged, retake allowed)',async()=>{
 const db=await createLocalKscDb();try{
  await db.pool.query("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}'")
  for(const f of ['202610020036_staff_accounts.sql','202610020037_creator_accounts.sql','202610020038_student_program_onboarding.sql','202610030040_teaching_result_review.sql','202610030041_student_program_memberships.sql','202610030042_student_enrollment_audit.sql','202610040043_exam_library_delivery.sql','202610060044_library_archive.sql','202610060045_simple_library_sharing.sql','202610060046_program_paper_publishing.sql','202610070047_admin_delete_tests_results.sql'])db.applyMigration(f)
  const admin=db.teacher,teacher=db.otherTeacher,creator=randomUUID(),student=randomUUID(),outsider=randomUUID(),future=randomUUID(),reviewer=randomUUID()
  await db.pool.query("UPDATE ksc_staff_access SET state='active',password_change_required=false,role=CASE WHEN user_id=$1 THEN 'admin' ELSE 'teacher' END",[admin])
  for(const id of [creator,student,outsider,future,reviewer])await db.pool.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())',[id,id+'@ksc.test'])
  await db.pool.query("INSERT INTO ksc_staff_access(user_id,full_name,role,state,password_change_required) VALUES($1,'Creator','creator','active',false),($2,'Reviewer','teacher','active',false)",[creator,reviewer])
  await db.pool.query('INSERT INTO ksc_creator_exams VALUES($1,$2)',[creator,db.catalogue.examId])
  const rpc=(uid,name,args={})=>db.runner.rpc(uid,name,args)
  const otherExam=await db.pool.query("INSERT INTO exams(name,slug,is_active) VALUES('Other isolated program','other-isolated',true) RETURNING id")
  const otherLevel=(await db.pool.query("INSERT INTO exam_levels(exam_id,name,is_active) VALUES($1,'General',true) RETURNING id",[otherExam.rows[0].id])).rows[0].id
  await db.pool.query('INSERT INTO ksc_student_program_memberships(user_id,level_id) VALUES($1,$2),($3,$4)',[student,db.catalogue.levelId,outsider,otherLevel])
  const paper={id:randomUUID(),state:'ready',title:'Program practice',exam:'Group II',confirmed:true,duration:60,marks:.5,negative:.1,version:1,questions:[0,1].map(i=>({number:i+1,subject:i?'Geography':'Biology',content:'Original program question '+(i+1),options:['A','B','C','D'],correct:i,warnings:[]}))}
  const version=await rpc(creator,'ksc_library_add_ready',{p_request:paper.id,p_exam:db.catalogue.examId,p_level:null,p_paper:paper})

  const publish=async(uid=teacher)=>rpc(uid,'ksc_publish_program_paper',{p_version:version,p_exam:db.catalogue.examId,p_title:paper.title,p_request:randomUUID()})
  const finish=async(uid,testId)=>{const attempt=await rpc(uid,'start_test_attempt',{p_test_id:testId});const q=(await db.runner.asUser(uid,c=>c.query('SELECT * FROM test_question_snapshots WHERE test_id=$1 ORDER BY sort_order',[testId]))).rows[0]
   const option=(await db.pool.query('SELECT id FROM test_option_snapshots WHERE test_id=$1 AND question_id=$2 ORDER BY sort_order',[testId,q.question_id])).rows[0].id
   await rpc(uid,'save_attempt_answer',{p_attempt_id:attempt,p_question_id:q.question_id,p_option_id:option,p_is_marked:false,p_clear:false});await rpc(uid,'submit_test_attempt',{p_attempt_id:attempt});return attempt}
  await db.pool.query('INSERT INTO ksc_student_program_memberships(user_id,level_id) VALUES($1,$2)',[future,db.catalogue.levelId])
  const first=await publish()
  const done=await finish(student,first.test_id)
  const visible=async(uid,testId)=>(await db.runner.asUser(uid,c=>c.query('SELECT id FROM tests WHERE id=$1',[testId]))).rows.length

  // Withdrawing ("Delete published test") is admin-only.
  for(const uid of [null,teacher,student,creator])await assert.rejects(rpc(uid,'ksc_withdraw_published_test',{p_test:first.test_id}),/Administrator access|permission denied/)
  assert.equal(await visible(future,first.test_id),1)
  const withdrawn=await rpc(admin,'ksc_withdraw_published_test',{p_test:first.test_id})
  assert.equal(withdrawn.withdrawn,true);assert.equal(withdrawn.results_kept,1)
  assert.equal((await rpc(admin,'ksc_withdraw_published_test',{p_test:first.test_id})).withdrawn,true,'repeating is safe')
  await assert.rejects(rpc(admin,'ksc_withdraw_published_test',{p_test:randomUUID()}),/no longer available/)
  assert.equal((await rpc(teacher,'ksc_program_library_deliveries')).length,0)
  // Students without a result can neither see nor start it; the student with a result keeps history and review.
  assert.equal(await visible(future,first.test_id),0)
  assert.equal((await db.runner.asUser(future,c=>c.query('SELECT * FROM test_question_snapshots WHERE test_id=$1',[first.test_id]))).rows.length,0)
  await assert.rejects(rpc(future,'start_test_attempt',{p_test_id:first.test_id}),/not available/)
  await assert.rejects(rpc(student,'start_test_attempt',{p_test_id:first.test_id}),/not available/)
  assert.equal(await visible(student,first.test_id),1)
  assert.equal((await db.runner.asUser(student,c=>c.query('SELECT id FROM test_attempts WHERE id=$1',[done]))).rows.length,1)
  assert.equal((await rpc(admin,'ksc_teaching_results')).length,1,'results are kept')
  assert.equal((await rpc(teacher,'ksc_teaching_result_review',{p_attempt:done})).score,.5)
  assert.equal(await visible(teacher,first.test_id),1)
  // The paper can be published again as a fresh test.
  const second=await publish()
  assert.equal(second.already_published,false);assert.notEqual(second.test_id,first.test_id)
  assert.deepEqual((await rpc(teacher,'ksc_program_library_deliveries')).map(d=>d.test_id),[second.test_id])
  assert.equal((await publish(admin)).test_id,second.test_id,'still one live publication per version and program')

  // Deleting a result is admin-only, removes answers, is logged, and lets the student take the test again.
  const again=await finish(student,second.test_id)
  for(const uid of [null,teacher,student])await assert.rejects(rpc(uid,'ksc_delete_student_result',{p_attempt:again}),/Administrator access|permission denied/)
  await assert.rejects(db.pool.query('DELETE FROM test_attempts WHERE id=$1',[again]),/Cannot delete a finalized test attempt/)
  assert.ok((await db.pool.query('SELECT count(*)::int n FROM attempt_answers WHERE attempt_id=$1',[again])).rows[0].n>0)
  const removed=await rpc(admin,'ksc_delete_student_result',{p_attempt:again})
  assert.equal(removed.deleted,true);assert.equal(removed.already_deleted,false)
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM test_attempts WHERE id=$1',[again])).rows[0].n,0)
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM attempt_answers WHERE attempt_id=$1',[again])).rows[0].n,0)
  const log=(await db.pool.query('SELECT * FROM ksc_private.deleted_results WHERE attempt_id=$1',[again])).rows[0];assert.equal(log.deleted_by,admin);assert.equal(log.student_id,student);assert.equal(Number(log.score),.5)
  assert.equal((await rpc(admin,'ksc_delete_student_result',{p_attempt:again})).already_deleted,true)
  assert.equal((await db.pool.query('SELECT count(*)::int n FROM ksc_private.result_deletion_context')).rows[0].n,0)
  const retake=await rpc(student,'start_test_attempt',{p_test_id:second.test_id});assert.notEqual(retake,again)
  await assert.rejects(rpc(admin,'ksc_delete_student_result',{p_attempt:retake}),/Only finished results/)
  await assert.rejects(rpc(admin,'ksc_delete_student_result',{p_attempt:randomUUID()}),/no longer available/)
  await assert.rejects(db.runner.asUser(admin,c=>c.query('SELECT * FROM ksc_private.deleted_results')),/permission denied/)
  assert.equal((await rpc(admin,'ksc_teaching_results')).length,1,'the other result is untouched')
 }finally{await db.stop()}
})
