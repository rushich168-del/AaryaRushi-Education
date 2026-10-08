import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

// No URL/environment target overrides: this harness must never discover a remote target.
const target = { host:'127.0.0.1', port:54322, user:'postgres', connectionTimeoutMillis:3000, query_timeout:15000 };
const systemId='7684311220310446404';
async function verify(client) {
 const {rows:[r]}=await client.query(`SELECT current_setting('data_directory') dir,
 host(inet_server_addr()) host, inet_server_port() port, system_identifier::text sys FROM pg_control_system()`);
 assert.equal(r.dir.replaceAll('\\','/').toLowerCase(),'c:/kst/.local_pg');
 assert.equal(r.host,'127.0.0.1'); assert.equal(r.port,54322); assert.equal(r.sys,systemId);
}
const migrations=(await readdir('supabase/migrations')).filter(f=>/^2026091[01].*\.sql$/.test(f)).sort();
assert.equal(migrations.length,9,'Explicit KSC-only replay manifest changed; review harness');

for (const mode of ['clean','upgrade']) test(`${mode}: real PostgreSQL exam contract`, async t=>{
 const admin=new pg.Client({...target,database:'postgres'}); await admin.connect();
 let pool; let created=false;
 const db=`ksc_contract_${mode}_${randomUUID().replaceAll('-','')}`;
 try {
  await verify(admin); // Fail closed BEFORE CREATE, role setup, migrations, or fixtures.
  await admin.query(`CREATE DATABASE "${db}"`); created=true;
  pool=new pg.Pool({...target,database:db,max:8});
  const c=await pool.connect(); try { await verify(c); } finally {c.release();}
  await pool.query(await readFile('scripts/setup_auth.sql','utf8'));
  const apply=async f=>{await pool.query('BEGIN;\n'+await readFile(`supabase/migrations/${f}`,'utf8')+'\nCOMMIT;');};
  for(const f of migrations.slice(0,6)) await apply(f);
  const staff=randomUUID(), a=randomUUID(), b=randomUUID();
  await pool.query(`INSERT INTO auth.users(id) VALUES ($1),($2),($3)`,[staff,a,b]);
  await pool.query(`INSERT INTO teacher_profiles(id,full_name) VALUES($1,'Contract staff')`,[staff]);
  await pool.query(`INSERT INTO student_profiles(id,full_name) VALUES($1,'A'),($2,'B')`,[a,b]);
  const one=async(sql,args=[])=> (await pool.query(sql,args)).rows[0];
  const as=async(uid,sql,args=[],role='authenticated')=>{
   assert.ok(['authenticated','anon'].includes(role));
   const c=await pool.connect();
   try {await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[uid??'']);
    const result=await c.query(sql,args);await c.query('COMMIT');return result;
   }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  };
  let legacy;
  if(mode==='upgrade') {
   const e=await one(`INSERT INTO exams(name,slug) VALUES('Legacy','legacy') RETURNING id`);
   const su=await one(`INSERT INTO exam_subjects(exam_id,name) VALUES($1,'Legacy subject') RETURNING id`,[e.id]);
   const topic=await one(`INSERT INTO syllabus_topics(subject_id,name) VALUES($1,'Original topic') RETURNING id`,[su.id]);
   const q=await one(`INSERT INTO questions(exam_id,subject_id,topic_id,content,explanation,status) VALUES($1,$2,$3,'Legacy Q','Legacy explanation secret','APPROVED') RETURNING id`,[e.id,su.id,topic.id]);
   const pat=await one(`INSERT INTO exam_patterns(exam_id,name) VALUES($1,'Legacy pattern') RETURNING id`,[e.id]);
   const sec=await one(`INSERT INTO exam_pattern_sections(pattern_id,section_name,question_count,marks_per_question,negative_marks) VALUES($1,'Legacy section',1,4,1) RETURNING id`,[pat.id]);
   const te=await one(`INSERT INTO tests(exam_id,pattern_id,name,duration_minutes,review_policy) VALUES($1,$2,'Legacy test',10,'AFTER_SUBMISSION') RETURNING id`,[e.id,pat.id]);
   await pool.query(`INSERT INTO test_questions VALUES($1,$2,7,$3)`,[te.id,q.id,sec.id]);
   const op=await one(`INSERT INTO question_options(question_id,content,sort_order) VALUES($1,'Legacy correct',5) RETURNING id`,[q.id]);
   await pool.query(`INSERT INTO question_options(question_id,content,sort_order) VALUES($1,'Legacy wrong',8)`,[q.id]);
   await pool.query(`INSERT INTO question_answer_keys VALUES($1,$2)`,[q.id,op.id]);
   await as(staff,`SELECT publish_test($1)`,[te.id]);
   const attempt=(await as(a,`SELECT start_test_attempt($1) id`,[te.id])).rows[0].id;
   await as(a,`SELECT submit_test_attempt($1)`,[attempt]);
   legacy={test:te.id,q:q.id,topic:topic.id,attempt};
  }
  for(const f of migrations.slice(6,8)) await apply(f);
  if(legacy){
   const te=await one(`INSERT INTO tests(exam_id,pattern_id,name,duration_minutes,review_policy)
    SELECT exam_id,pattern_id,'0008 timed legacy',10,'SUMMARY_ONLY' FROM tests WHERE id=$1 RETURNING id`,[legacy.test]);
   await pool.query(`INSERT INTO test_questions SELECT $1,question_id,sort_order,section_id FROM test_questions WHERE test_id=$2`,[te.id,legacy.test]);
   await as(staff,'SELECT publish_test($1)',[te.id]);
   legacy.pending=(await as(b,'SELECT start_test_attempt($1) id',[te.id])).rows[0].id;
   assert.equal((await one('SELECT expires_at FROM test_attempts WHERE id=$1',[legacy.pending])).expires_at,null);
  }
  await apply(migrations[8]);

  await t.test('roles cannot bypass RLS; effective SECURITY DEFINER grants are allowlisted',async()=>{
   const roles=await pool.query(`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`);
   assert.equal(roles.rowCount,3);for(const r of roles.rows){assert.equal(r.rolsuper,false);assert.equal(r.rolbypassrls,false);}
   assert.equal((await pool.query(`SELECT * FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('anon','authenticated','service_role')`)).rowCount,0);
   const probe=(await as(a,`SELECT current_user, row_security_active('public.test_attempts') active`)).rows[0];
   assert.equal(probe.current_user,'authenticated');assert.equal(probe.active,true);
   for(const table of ['test_question_snapshots','test_option_snapshots','test_answer_key_snapshots','test_explanation_snapshots','test_attempts','attempt_answers']){
    assert.equal((await as(null,`SELECT row_security_active('public.${table}') active`,[],'anon')).rows[0].active,true);
    for(const role of ['anon','authenticated','service_role'])assert.equal((await one("SELECT has_table_privilege($1,$2,'TRUNCATE') allowed",[role,table])).allowed,false);
   }
   const f=(await pool.query(`SELECT p.proname,has_function_privilege('anon',p.oid,'execute') anon,
   has_function_privilege('authenticated',p.oid,'execute') authenticated,has_function_privilege('service_role',p.oid,'execute') service
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef ORDER BY 1`)).rows;
   assert.equal(f.length,10);for(const x of f){assert.equal(x.anon,x.proname==='is_teacher',x.proname);assert.equal(x.authenticated,x.proname!=='evaluate_and_finalize_attempt',x.proname);assert.equal(x.service,false,x.proname);}
   console.log(mode,'effective definer grants verified:',f.map(x=>x.proname).join(', '));
  });
  if(legacy) await t.test('synthetic upgrade retains IDs, explanations, order and finalized score; unmapped history stays explicit',async()=>{
   assert.equal((await one('SELECT legacy_topic_id,topic_id FROM questions WHERE id=$1',[legacy.q])).legacy_topic_id,legacy.topic);
   assert.equal((await one('SELECT topic_id FROM questions WHERE id=$1',[legacy.q])).topic_id,null);
   assert.equal((await one('SELECT sort_order FROM test_question_snapshots WHERE test_id=$1',[legacy.test])).sort_order,7);
   assert.equal((await one('SELECT score FROM test_attempts WHERE id=$1',[legacy.attempt])).score,'0');
   assert.equal((await as(a,'SELECT explanation FROM get_attempt_review($1)',[legacy.attempt])).rows[0].explanation,'Legacy explanation secret');
   assert.equal((await as(b,'SELECT * FROM test_explanation_snapshots WHERE test_id=$1',[legacy.test])).rowCount,0);
   await assert.rejects(as(b,'SELECT start_test_attempt($1)',[legacy.test]),/Legacy snapshot/);
   assert.equal((await one('SELECT section_name FROM test_question_snapshots WHERE test_id=$1',[legacy.test])).section_name,null);
   const review=(await as(a,'SELECT * FROM get_attempt_review($1)',[legacy.attempt])).rows[0];
   assert.equal(review.marks,null);assert.equal(review.negative_marks,null);assert.equal(review.marks_awarded,null);
   await assert.rejects(as(a,'SELECT * FROM get_attempt_section_performance($1)',[legacy.attempt]),/Legacy snapshot/);
   assert.ok((await one('SELECT expires_at FROM test_attempts WHERE id=$1',[legacy.pending])).expires_at);
   await assert.rejects(as(b,'SELECT submit_test_attempt($1)',[legacy.pending]),/Legacy snapshot/);
   await assert.rejects(as(staff,'DELETE FROM syllabus_topics WHERE id=$1',[legacy.topic]),/foreign key/);
  });
  const exam=await one(`INSERT INTO exams(name,slug) VALUES('Fixture exam',$1) RETURNING id`,[randomUUID()]);
  const subject=await one(`INSERT INTO exam_subjects(exam_id,name) VALUES($1,'Original subject') RETURNING id`,[exam.id]);
  const pattern=await one(`INSERT INTO exam_patterns(exam_id,name) VALUES($1,'Fixture pattern') RETURNING id`,[exam.id]);
  const section=await one(`INSERT INTO exam_pattern_sections(pattern_id,subject_id,section_name,display_order,question_count,marks_per_question,negative_marks) VALUES($1,$2,'Original section',3,3,4,1) RETURNING id`,[pattern.id,subject.id]);
  const testRow=await one(`INSERT INTO tests(exam_id,pattern_id,name,duration_minutes,review_policy) VALUES($1,$2,'Fixture test',10,'AFTER_SUBMISSION') RETURNING id`,[exam.id,pattern.id]);
  const id=testRow.id;const qs=[];
  for(let i=0;i<3;i++){
   const q=await one(`INSERT INTO questions(exam_id,subject_id,content,explanation,status) VALUES($1,$2,$3,$4,'APPROVED') RETURNING id`,[exam.id,subject.id,`Q${i}`,`Explanation ${i}`]);
   const op=await one(`INSERT INTO question_options(question_id,content,sort_order) VALUES($1,'Correct',9) RETURNING id`,[q.id]);
   const wrong=await one(`INSERT INTO question_options(question_id,content,sort_order) VALUES($1,'Wrong',2) RETURNING id`,[q.id]);
   await pool.query('INSERT INTO question_answer_keys VALUES($1,$2)',[q.id,op.id]);
   await pool.query('INSERT INTO test_questions(test_id,question_id,section_id,sort_order) VALUES($1,$2,$3,$4)',[id,q.id,section.id,20-i]);
   qs.push({id:q.id,correct:op.id,wrong:wrong.id});
  }
  await t.test('publication rejects anonymous/student, empty, draft, invalid key ownership, mismatched sections and unmapped topics',async()=>{
   await assert.rejects(as(null,'SELECT publish_test($1)',[id],'anon'),/permission denied/);
   await assert.rejects(as(a,'SELECT publish_test($1)',[id]),/Unauthorized/);
   const empty=await one(`INSERT INTO tests(exam_id,pattern_id,name) VALUES($1,$2,'Empty') RETURNING id`,[exam.id,pattern.id]);
   await assert.rejects(as(staff,'SELECT publish_test($1)',[empty.id]),/empty/);
   await pool.query("UPDATE questions SET status='DRAFT' WHERE id=$1",[qs[0].id]);
   await assert.rejects(as(staff,'SELECT publish_test($1)',[id]),/not approved/);
   await pool.query("UPDATE questions SET status='APPROVED' WHERE id=$1",[qs[0].id]);
   await pool.query('UPDATE question_answer_keys SET correct_option_id=$1 WHERE question_id=$2',[qs[1].correct,qs[0].id]);
   await assert.rejects(as(staff,'SELECT publish_test($1)',[id]),/answer key/);
   await pool.query('UPDATE question_answer_keys SET correct_option_id=$1 WHERE question_id=$2',[qs[0].correct,qs[0].id]);
   await pool.query('UPDATE test_questions SET section_id=NULL WHERE test_id=$1 AND question_id=$2',[id,qs[0].id]);
   await assert.rejects(as(staff,'SELECT publish_test($1)',[id]),/section/);
   await pool.query('UPDATE test_questions SET section_id=$1 WHERE test_id=$2 AND question_id=$3',[section.id,id,qs[0].id]);
   const topic=await one(`INSERT INTO syllabus_topics(subject_id,name) VALUES($1,'Unmapped') RETURNING id`,[subject.id]);
   await pool.query('UPDATE questions SET legacy_topic_id=$1 WHERE id=$2',[topic.id,qs[0].id]);
   await assert.rejects(as(staff,'SELECT publish_test($1)',[id]),/unmapped/);
   await pool.query('UPDATE questions SET legacy_topic_id=NULL WHERE id=$1',[qs[0].id]);
   await as(staff,'SELECT publish_test($1)',[id]);
   assert.equal((await one('SELECT total_marks FROM tests WHERE id=$1',[id])).total_marks,12);
  });
  let attempt;
  await t.test('concurrent start/resume returns one ID and a non-null authoritative expiry',async()=>{
   const starts=await Promise.all(Array.from({length:5},()=>as(a,'SELECT start_test_attempt($1) id',[id])));
   attempt=starts[0].rows[0].id;assert.ok(starts.every(x=>x.rows[0].id===attempt));
   assert.equal((await as(a,'SELECT start_test_attempt($1) id',[id])).rows[0].id,attempt);
   const r=await one('SELECT expires_at-started_at delta,expires_at FROM test_attempts WHERE id=$1',[attempt]);
   assert.ok(r.expires_at);assert.equal(r.delta.minutes,10);
   assert.equal((await pool.query('SELECT * FROM test_attempts WHERE test_id=$1 AND student_id=$2',[id,a])).rowCount,1);
  });
  for(const q of qs){const r=await pool.query('SELECT id,original_option_id FROM test_option_snapshots WHERE test_id=$1 AND question_id=$2',[id,q.id]);q.snapCorrect=r.rows.find(o=>o.original_option_id===q.correct).id;q.snapWrong=r.rows.find(o=>o.original_option_id===q.wrong).id;}
  await t.test('anonymous, NULL-claim and cross-student save/clear/submit denied; direct writes obey RLS',async()=>{
   for(const [uid,role] of [[null,'anon'],[null,'authenticated'],[b,'authenticated']]){
    for(const clear of [false,true])await assert.rejects(as(uid,'SELECT save_attempt_answer($1,$2,$3,false,$4)',[attempt,qs[0].id,qs[0].snapCorrect,clear],role),/permission denied|Authenticated|unauthorized/);
    await assert.rejects(as(uid,'SELECT submit_test_attempt($1)',[attempt],role),/permission denied|Authenticated|unauthorized/);
   }
   assert.equal((await as(b,'SELECT * FROM test_attempts WHERE id=$1',[attempt])).rowCount,0);
   assert.equal((await pool.query('SELECT * FROM attempt_answers WHERE attempt_id=$1',[attempt])).rowCount,0);
   await assert.rejects(as(a,'SELECT save_attempt_answer($1,$2,$3,false,false)',[attempt,qs[0].id,qs[1].snapCorrect]),/Option does not belong/);
   await assert.rejects(as(a,'SELECT save_attempt_answer($1,$2,NULL,false,true)',[attempt,randomUUID()]),/Question does not belong/);
   assert.equal((await as(a,"UPDATE test_attempts SET score=999 WHERE id=$1",[attempt])).rowCount,0);
   await assert.rejects(as(a,'INSERT INTO attempt_answers(attempt_id,question_id) VALUES($1,$2)',[attempt,qs[0].id]),/row-level security/);
   await assert.rejects(as(a,'SELECT evaluate_and_finalize_attempt($1)',[attempt]),/permission denied/);
  });
  await t.test('pre-review direct tables/live bank and review RPCs disclose no explanations or correctness',async()=>{
   for(const [uid,role] of [[a,'authenticated'],[b,'authenticated'],[null,'anon']]){
    const safe=await as(uid,'SELECT * FROM test_question_snapshots WHERE test_id=$1',[id],role);
    assert.ok(safe.rows.every(r=>!('explanation' in r)&&!('correct_option_id' in r)));
    assert.equal((await as(uid,'SELECT * FROM test_answer_key_snapshots WHERE test_id=$1',[id],role)).rowCount,0);
    assert.equal((await as(uid,'SELECT * FROM questions WHERE id=$1',[qs[0].id],role)).rowCount,0);
    if(role==='anon')await assert.rejects(as(uid,'SELECT * FROM test_explanation_snapshots',[ ],role),/permission denied/);
    else assert.equal((await as(uid,'SELECT * FROM test_explanation_snapshots WHERE test_id=$1',[id],role)).rowCount,0);
    for(const f of ['get_attempt_review','get_attempt_section_performance'])await assert.rejects(as(uid,`SELECT * FROM ${f}($1)`,[attempt],role),/permission denied|Unauthorized|not finalized/);
   }
  });
  await t.test('published grading, keys, explanations, options, membership and test metadata cannot be mutated by staff',async()=>{
   for(const sql of ["UPDATE test_question_snapshots SET marks=99 WHERE test_id=$1","DELETE FROM test_option_snapshots WHERE test_id=$1","UPDATE test_answer_key_snapshots SET correct_option_id=NULL WHERE test_id=$1","DELETE FROM test_questions WHERE test_id=$1","UPDATE tests SET is_published=false WHERE id=$1","UPDATE tests SET name='Changed' WHERE id=$1","DELETE FROM tests WHERE id=$1"])
    await assert.rejects(as(staff,sql,[id]),/immutable|Cannot delete|permission denied/);
   await assert.rejects(as(staff,'UPDATE test_explanation_snapshots SET explanation=NULL WHERE test_id=$1',[id]),/permission denied/);
   await assert.rejects(as(staff,`INSERT INTO tests(name,is_published) VALUES('Bypass',true)`),/draft/);
  });
  await t.test('correct, incorrect, unanswered grading survives source marks/labels/content/key edits and concurrent/repeated submit',async()=>{
   await as(a,'SELECT save_attempt_answer($1,$2,$3,false,false)',[attempt,qs[0].id,qs[0].snapCorrect]);
   await as(a,'SELECT save_attempt_answer($1,$2,$3,false,false)',[attempt,qs[1].id,qs[1].snapWrong]);
   await as(a,'SELECT save_attempt_answer($1,$2,$3,false,false)',[attempt,qs[2].id,qs[2].snapCorrect]);
   await as(a,'SELECT save_attempt_answer($1,$2,NULL,false,true)',[attempt,qs[2].id]);
   // All mutations are scoped to this run's fixture IDs, never every section.
   await as(staff,"UPDATE exam_pattern_sections SET marks_per_question=100,negative_marks=50,section_name='Changed' WHERE id=$1",[section.id]);
   await as(staff,"UPDATE exam_subjects SET name='Changed subject' WHERE id=$1",[subject.id]);
   await as(staff,"UPDATE questions SET content='Changed',explanation='Changed explanation',marks=77 WHERE id=$1",[qs[0].id]);
   await as(staff,'UPDATE question_answer_keys SET correct_option_id=$1 WHERE question_id=$2',[qs[0].wrong,qs[0].id]);
   await Promise.all(Array.from({length:4},()=>as(a,'SELECT submit_test_attempt($1)',[attempt])));
   const r=await one('SELECT * FROM test_attempts WHERE id=$1',[attempt]);
   assert.equal(r.status,'SUBMITTED');assert.equal(r.score,'3');assert.equal(r.max_score,'12');
   assert.equal(r.correct_count,1);assert.equal(r.incorrect_count,1);assert.equal(r.unanswered_count,1);assert.ok(r.completed_at);
   await as(a,'SELECT submit_test_attempt($1)',[attempt]);assert.deepEqual(await one('SELECT * FROM test_attempts WHERE id=$1',[attempt]),r);
   await assert.rejects(as(a,'SELECT save_attempt_answer($1,$2,$3,false,false)',[attempt,qs[0].id,qs[0].snapWrong]),/finalized/);
  });
  await t.test('authorized review retains explanations, frozen labels and deterministic question/option order',async()=>{
   const r=(await as(a,'SELECT * FROM get_attempt_review($1)',[attempt])).rows;
   assert.deepEqual(r.map(x=>x.question_id),qs.toReversed().map(x=>x.id));
   assert.equal(r.find(x=>x.question_id===qs[0].id).explanation,'Explanation 0');
   assert.equal(r.find(x=>x.question_id===qs[0].id).content,'Q0');
   assert.ok(r.every(x=>x.section_name==='Original section'&&x.negative_marks==='1'));
   const perf=(await as(a,'SELECT * FROM get_attempt_section_performance($1)',[attempt])).rows[0];
   assert.equal(perf.subject_name,'Original subject');assert.equal(perf.score,'3');
   assert.equal((await as(a,'SELECT * FROM test_explanation_snapshots WHERE test_id=$1',[id])).rowCount,3);
   assert.equal((await as(staff,'SELECT * FROM get_attempt_review($1)',[attempt])).rowCount,3);
   assert.deepEqual((await as(a,'SELECT sort_order FROM test_option_snapshots WHERE test_id=$1 AND question_id=$2 ORDER BY sort_order',[id,qs[0].id])).rows.map(x=>x.sort_order),[2,9]);
   await assert.rejects(as(b,'SELECT * FROM get_attempt_review($1)',[attempt]),/Unauthorized/);
  });
  await t.test('late saves fail even in old transactions; expiry sweep is caller-scoped and concurrent submission idempotent',async()=>{
   const ab=(await as(b,'SELECT start_test_attempt($1) id',[id])).rows[0].id;
   await pool.query("UPDATE test_attempts SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE id=$1",[ab]);
   const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE authenticated');await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[b]);await c.query('SELECT pg_sleep(0.3)');await assert.rejects(c.query('SELECT save_attempt_answer($1,$2,$3,false,false)',[ab,qs[0].id,qs[0].snapCorrect]),/expired/);await c.query('ROLLBACK');}finally{c.release();}
   assert.equal((await as(a,'SELECT finalize_expired_attempts() n')).rows[0].n,0);
   assert.equal((await one('SELECT status FROM test_attempts WHERE id=$1',[ab])).status,'IN_PROGRESS');
   await assert.rejects(as(null,'SELECT finalize_expired_attempts()',[],'anon'),/permission denied/);
   await assert.rejects(as(null,'SELECT finalize_expired_attempts()'),/Authenticated/);
   await Promise.all([as(b,'SELECT finalize_expired_attempts()'),as(b,'SELECT submit_test_attempt($1)',[ab]),as(b,'SELECT finalize_expired_attempts()')]);
   const result=await one('SELECT * FROM test_attempts WHERE id=$1',[ab]);assert.equal(result.status,'EXPIRED');assert.equal(result.unanswered_count,3);
   assert.equal((await as(b,'SELECT finalize_expired_attempts() n')).rows[0].n,0);
   await as(b,'SELECT submit_test_attempt($1)',[ab]);assert.deepEqual(await one('SELECT * FROM test_attempts WHERE id=$1',[ab]),result);
  });
  await t.test('NULL/inconsistent question ancestry is rejected',async()=>{
   const level=await one(`INSERT INTO exam_levels(exam_id,name) VALUES($1,'Level') RETURNING id`,[exam.id]);
   const syllabus=await one(`INSERT INTO syllabi(exam_id,level_id,subject_id,name) VALUES($1,$2,$3,'Syllabus') RETURNING id`,[exam.id,level.id,subject.id]);
   await assert.rejects(as(staff,`INSERT INTO questions(exam_id,level_id,syllabus_id,content) VALUES($1,$2,$3,'Bad NULL subject')`,[exam.id,level.id,syllabus.id]),/Syllabus does not match/);
   await assert.rejects(as(staff,`INSERT INTO questions(exam_id,subject_id,topic_id,content) VALUES($1,$2,$3,'Bad topic')`,[exam.id,subject.id,randomUUID()]),/chapter_id must also/);
  });
  await t.test('additional malformed publication is atomic: foreign pattern, missing options/key, null policy and invalid marks',async()=>{
   const draft=await one(`INSERT INTO tests(exam_id,pattern_id,name,review_policy) VALUES($1,$2,'Malformed','AFTER_SUBMISSION') RETURNING id`,[exam.id,pattern.id]);
   const q=await one(`INSERT INTO questions(exam_id,subject_id,content,status) VALUES($1,$2,'Incomplete','APPROVED') RETURNING id`,[exam.id,subject.id]);
   await pool.query('INSERT INTO test_questions(test_id,question_id,section_id) VALUES($1,$2,$3)',[draft.id,q.id,section.id]);
   const publish=()=>as(staff,'SELECT publish_test($1)',[draft.id]);
   await assert.rejects(as(staff,`CREATE TEMP TABLE pg_class(oid oid,relowner oid) ON COMMIT DROP;
    INSERT INTO pg_class SELECT 'public.tests'::regclass,oid FROM pg_roles WHERE rolname='authenticated';
    UPDATE public.tests SET is_published=true,snapshot_contract_version=1 WHERE id='${draft.id}'`),/Use publish_test/);

   await assert.rejects(publish(),/2 options/);
   const opt=await one(`INSERT INTO question_options(question_id,content) VALUES($1,'One') RETURNING id`,[q.id]);
   await pool.query(`INSERT INTO question_options(question_id,content) VALUES($1,'Two')`,[q.id]);
   await assert.rejects(publish(),/answer key/);
   await pool.query('INSERT INTO question_answer_keys VALUES($1,$2)',[q.id,opt.id]);
   await pool.query('UPDATE tests SET review_policy=NULL WHERE id=$1',[draft.id]);await assert.rejects(publish(),/review policy/);
   await pool.query("UPDATE tests SET review_policy='AFTER_SUBMISSION' WHERE id=$1",[draft.id]);
   const foreign=await one(`INSERT INTO exam_patterns(exam_id,name) VALUES($1,'Other pattern') RETURNING id`,[exam.id]);
   await pool.query('UPDATE tests SET pattern_id=$1 WHERE id=$2',[foreign.id,draft.id]);await assert.rejects(publish(),/section/);
   await pool.query('UPDATE tests SET pattern_id=$1 WHERE id=$2',[pattern.id,draft.id]);
   await pool.query('UPDATE exam_pattern_sections SET negative_marks=NULL WHERE id=$1',[section.id]);await assert.rejects(publish(),/section/);
   await pool.query('UPDATE exam_pattern_sections SET negative_marks=50 WHERE id=$1',[section.id]);
   assert.equal((await pool.query('SELECT * FROM test_question_snapshots WHERE test_id=$1',[draft.id])).rowCount,0);
   assert.equal((await one('SELECT is_published FROM tests WHERE id=$1',[draft.id])).is_published,false);
  });
  await t.test('concurrent publication makes exactly one frozen set; summary-only review stays closed after completion',async()=>{
   const draft=await one(`INSERT INTO tests(exam_id,pattern_id,name,review_policy) VALUES($1,$2,'Concurrent publish','SUMMARY_ONLY') RETURNING id`,[exam.id,pattern.id]);
   await pool.query('INSERT INTO test_questions SELECT $1,question_id,sort_order,section_id FROM test_questions WHERE test_id=$2',[draft.id,id]);
   const results=await Promise.allSettled([as(staff,'SELECT publish_test($1)',[draft.id]),as(staff,'SELECT publish_test($1)',[draft.id])]);
   assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
   assert.match(results.find(x=>x.status==='rejected').reason.message,/already published/);
   assert.equal((await pool.query('SELECT * FROM test_question_snapshots WHERE test_id=$1',[draft.id])).rowCount,3);
   assert.equal((await pool.query('SELECT * FROM test_option_snapshots WHERE test_id=$1',[draft.id])).rowCount,6);
   const attempt=(await as(a,'SELECT start_test_attempt($1) id',[draft.id])).rows[0].id;
   const option=await one('SELECT correct_option_id FROM test_answer_key_snapshots WHERE test_id=$1 AND question_id=$2',[draft.id,qs[0].id]);
   const raced=await Promise.allSettled([as(a,'SELECT save_attempt_answer($1,$2,$3,false,false)',[attempt,qs[0].id,option.correct_option_id]),as(a,'SELECT submit_test_attempt($1)',[attempt])]);
   assert.equal(raced[1].status,'fulfilled');
   if(raced[0].status==='rejected')assert.match(raced[0].reason.message,/finalized/);
   const result=await one('SELECT score FROM test_attempts WHERE id=$1',[attempt]);assert.equal(result.score,raced[0].status==='fulfilled'?'100':'0');
   for(const rpc of ['get_attempt_review','get_attempt_section_performance'])await assert.rejects(as(a,`SELECT * FROM ${rpc}($1)`,[attempt]),/not allowed/);
   assert.equal((await as(a,'SELECT * FROM test_explanation_snapshots WHERE test_id=$1',[draft.id])).rowCount,0);
   assert.equal((await as(staff,'SELECT * FROM get_attempt_review($1)',[attempt])).rowCount,3);
  });
  await t.test('frozen triggers also reject privileged accidental edits and source deletions; API TRUNCATE is denied',async()=>{
   await assert.rejects(pool.query('UPDATE test_question_snapshots SET marks=999 WHERE test_id=$1',[id]),/immutable/);
   await assert.rejects(pool.query('UPDATE test_option_snapshots SET sort_order=99 WHERE test_id=$1',[id]),/immutable/);
   await assert.rejects(pool.query('UPDATE test_explanation_snapshots SET explanation=NULL WHERE test_id=$1',[id]),/immutable/);
   await assert.rejects(as(staff,'DELETE FROM questions WHERE id=$1',[qs[0].id]),/immutable/);
   await assert.rejects(as(a,'TRUNCATE test_explanation_snapshots'),/permission denied/);
   await assert.rejects(admin.query(await readFile('scripts/setup_auth.sql','utf8')),/allowlisted disposable/);
  });
  await t.test('trusted student provisioning reconciles safely and rejects client escalation',async()=>{
   await pool.query('ALTER TABLE auth.users ADD COLUMN raw_user_meta_data jsonb');
   const missing=randomUUID();
   await pool.query('INSERT INTO auth.users(id,raw_user_meta_data) VALUES($1,$2)',[missing,{full_name:'Existing learner',role:'admin'}]);
   const provision='202609130010_student_provisioning.sql';
   await apply(provision);
   assert.equal((await one('SELECT full_name FROM student_profiles WHERE id=$1',[missing])).full_name,'Existing learner');
   assert.equal((await one('SELECT full_name FROM student_profiles WHERE id=$1',[a])).full_name,'A');
   assert.equal((await one('SELECT count(*)::int n FROM student_profiles WHERE id=$1',[staff])).n,0);
   for(const metadata of [{full_name:'New learner',role:'admin',organization_name:'Spoof'},null,{full_name:{bad:true}}]){
    const uid=randomUUID();
    await pool.query('INSERT INTO auth.users(id,raw_user_meta_data) VALUES($1,$2)',[uid,metadata]);
    assert.equal((await one('SELECT full_name FROM student_profiles WHERE id=$1',[uid])).full_name,typeof metadata?.full_name==='string'?metadata.full_name:'');
    assert.equal((await as(uid,'SELECT is_teacher() allowed')).rows[0].allowed,false);
    assert.equal((await as(uid,'SELECT id FROM student_profiles')).rowCount,1);
    assert.equal((await as(uid,'SELECT id FROM student_profiles WHERE id=$1',[a])).rowCount,0);
    await assert.rejects(as(uid,"INSERT INTO teacher_profiles(id,full_name) VALUES($1,'Escalated')",[uid]),/permission denied/);
    await assert.rejects(as(uid,"UPDATE student_profiles SET full_name='Changed' WHERE id=$1",[uid]),/permission denied/);
    await assert.rejects(as(uid,'SELECT ksc_private.provision_student()'),/permission denied/);
   }
   await assert.rejects(as(null,'SELECT * FROM student_profiles',[],'anon'),/permission denied/);
   const before=(await one('SELECT count(*)::int n FROM student_profiles')).n;
   await apply(provision);
   assert.equal((await one('SELECT count(*)::int n FROM student_profiles')).n,before);
   for(const role of ['anon','authenticated','service_role']){
    assert.equal((await one("SELECT has_function_privilege($1,'ksc_private.provision_student()','EXECUTE') allowed",[role])).allowed,false);
   }
  });
 } finally {
  if(pool)await pool.end();
  if(created){await verify(admin);assert.match(db,/^ksc_contract_(clean|upgrade)_[a-f0-9]{32}$/);await admin.query(`DROP DATABASE "${db}"`);console.log('Removed only synthetic database',db);}
  await admin.end();
 }
});
