import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createLocalKscDb} from './lib/local-draft-db.mjs'

test('program publishing needs no course/batch, isolates students, preserves snapshots and deduplicates staff retries',async()=>{
 const db=await createLocalKscDb();try{
  await db.pool.query("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}'")
  for(const f of ['202610020036_staff_accounts.sql','202610020037_creator_accounts.sql','202610020038_student_program_onboarding.sql','202610030040_teaching_result_review.sql','202610030041_student_program_memberships.sql','202610030042_student_enrollment_audit.sql','202610040043_exam_library_delivery.sql','202610060044_library_archive.sql','202610060045_simple_library_sharing.sql','202610060046_program_paper_publishing.sql'])db.applyMigration(f)
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
  const args={p_version:version,p_exam:db.catalogue.examId,p_title:paper.title,p_request:randomUUID()}
  for(const uid of [null,student,creator])await assert.rejects(rpc(uid,'ksc_publish_program_paper',args),/teacher or administrator|permission denied/)
  await assert.rejects(rpc(teacher,'ksc_publish_program_paper',{...args,p_exam:otherExam.rows[0].id}),/does not belong/)
  await assert.rejects(rpc(teacher,'ksc_publish_program_paper',{...args,p_title:''}),/test name/)
  const [a,b]=await Promise.all([rpc(teacher,'ksc_publish_program_paper',args),rpc(admin,'ksc_publish_program_paper',{...args,p_request:randomUUID()})]);assert.equal(a.test_id,b.test_id)
  assert.equal((await rpc(teacher,'ksc_publish_program_paper',args)).test_id,a.test_id)
  await assert.rejects(rpc(teacher,'ksc_publish_program_paper',{...args,p_title:'Changed'}),/request changed/)
  assert.equal((await db.pool.query('SELECT count(*) FROM tests')).rows[0].count,1)
  for(const table of ['ksc_courses','ksc_batches','ksc_enrollments'])assert.equal((await db.pool.query('SELECT count(*) FROM '+table)).rows[0].count,0)
  const test=(await db.pool.query('SELECT * FROM tests WHERE id=$1',[a.test_id])).rows[0];assert.equal(test.program_wide,true);assert.equal(test.level_id,null);assert.equal(test.total_marks,1)
  for(const table of ['tests','test_question_snapshots','test_option_snapshots']){
   const key=table==='tests'?'id':'test_id';assert.equal((await db.runner.asUser(outsider,c=>c.query(`SELECT * FROM ${table} WHERE ${key}=$1`,[a.test_id]))).rows.length,0)
   assert.ok((await db.runner.asUser(student,c=>c.query(`SELECT * FROM ${table} WHERE ${key}=$1`,[a.test_id]))).rows.length>0)
  }
  await assert.rejects(rpc(outsider,'start_test_attempt',{p_test_id:a.test_id}),/not available/)
  await assert.rejects(rpc(teacher,'start_test_attempt',{p_test_id:a.test_id}),/not available/)
  assert.equal((await db.runner.asUser(student,c=>c.query('SELECT * FROM test_answer_key_snapshots'))).rows.length,0)
  await assert.rejects(db.runner.asUser(student,c=>c.query('SELECT * FROM ksc_private.program_deliveries')),/permission denied/)
  await assert.rejects(db.runner.asUser(teacher,c=>c.query('SELECT * FROM ksc_private.program_deliveries')),/permission denied/)
  await assert.rejects(rpc(future,'start_test_attempt',{p_test_id:a.test_id}),/not available/)
  await db.pool.query('INSERT INTO ksc_student_program_memberships(user_id,level_id) VALUES($1,$2)',[future,db.catalogue.levelId]);await rpc(future,'start_test_attempt',{p_test_id:a.test_id})
  const attempt=await rpc(student,'start_test_attempt',{p_test_id:a.test_id})
  const qs=(await db.runner.asUser(student,c=>c.query('SELECT * FROM test_question_snapshots WHERE test_id=$1 ORDER BY sort_order',[a.test_id]))).rows;assert.equal(qs[0].content,paper.questions[0].content);assert.equal(qs[0].marks,.5)
  const option=(await db.pool.query('SELECT id FROM test_option_snapshots WHERE test_id=$1 AND question_id=$2 ORDER BY sort_order',[a.test_id,qs[0].question_id])).rows[0].id
  await rpc(student,'save_attempt_answer',{p_attempt_id:attempt,p_question_id:qs[0].question_id,p_option_id:option,p_is_marked:false,p_clear:false})
  await db.pool.query('DELETE FROM ksc_student_program_memberships WHERE user_id=$1',[student]);assert.equal(await rpc(student,'start_test_attempt',{p_test_id:a.test_id}),attempt)
  await rpc(student,'submit_test_attempt',{p_attempt_id:attempt});assert.equal((await db.pool.query('SELECT score FROM test_attempts WHERE id=$1',[attempt])).rows[0].score,.5)
  assert.equal((await rpc(teacher,'ksc_teaching_results')).length,1);assert.equal((await rpc(reviewer,'ksc_teaching_results')).length,0);await assert.rejects(rpc(reviewer,'ksc_teaching_result_review',{p_attempt:attempt}),/result access/)
  assert.equal((await rpc(teacher,'ksc_teaching_result_review',{p_attempt:attempt})).score,.5)
  await rpc(admin,'ksc_library_archive_ready',{p_version:version});assert.equal((await rpc(teacher,'ksc_publish_program_paper',args)).test_id,a.test_id);assert.equal((await rpc(teacher,'ksc_program_library_deliveries')).length,1)
  assert.equal((await db.pool.query('SELECT paper FROM ksc_private.library_versions WHERE id=$1',[version])).rows[0].paper.title,paper.title)
  await db.pool.query("UPDATE ksc_staff_access SET state='suspended' WHERE user_id=$1",[teacher]);await assert.rejects(rpc(teacher,'ksc_publish_program_paper',args),/teacher or administrator|permission denied/);assert.equal((await rpc(teacher,'ksc_teaching_results')).length,0)
 }finally{await db.stop()}
})
