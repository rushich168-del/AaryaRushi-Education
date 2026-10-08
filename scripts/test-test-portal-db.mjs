import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
const target={host:'127.0.0.1',port:54322,user:'postgres',connectionTimeoutMillis:3000,query_timeout:20000};
async function verify(c){const {rows:[r]}=await c.query("SELECT current_setting('data_directory') dir,host(inet_server_addr()) host,inet_server_port() port,system_identifier::text sys FROM pg_control_system()");assert.equal(r.dir.replaceAll('\\','/').toLowerCase(),'c:/kst/.local_pg');assert.equal(r.host,'127.0.0.1');assert.equal(r.port,54322);assert.equal(r.sys,'7684311220310446404');}
test('Test Portal forward upgrade preserves history and enforces context',async t=>{
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

 const before=(await c.query('SELECT row_to_json(t) value FROM tests t WHERE id=$1',[test.id])).rows[0].value;
 const previousScore=(await c.query('SELECT score FROM test_attempts WHERE id=$1',[attempt])).rows[0].score;
 const portal=await readFile('supabase/migrations/202609200013_test_portal.sql','utf8');
 const bundle=await readFile('docs/ksc/setup/KSC-TEST-PORTAL-UPGRADE.sql','utf8');
 assert.ok(bundle.endsWith('BEGIN;\n'+portal+'\nCOMMIT;\n'),'Upgrade bundle must match the exact migration');
 await c.query(bundle);
 await t.test('forward migration retains published content, results, and unknown track',async()=>{
  const after=(await c.query('SELECT * FROM tests WHERE id=$1',[test.id])).rows[0];
  assert.equal(after.level_id,null);assert.equal(after.level_name,null);assert.equal(after.name,before.name);
  assert.equal(after.exam_name,before.exam_name);assert.equal(after.is_published,true);
  assert.equal((await c.query('SELECT score FROM test_attempts WHERE id=$1',[attempt])).rows[0].score,previousScore);
 });
 const program=(await as(staff,"SELECT id FROM exams WHERE slug='sainik-school'"))[0].id;
 const levels=await as(staff,'SELECT * FROM exam_levels WHERE exam_id=$1 ORDER BY display_order',[program]);
 const level=levels[0].id,wrong=levels[1].id;
 const sub=(await as(staff,"INSERT INTO exam_subjects(exam_id,name) VALUES($1,'Mathematics') RETURNING id",[program]))[0].id;
 const syllabus=(await as(staff,"INSERT INTO syllabi(exam_id,level_id,subject_id,name,status) VALUES($1,$2,$3,'Practice curriculum','ACTIVE') RETURNING id",[program,level,sub]))[0].id;
 const chapter=(await as(staff,"INSERT INTO chapters(syllabus_id,name) VALUES($1,'Fractions') RETURNING id",[syllabus]))[0].id;
 const topic=(await as(staff,"INSERT INTO topics(chapter_id,name) VALUES($1,'Comparing fractions') RETURNING id",[chapter]))[0].id;
 await t.test('catalogue has 3 categories and all 11 requested programs; track/subject ancestry rejects mismatches',async()=>{
  assert.equal((await as(student,'SELECT * FROM program_categories')).length,3);
  assert.equal((await as(student,'SELECT * FROM exams WHERE category_id IS NOT NULL')).length,11);
  assert.deepEqual(levels.map(l=>l.name),['Class VI','Class IX']);
  await assert.rejects(as(staff,"INSERT INTO syllabi(exam_id,level_id,subject_id,name) VALUES($1,$2,$3,'Bad')",[exam,level,subject]),/belong/);
  await assert.rejects(as(staff,'UPDATE exam_levels SET exam_id=$1 WHERE id=$2',[exam,level]),/reparent/);
  await assert.rejects(as(student,"INSERT INTO program_categories(name,slug) VALUES('Bad','bad')"),/row-level security/);
 });
 await t.test('course link visibility follows enrollment and staff scope; no self-enrollment',async()=>{
  await as(staff,'INSERT INTO ksc_course_tracks(course_id,level_id) VALUES($1,$2)',[course,level]);
  assert.equal((await as(student,'SELECT * FROM ksc_course_tracks')).length,1);
  assert.equal((await as(other,'SELECT * FROM ksc_course_tracks')).length,0);
  await assert.rejects(as(other,'INSERT INTO ksc_course_tracks(course_id,level_id) VALUES($1,$2)',[course,wrong]),/row-level security/);
  await assert.rejects(as(student,'INSERT INTO ksc_course_tracks(course_id,level_id) VALUES($1,$2)',[course,wrong]),/row-level security/);
  await as(staff,"SELECT ksc_enroll_student($1,'learner@example.com',true)",[batch]);
  assert.equal((await as(student,'SELECT * FROM ksc_course_tracks')).length,0);
  await as(staff,"SELECT ksc_enroll_student($1,'learner@example.com')",[batch]);
 });
 const qp={exam_id:program,subject_id:sub,level_id:level,syllabus_id:syllabus,chapter_id:chapter,topic_id:topic,content:'Which is larger?',difficulty:'EASY',explanation:'One half exceeds one quarter.'};
 const bank=(await as(staff,save,[null,qp,JSON.stringify(['1/2','1/4']),0]))[0].value;
 await t.test('atomic authoring persists hierarchy and rolls back invalid ancestry',async()=>{
  assert.equal(bank.topic_id,topic);assert.equal(bank.level_id,level);
  await assert.rejects(as(staff,save,[bank.id,{...qp,level_id:wrong},JSON.stringify(['1/2','1/4']),0]),/Syllabus/);
  assert.equal((await c.query('SELECT level_id FROM questions WHERE id=$1',[bank.id])).rows[0].level_id,level);
 });
 await as(staff,"UPDATE questions SET status='APPROVED' WHERE id=$1",[bank.id]);
 const pattern=(await as(staff,'SELECT ksc_create_pattern($1,$2) value',[{exam_id:program,level_id:level,name:'Class VI practice',total_duration_minutes:15},JSON.stringify([{subject_id:sub,section_name:'Mathematics',question_count:2,marks_per_question:3,negative_marks:1}])]))[0].value;
 assert.equal(pattern.level_id,level);
 await as(staff,"UPDATE exam_patterns SET status='ACTIVE' WHERE id=$1",[pattern.id]);
 const portalTest=(await as(staff,'SELECT ksc_create_test($1) value',[{exam_id:program,pattern_id:pattern.id,name:'Track practice',test_kind:'CHAPTER',review_policy:'SUMMARY_ONLY'}]))[0].value;
 assert.equal(portalTest.level_id,level);
 const section=(await c.query('SELECT id FROM exam_pattern_sections WHERE pattern_id=$1',[pattern.id])).rows[0].id;
 await as(staff,'INSERT INTO test_questions(test_id,question_id,section_id) VALUES($1,$2,$3)',[portalTest.id,bank.id,section]);
 await t.test('backend rejects incomplete count and wrong track publication atomically',async()=>{
  await assert.rejects(as(staff,'SELECT publish_test($1)',[portalTest.id]),/counts/);
  await assert.rejects(as(staff,'UPDATE tests SET level_id=null WHERE id=$1',[portalTest.id]),/match the selected pattern/);
  assert.equal((await c.query('SELECT * FROM test_question_snapshots WHERE test_id=$1',[portalTest.id])).rowCount,0);
  await as(staff,'UPDATE exam_pattern_sections SET question_count=1 WHERE id=$1',[section]);
  await as(staff,'UPDATE questions SET level_id=$1,syllabus_id=null,chapter_id=null,topic_id=null WHERE id=$2',[wrong,bank.id]);
  await assert.rejects(as(staff,'SELECT publish_test($1)',[portalTest.id]),/match the test track/);
  await as(staff,'UPDATE questions SET level_id=$1 WHERE id=$2',[level,bank.id]);
  await assert.rejects(as(student,'SELECT publish_test($1)',[portalTest.id]),/teachers/);
 });
 await as(staff,'SELECT publish_test($1)',[portalTest.id]);
 await t.test('frozen catalogue labels and marks survive source edits; published context cannot change',async()=>{
  await as(staff,"UPDATE exam_levels SET name='Renamed track' WHERE id=$1",[level]);
  await as(staff,"UPDATE program_categories SET name='Renamed category' WHERE slug='school-military'");
  await as(staff,'UPDATE exam_pattern_sections SET marks_per_question=99 WHERE id=$1',[section]);
  const row=(await as(student,'SELECT * FROM tests WHERE id=$1',[portalTest.id]))[0];
  assert.equal(row.level_name,'Class VI');assert.equal(row.category_name,'School & Military Entrance');assert.equal(row.total_marks,3);
  await assert.rejects(as(staff,'UPDATE tests SET level_id=$1 WHERE id=$2',[wrong,portalTest.id]),/immutable/);
 });
 const portalAttempt=(await as(student,'SELECT start_test_attempt($1) value',[portalTest.id]))[0].value;
 await t.test('student bank/keys/review/direct score writes stay blocked before submission',async()=>{
  assert.equal((await as(student,'SELECT * FROM questions')).length,0);
  assert.equal((await as(student,'SELECT * FROM question_answer_keys')).length,0);
  assert.equal((await as(student,'SELECT * FROM test_answer_key_snapshots')).length,0);
  await assert.rejects(as(student,'SELECT * FROM get_attempt_review($1)',[portalAttempt]),/finalized/);
  const modified=await as(student,'UPDATE test_attempts SET score=999 WHERE id=$1 RETURNING id',[portalAttempt]);assert.equal(modified.length,0);
  await assert.rejects(as(other,'SELECT submit_test_attempt($1)',[portalAttempt]),/unauthorized/i);
 });
 const option=(await c.query('SELECT correct_option_id FROM test_answer_key_snapshots WHERE test_id=$1',[portalTest.id])).rows[0].correct_option_id;
 await as(student,'SELECT save_attempt_answer($1,$2,$3,false,false)',[portalAttempt,bank.id,option]);
 await as(student,'SELECT submit_test_attempt($1)',[portalAttempt]);
 await t.test('existing engine scores frozen data and respects SUMMARY_ONLY after portal upgrade',async()=>{
  const row=(await as(student,'SELECT * FROM test_attempts WHERE id=$1',[portalAttempt]))[0];assert.equal(row.score,'3');assert.equal(row.status,'SUBMITTED');
  await assert.rejects(as(student,'SELECT * FROM get_attempt_review($1)',[portalAttempt]),/Review is not allowed/);
  await assert.rejects(as(student,'SELECT * FROM get_attempt_section_performance($1)',[portalAttempt]),/Review is not allowed/);
  assert.equal((await as(staff,'SELECT * FROM get_attempt_section_performance($1)',[portalAttempt])).length,1);
  assert.equal((await as(other,'SELECT * FROM test_attempts WHERE id=$1',[portalAttempt])).length,0);
  assert.equal((await as(other,'SELECT id FROM tests WHERE id=$1',[portalTest.id])).length,1,'shared discovery preserved');
 });

 await t.test('repeated upgrade refuses and preserves existing content',async()=>{
  await assert.rejects(c.query(upgrade),/already exists/);await c.query('ROLLBACK');
  assert.equal((await c.query('SELECT count(*)::int n FROM ksc_courses')).rows[0].n,1);
 });
 }finally{if(c)await c.end();if(created){await verify(admin);await admin.query(`DROP DATABASE "${db}"`);}await admin.end();}
});
