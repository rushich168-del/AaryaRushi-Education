import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createLocalKscDb} from './lib/local-draft-db.mjs';
import {printedContent} from '../src/services/printedPaperContract.js';
test('staff roles, assignments, lifecycle gates and scoped publication on isolated PostgreSQL',async()=>{
 const db=await createLocalKscDb();
 try{
  await db.pool.query("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}'");
  const admin=db.teacher, teacher=db.otherTeacher, student=randomUUID(), otherStudent=randomUUID();
  await db.pool.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'student@ksc.local',now()),($2,'other@ksc.local',now())",[student,otherStudent]);
  db.applyMigration('202610020036_staff_accounts.sql');
  db.applyMigration('202610020037_creator_accounts.sql');
  db.applyMigration('202610030040_teaching_result_review.sql');
  db.applyMigration('202610030042_student_enrollment_audit.sql');
  db.applyMigration('202610040043_exam_library_delivery.sql');
  const rpc=(uid,name,args={})=>db.runner.rpc(uid,name,args);
  assert.equal((await rpc(admin,'ksc_my_access')).state,'pending');
  // Trusted local bootstrap. Never infer admin from old teacher role or signup.
  await db.pool.query("UPDATE ksc_staff_access SET role='admin',state='active',password_change_required=false WHERE user_id=$1",[admin]);
  await db.pool.query("UPDATE ksc_staff_access SET state='active',password_change_required=false WHERE user_id=$1",[teacher]);
  const course=await rpc(admin,'ksc_create_course',{p_institute:'00000000-0000-4000-8000-000000000001',p_name:'Assigned course',p_description:''});
  const hiddenCourse=await rpc(admin,'ksc_create_course',{p_institute:'00000000-0000-4000-8000-000000000001',p_name:'Other course',p_description:''});
  const batch=await rpc(admin,'ksc_create_batch',{p_course:course,p_name:'Assigned batch'});
  const hiddenBatch=await rpc(admin,'ksc_create_batch',{p_course:course,p_name:'Other batch'});
  await rpc(admin,'ksc_staff_assign',{p_user:teacher,p_courses:[course],p_batches:[batch],p_version:1});
  assert.equal(await rpc(teacher,'is_teacher'),false,'legacy broad authorization is admin-only');
  assert.equal(await rpc(teacher,'ksc_manages_course',{p_course:course}),true);
  assert.equal(await rpc(teacher,'ksc_manages_course',{p_course:hiddenCourse}),false);
  assert.equal(await rpc(teacher,'ksc_manages_batch',{p_batch:hiddenBatch}),false);
  await assert.rejects(rpc(student,'ksc_staff_list'),/Administrator/);
  await assert.rejects(rpc(teacher,'ksc_staff_assign',{p_user:teacher,p_courses:[hiddenCourse],p_batches:[],p_version:2}),/Administrator/);
  await assert.rejects(db.runner.asUser(student,c=>c.query("UPDATE ksc_staff_access SET role='admin' WHERE user_id=$1",[teacher])),/permission denied/);
  await assert.rejects(rpc(teacher,'ksc_create_batch',{p_course:course,p_name:'Unauthorised'}),/Administrator/);
  await assert.rejects(rpc(admin,'ksc_enroll_student',{p_batch:batch,p_email:'teacher@ksc.local'}),/staff account|confirmed learner/);
  await rpc(admin,'ksc_enroll_student',{p_batch:batch,p_email:'student@ksc.local'});
  assert.equal((await db.pool.query("SELECT count(*)::int n FROM ksc_staff_audit WHERE action='student_enrolled' AND target_id=\u00241",[student])).rows[0].n,1);
  await rpc(admin,'ksc_enroll_student',{p_batch:hiddenBatch,p_email:'other@ksc.local'});
  const lesson=await rpc(teacher,'ksc_save_lesson',{p_id:null,p_course:course,p_title:'Fractions',p_body:'A reviewed lesson',p_order:0,p_published:true});
  await assert.rejects(rpc(teacher,'ksc_save_lesson',{p_id:null,p_course:hiddenCourse,p_title:'Hidden',p_body:'X',p_order:0,p_published:false}),/Course staff/);
  await rpc(student,'ksc_complete_lesson',{p_lesson:lesson});
  await rpc(otherStudent,'ksc_complete_lesson',{p_lesson:lesson});
  const profiles=(await db.runner.asUser(teacher,c=>c.query('SELECT id FROM student_profiles'))).rows.map(x=>x.id);
  assert.ok(profiles.includes(student));assert.ok(!profiles.includes(otherStudent));
  const completions=(await db.runner.asUser(teacher,c=>c.query('SELECT student_id FROM ksc_lesson_completions'))).rows;
  assert.equal(completions.length,1);assert.equal(completions[0].student_id,student);
  const batches=(await db.runner.asUser(teacher,c=>c.query('SELECT id FROM ksc_batches'))).rows;
  assert.equal(batches.length,1);assert.equal(batches[0].id,batch);
  // Private context cannot be faked by settings or direct API-role writes.
  await assert.rejects(db.runner.asUser(teacher,c=>c.query('INSERT INTO ksc_private.staff_authoring_context VALUES(txid_current(),$1)',[teacher])),/permission denied/);
  await db.runner.asUser(teacher,async c=>{await c.query("SELECT set_config('ksc.staff_role','admin',true)");assert.equal((await c.query('SELECT is_teacher() ok')).rows[0].ok,false)});
  await assert.rejects(rpc(teacher,'ksc_staff_password_complete',{p_actor:teacher,p_version:2}),/permission denied/);
  await assert.rejects(rpc(teacher,'ksc_save_printed_paper',{p_id:null,p_metadata:{},p_questions:null,p_revision:null}),/Teacher access/);
  // Scoped teacher paper publication uses original review/snapshot/score engine.
  await db.pool.query('INSERT INTO ksc_course_tracks(course_id,level_id) VALUES($1,$2)',[course,db.catalogue.levelId]);
  const subject=(await db.pool.query("INSERT INTO exam_subjects(exam_id,name) VALUES($1,'Maths') RETURNING id",[db.catalogue.examId])).rows[0].id;
  const metadata={name:'Assigned teacher test',exam_id:db.catalogue.examId,level_id:db.catalogue.levelId,subject_id:subject,duration_minutes:30,marks:1,negative_marks:0,expected_count:1};
  const question={position:0,number:1,content:printedContent([{type:'text',text:'2 + 2?'}]),options:['4','3','2','1'],correct:0};
  const paper=await rpc(teacher,'ksc_staff_paper_save',{p_course:course,p_id:null,p_metadata:metadata,p_questions:[question],p_revision:null});
  await assert.rejects(rpc(teacher,'ksc_staff_paper_load',{p_course:hiddenCourse,p_id:paper.id}),/not available/);
  await assert.rejects(rpc(student,'ksc_staff_paper_publish',{p_course:course,p_id:paper.id,p_revision:paper.revision,p_reviewed:true}),/not available/);
  await assert.rejects(rpc(teacher,'ksc_staff_paper_publish',{p_course:course,p_id:paper.id,p_revision:paper.revision,p_reviewed:false}),/Review/);
  assert.equal(Number((await db.pool.query('SELECT count(*) n FROM ksc_private.staff_authoring_context')).rows[0].n),0);
  const testId=await rpc(teacher,'ksc_staff_paper_publish',{p_course:course,p_id:paper.id,p_revision:paper.revision,p_reviewed:true});
  assert.equal(await rpc(teacher,'is_teacher'),false,'no transaction capability leaks after wrapper');
  for(const learner of [student,otherStudent]){
   const attempt=await rpc(learner,'start_test_attempt',{p_test_id:testId});
   const option=(await db.pool.query('SELECT question_id,id FROM test_option_snapshots WHERE test_id=$1 ORDER BY sort_order LIMIT 1',[testId])).rows[0];
   await rpc(learner,'save_attempt_answer',{p_attempt_id:attempt,p_question_id:option.question_id,p_option_id:option.id,p_is_marked:false,p_clear:false});
   await rpc(learner,'submit_test_attempt',{p_attempt_id:attempt});
  }
  const results=await rpc(teacher,'ksc_teaching_results');
  assert.equal(results.length,1);assert.equal(Number(results[0].score),1);
  assert.equal(results[0].exam_id,db.catalogue.examId);assert.equal(Number(results[0].total_marks),1);
  const reviewed=await rpc(teacher,'ksc_teaching_result_review',{p_attempt:results[0].id});
  assert.equal(Number(reviewed.score),1);assert.equal(reviewed.questions.length,1);assert.equal(reviewed.questions[0].selected_option_id,reviewed.questions[0].correct_option_id);assert.equal(reviewed.questions[0].options.length,4);
  await assert.rejects(rpc(student,'ksc_teaching_result_review',{p_attempt:results[0].id}),/Assigned student/);
  const adminResults=await rpc(admin,'ksc_teaching_results');assert.equal(adminResults.length,2);
  const hidden=adminResults.find(r=>r.id!==results[0].id);
  await assert.rejects(rpc(teacher,'ksc_teaching_result_review',{p_attempt:hidden.id}),/Assigned student/);
  await db.pool.query('DELETE FROM ksc_staff_tests WHERE test_id=$1',[testId]);
  assert.equal((await rpc(admin,'ksc_teaching_results')).length,2,'admin includes historical shared tests');
  assert.equal((await rpc(teacher,'ksc_teaching_results')).length,0,'teacher cannot review unlinked shared tests');
  await assert.rejects(rpc(teacher,'ksc_teaching_result_review',{p_attempt:results[0].id}),/Assigned student/);
  await db.pool.query('INSERT INTO ksc_staff_tests(test_id,course_id) VALUES($1,$2)',[testId,course]);
  const waiting=randomUUID();await db.pool.query("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,'waiting@ksc.local',now())",[waiting]);
  const ongoing=await rpc(waiting,'start_test_attempt',{p_test_id:testId});
  await assert.rejects(rpc(admin,'ksc_teaching_result_review',{p_attempt:ongoing}),/Completed result/);
  const beforeScore=(await db.pool.query('SELECT score,max_score FROM test_attempts WHERE id=$1',[results[0].id])).rows[0];
  await rpc(teacher,'ksc_teaching_result_review',{p_attempt:results[0].id});
  assert.deepEqual((await db.pool.query('SELECT score,max_score FROM test_attempts WHERE id=$1',[results[0].id])).rows[0],beforeScore,'review is read-only');

  assert.equal((await db.runner.asUser(student,c=>c.query('SELECT * FROM test_answer_key_snapshots'))).rows.length,0);
  const access=await rpc(teacher,'ksc_my_access');
  await rpc(admin,'ksc_staff_assign',{p_user:teacher,p_courses:[],p_batches:[],p_version:access.version});
  assert.equal((await rpc(teacher,'ksc_teaching_courses')).length,0);
  assert.equal((await rpc(teacher,'ksc_staff_paper_list',{p_course:course})).length,0);
  assert.equal((await rpc(teacher,'ksc_teaching_results')).length,0);
  await assert.rejects(rpc(teacher,'ksc_teaching_result_review',{p_attempt:results[0].id}),/Assigned student/);
  // Credential-free service lifecycle: fixtures model Auth creation, not network calls.
  const created=randomUUID(),request=randomUUID();
  async function asService(sql,args){const c=await db.pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE service_role');const r=await c.query(sql,args);await c.query('COMMIT');return r.rows[0]?.r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
  await asService('SELECT ksc_staff_begin_create($1,$2,$3,$4,$5,$6) r',[admin,request,'new@ksc.local','New teacher',[course],[batch]]);
  await assert.rejects(asService('SELECT ksc_staff_begin_create($1,$2,$3,$4,$5,$6) r',[admin,request,'new@ksc.local','New teacher',[course],[batch]]),/already running/);
  await db.pool.query("INSERT INTO auth.users(id,email,email_confirmed_at,raw_app_meta_data) VALUES($1,'new@ksc.local',now(),$2)",[created,{ksc_staff_request:request}]);
  const completed=await asService('SELECT ksc_staff_complete_create($1,$2,$3) r',[admin,request,created]);
  assert.equal(completed.id,created);
  assert.equal((await asService('SELECT ksc_staff_complete_create($1,$2,$3) r',[admin,request,created])).id,created);
  assert.equal(await rpc(created,'ksc_manages_course',{p_course:course}),false,'temporary password blocks academic access');
  const gate=await asService('SELECT ksc_staff_password_gate($1,$1,false) r',[created]);
  await assert.rejects(asService('SELECT ksc_staff_password_gate($1,$1,false) r',[created]),/already running/);
  await asService('SELECT ksc_staff_password_complete($1,$2) r',[created,gate.version]);
  assert.equal(await rpc(created,'ksc_manages_course',{p_course:course}),true);
  await rpc(admin,'ksc_staff_set_state',{p_user:created,p_state:'suspended',p_version:3});
  assert.equal(await rpc(created,'ksc_manages_course',{p_course:course}),false);
  await assert.rejects(rpc(admin,'ksc_staff_set_state',{p_user:admin,p_state:'suspended',p_version:1}),/another staff/);
  await assert.rejects(rpc(admin,'ksc_staff_assign',{p_user:teacher,p_courses:[course],p_batches:[hiddenBatch],p_version:1}),/changed/);
  await assert.rejects(rpc(admin,'ksc_staff_assign',{p_user:teacher,p_courses:[hiddenCourse],p_batches:[batch],p_version:3}),/Choose valid/);
  assert.equal(await rpc(admin,'ksc_staff_lookup_existing',{p_email:'other@ksc.local'}),otherStudent);
  await rpc(admin,'ksc_staff_grant_existing',{p_user:otherStudent,p_email:'other@ksc.local',p_name:'Existing learner teacher',p_courses:[course],p_batches:[batch]});
  assert.equal((await rpc(otherStudent,'ksc_my_access')).role,'teacher');
  assert.equal((await db.pool.query('SELECT count(*) n FROM ksc_enrollments WHERE student_id=$1',[otherStudent])).rows[0].n,1);
  await assert.rejects(rpc(teacher,'ksc_staff_paper_subject',{p_course:hiddenCourse,p_exam:db.catalogue.examId}),/Assigned course/);
  for(let i=0;i<10;i++)assert.equal(await asService('SELECT ksc_staff_rate_limit($1) r',[admin]),true);
  assert.equal(await asService('SELECT ksc_staff_rate_limit($1) r',[admin]),false);
  // Exercise the actual operator template, including refusal guards, locally.
  const bootstrap=readFileSync(new URL('../docs/ksc/setup/KSC-BOOTSTRAP-ADMIN.sql',import.meta.url),'utf8');
  async function runBootstrap(sql){const c=await db.pool.connect();try{return await c.query(sql)}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
  await assert.rejects(runBootstrap(bootstrap),/Select the verified institute owner/);
  const ownerEmail=(await db.pool.query('SELECT email FROM auth.users WHERE id=$1',[admin])).rows[0].email;
  // Replace only the declaration UUID; retain the placeholder guard comparison.
  const verifiedOwner=bootstrap.replace("target_id uuid := '00000000-0000-0000-0000-000000000000'",`target_id uuid := '${admin}'`).replace("expected_email text := 'REPLACE_WITH_VERIFIED_OWNER_EMAIL'",`expected_email text := '${ownerEmail}'`);
  await assert.rejects(runBootstrap(verifiedOwner),/Owner identity mismatch/);
  await db.pool.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1',[admin]);
  await runBootstrap(verifiedOwner);
  assert.equal((await rpc(admin,'ksc_my_access')).role,'admin');
  const secondOwner=bootstrap.replace("target_id uuid := '00000000-0000-0000-0000-000000000000'",`target_id uuid := '${student}'`).replace("expected_email text := 'REPLACE_WITH_VERIFIED_OWNER_EMAIL'","expected_email text := 'student@ksc.local'");
  await assert.rejects(runBootstrap(secondOwner),/administrator already exists/);
  console.log('Verified roles, self-promotion denial, assigned learning/rosters/progress, private publication wrapper, score/key isolation, revocation and service-only credential gates.');
 }finally{await db.stop()}
});


