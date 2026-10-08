import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
const target={host:'127.0.0.1',port:54322,user:'postgres',connectionTimeoutMillis:3000,query_timeout:20000};
async function verify(c){const {rows:[r]}=await c.query("SELECT current_setting('data_directory') dir,host(inet_server_addr()) host,inet_server_port() port,system_identifier::text sys FROM pg_control_system()");assert.equal(r.dir.replaceAll('\\','/').toLowerCase(),'c:/kst/.local_pg');assert.equal(r.host,'127.0.0.1');assert.equal(r.port,54322);assert.equal(r.sys,'7684311220310446404');}
test('teacher authors and publishes; learner completes; teacher reads result',async t=>{
 const admin=new pg.Client({...target,database:'postgres'});await admin.connect();let c,created=false;const db='ksc_contract_clean_'+randomUUID().replaceAll('-','');
 try{
 await verify(admin);await admin.query(`CREATE DATABASE "${db}"`);created=true;c=new pg.Client({...target,database:db});await c.connect();await verify(c);
 await c.query(await readFile('scripts/setup_auth.sql','utf8'));await c.query('ALTER TABLE auth.users ADD COLUMN raw_user_meta_data jsonb, ADD COLUMN email_confirmed_at timestamptz');
 await c.query(await readFile('scripts/fixtures/ksc-auto-rls.sql','utf8'));
 await c.query("CREATE EVENT TRIGGER fixture_rls ON ddl_command_end WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') EXECUTE FUNCTION public.rls_auto_enable()");
 await c.query(await readFile('docs/ksc/setup/KSC-INSTALL.sql','utf8'));
 const upgrade=await readFile('docs/ksc/setup/KSC-LMS-UPGRADE.sql','utf8');
 await c.query(upgrade);
 const staff=randomUUID(),student=randomUUID(),other=randomUUID();await c.query('INSERT INTO auth.users(id) VALUES($1),($2),($3)',[staff,student,other]);await c.query("INSERT INTO teacher_profiles(id,full_name) VALUES($1,'Fixture teacher')",[staff]);
 const as=async(uid,sql,args=[])=>{await c.query('BEGIN; SET LOCAL ROLE authenticated');try{await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[uid]);const r=await c.query(sql,args);await c.query('COMMIT');return r.rows;}catch(e){await c.query('ROLLBACK');throw e;}};
 await c.query("INSERT INTO ksc_staff_memberships VALUES('00000000-0000-4000-8000-000000000001',$1)",[staff]);
 await c.query("UPDATE auth.users SET email='learner@example.com',email_confirmed_at=now() WHERE id=$1",[student]);
 const course=(await as(staff,"SELECT ksc_create_course('00000000-0000-4000-8000-000000000001','Foundation','Practice course') id"))[0].id;
 const batch=(await as(staff,"SELECT ksc_create_batch($1,'Morning batch') id",[course]))[0].id;
 const lesson=(await as(staff,"SELECT ksc_save_lesson(null,$1,'Addition','Add two and two.',0,true) id",[course]))[0].id;
 const draft=(await as(staff,"SELECT ksc_save_lesson(null,$1,'Draft','Not yet ready.',1,false) id",[course]))[0].id;
 await t.test('unenrolled learners cannot read course or complete lesson',async()=>{
  assert.equal((await as(student,'SELECT * FROM ksc_courses')).length,0);
  assert.equal((await as(student,'SELECT * FROM ksc_lessons')).length,0);
  await assert.rejects(as(student,'SELECT ksc_complete_lesson($1)',[lesson]),/enrolled/);
  await assert.rejects(as(student,"SELECT ksc_enroll_student($1,'learner@example.com')",[batch]),/staff access/);
 });
 await as(staff,"SELECT ksc_enroll_student($1,'learner@example.com')",[batch]);
 await t.test('enrolled learner sees only published lessons and completion is idempotent',async()=>{
  assert.equal((await as(student,'SELECT * FROM ksc_courses')).length,1);
  assert.equal((await as(student,'SELECT * FROM ksc_lessons')).length,1);
  await assert.rejects(as(student,'SELECT ksc_complete_lesson($1)',[draft]),/enrolled/);
  await as(student,'SELECT ksc_complete_lesson($1)',[lesson]);await as(student,'SELECT ksc_complete_lesson($1)',[lesson]);
  assert.equal((await as(student,'SELECT * FROM ksc_lesson_completions')).length,1);
  assert.equal((await as(other,'SELECT * FROM ksc_lesson_completions')).length,0);
 });
 await t.test('different institute teacher cannot read or change course',async()=>{
  await c.query("INSERT INTO teacher_profiles(id,full_name) VALUES($1,'Other teacher')",[other]);
  const institute=(await c.query("INSERT INTO ksc_institutes(name) VALUES('Other institute') RETURNING id")).rows[0].id;
  await c.query('INSERT INTO ksc_staff_memberships VALUES($1,$2)',[institute,other]);
  assert.equal((await as(other,'SELECT * FROM ksc_courses')).length,0);
  await assert.rejects(as(other,"SELECT ksc_create_batch($1,'Other batch')",[course]),/staff access/);
  await assert.rejects(as(other,"SELECT ksc_save_lesson($1,$2,'Changed','Changed',0,true)",[lesson,course]),/staff access/);
  await c.query('DELETE FROM ksc_staff_memberships WHERE user_id=$1',[other]);await c.query('DELETE FROM teacher_profiles WHERE id=$1',[other]);
 });
 await t.test('removing enrollment removes content access',async()=>{
  await as(staff,"SELECT ksc_enroll_student($1,'learner@example.com',true)",[batch]);
  assert.equal((await as(student,'SELECT * FROM ksc_lessons')).length,0);
  await as(staff,"SELECT ksc_enroll_student($1,'learner@example.com')",[batch]);
 });
 const exam=(await as(staff,"INSERT INTO exams(name,slug) VALUES('Fixture practice','fixture-practice') RETURNING id"))[0].id;
 const subject=(await as(staff,"INSERT INTO exam_subjects(exam_id,name) VALUES($1,'Arithmetic') RETURNING id",[exam]))[0].id;
 const payload={exam_id:exam,subject_id:subject,content:'2 + 2 = ?',explanation:'Add two and two.',difficulty:'EASY'};
 const save='SELECT ksc_save_question($1,$2,$3,$4) value';
 await t.test('student denied authoring',()=>assert.rejects(as(student,save,[null,payload,JSON.stringify(['3','4']),1]),/Teacher access/));
 await t.test('invalid option rolls back entire question',async()=>{await assert.rejects(as(staff,save,[null,payload,JSON.stringify(['3','']),1]),/option/);assert.equal((await c.query('SELECT count(*)::int n FROM questions')).rows[0].n,0);});
 const q=(await as(staff,save,[null,payload,JSON.stringify(['3','4']),1]))[0].value;
 await as(staff,"UPDATE questions SET status='APPROVED' WHERE id=$1",[q.id]);
 await t.test('failed edit preserves old key and approval; successful edit requires review again',async()=>{
 const old=(await c.query('SELECT correct_option_id FROM question_answer_keys WHERE question_id=$1',[q.id])).rows[0].correct_option_id;
 await assert.rejects(as(staff,save,[q.id,payload,JSON.stringify(['3','']),1]),/option/);
 assert.equal((await c.query('SELECT correct_option_id FROM question_answer_keys WHERE question_id=$1',[q.id])).rows[0].correct_option_id,old);
 assert.equal((await c.query('SELECT status FROM questions WHERE id=$1',[q.id])).rows[0].status,'APPROVED');
 await as(staff,save,[q.id,payload,JSON.stringify(['3','4']),1]);assert.equal((await c.query('SELECT status FROM questions WHERE id=$1',[q.id])).rows[0].status,'DRAFT');
 });
 const pp={exam_id:exam,name:'Teacher practice pattern',total_duration_minutes:10};const sections=[{subject_id:subject,section_name:'Arithmetic',question_count:1,marks_per_question:4,negative_marks:1}];
 await t.test('invalid section rolls back pattern',async()=>{await assert.rejects(as(staff,'SELECT ksc_create_pattern($1,$2)',[pp,JSON.stringify([...sections,{...sections[0],subject_id:randomUUID()}])]),/Invalid section/);assert.equal((await c.query('SELECT count(*)::int n FROM exam_patterns')).rows[0].n,0);});
 const pat=(await as(staff,'SELECT ksc_create_pattern($1,$2) value',[pp,JSON.stringify(sections)]))[0].value;
 await as(staff,"UPDATE exam_patterns SET status='ACTIVE' WHERE id=$1",[pat.id]);
 const test=(await as(staff,'SELECT ksc_create_test($1) value',[{exam_id:exam,pattern_id:pat.id,name:'Practice test'}]))[0].value;
 const sec=(await c.query('SELECT id FROM exam_pattern_sections WHERE pattern_id=$1',[pat.id])).rows[0].id;
 await as(staff,'INSERT INTO test_questions(test_id,question_id,section_id,sort_order) VALUES($1,$2,$3,0)',[test.id,q.id,sec]);
 await t.test('draft bank content cannot publish',()=>assert.rejects(as(staff,'SELECT publish_test($1)',[test.id]),/approved/i));
 await as(staff,"UPDATE questions SET status='APPROVED' WHERE id=$1",[q.id]);await as(staff,'SELECT publish_test($1)',[test.id]);
 await t.test('published test is available; keys stay hidden',async()=>{assert.equal((await as(student,'SELECT id FROM tests WHERE is_published AND snapshot_contract_version=1')).length,1);assert.equal((await as(student,'SELECT * FROM question_answer_keys')).length,0);assert.equal((await as(student,'SELECT * FROM test_answer_key_snapshots')).length,0);});
 const attempt=(await as(student,'SELECT start_test_attempt($1) value',[test.id]))[0].value;
 const correct=(await c.query('SELECT correct_option_id FROM test_answer_key_snapshots WHERE test_id=$1',[test.id])).rows[0].correct_option_id;
 await as(student,'SELECT save_attempt_answer($1,$2,$3,false,false)',[attempt,q.id,correct]);await as(student,'SELECT submit_test_attempt($1)',[attempt]);
 await t.test('learner and teacher see actual score; another learner cannot read attempt',async()=>{assert.equal((await as(student,'SELECT score FROM test_attempts WHERE id=$1',[attempt]))[0].score,'4');assert.equal((await as(staff,'SELECT score FROM test_attempts WHERE id=$1',[attempt]))[0].score,'4');assert.equal((await as(other,'SELECT * FROM test_attempts WHERE id=$1',[attempt])).length,0);});
 await t.test('repeated upgrade refuses and preserves existing content',async()=>{
  await assert.rejects(c.query(upgrade),/already exists/);await c.query('ROLLBACK');
  assert.equal((await c.query('SELECT count(*)::int n FROM ksc_courses')).rows[0].n,1);
 });
 }finally{if(c)await c.end();if(created){await verify(admin);await admin.query(`DROP DATABASE "${db}"`);}await admin.end();}
});
