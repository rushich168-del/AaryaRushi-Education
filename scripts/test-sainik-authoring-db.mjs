import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import pg from 'pg'
const target={host:'127.0.0.1',port:54322,user:'postgres',connectionTimeoutMillis:3000,query_timeout:20000}
async function verify(c){const {rows:[r]}=await c.query("SELECT current_setting('data_directory') dir,host(inet_server_addr()) host,inet_server_port() port,system_identifier::text sys FROM pg_control_system()");assert.equal(r.dir.replaceAll('\\','/').toLowerCase(),'c:/kst/.local_pg');assert.equal(r.host,'127.0.0.1');assert.equal(r.port,54322);assert.equal(r.sys,'7684311220310446404')}
test('Sainik setup is repeatable and supports authorized draft/review on real PostgreSQL',async()=>{
 const admin=new pg.Client({...target,database:'postgres'});await admin.connect();let c,created=false;const db='ksc_contract_clean_'+randomUUID().replaceAll('-','')
 try{
  await verify(admin);await admin.query(`CREATE DATABASE "${db}"`);created=true;c=new pg.Client({...target,database:db});await c.connect();await verify(c)
  await c.query(await readFile('scripts/setup_auth.sql','utf8'));await c.query('ALTER TABLE auth.users ADD COLUMN raw_user_meta_data jsonb, ADD COLUMN email_confirmed_at timestamptz')
  await c.query(await readFile('scripts/fixtures/ksc-auto-rls.sql','utf8'))
  await c.query("CREATE EVENT TRIGGER fixture_rls ON ddl_command_end WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') EXECUTE FUNCTION public.rls_auto_enable()")
  for(const file of ['KSC-INSTALL.sql','KSC-LMS-UPGRADE.sql','KSC-TEST-PORTAL-UPGRADE.sql'])await c.query(await readFile('docs/ksc/setup/'+file,'utf8'))
  const setup=await readFile('docs/ksc/setup/KSC-SAINIK-VI-AUTHORING.sql','utf8')
  await c.query(setup);const first=(await c.query('SELECT id FROM syllabi ORDER BY id')).rows
  await c.query(setup);assert.deepEqual((await c.query('SELECT id FROM syllabi ORDER BY id')).rows,first)
  assert.equal(first.length,4)
  assert.deepEqual((await c.query('SELECT name FROM exam_subjects ORDER BY name')).rows.map(r=>r.name),['General Knowledge','Intelligence','Language','Mathematics'])
  assert.equal((await c.query('SELECT count(*)::int n FROM chapters')).rows[0].n,0)
  const {rows:[ctx]}=await c.query("SELECT sy.exam_id,sy.level_id,sy.subject_id,sy.id syllabus_id FROM syllabi sy JOIN exam_subjects s ON s.id=sy.subject_id WHERE s.name='Mathematics'")
  const staff=randomUUID(),student=randomUUID();await c.query('INSERT INTO auth.users(id) VALUES($1),($2)',[staff,student]);await c.query("INSERT INTO teacher_profiles(id,full_name) VALUES($1,'Acceptance teacher')",[staff])
  const as=async(uid,sql,args=[])=>{await c.query('BEGIN; SET LOCAL ROLE authenticated');try{await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[uid]);const r=await c.query(sql,args);await c.query('COMMIT');return r.rows}catch(e){await c.query('ROLLBACK');throw e}}
  const question={...ctx,chapter_id:null,topic_id:null,content:'Acceptance check: 2 + 2 = ?',explanation:'Two plus two is four.',difficulty:'EASY'}
  const save='SELECT ksc_save_question($1,$2,$3,$4) q'
  await assert.rejects(as(student,save,[null,question,JSON.stringify(['3','4']),1]),/Teacher access/)
  await assert.rejects(as(staff,save,[null,question,JSON.stringify(['3','']),1]),/option/)
  assert.equal((await c.query('SELECT count(*)::int n FROM questions')).rows[0].n,0)
  const q=(await as(staff,save,[null,question,JSON.stringify(['3','4']),1]))[0].q
  assert.equal(q.status,'DRAFT');assert.equal(q.syllabus_id,ctx.syllabus_id)
  await as(staff,"UPDATE questions SET status='APPROVED' WHERE id=$1",[q.id])
  assert.equal((await as(staff,'SELECT status FROM questions WHERE id=$1',[q.id]))[0].status,'APPROVED')
  assert.equal((await as(student,'SELECT * FROM questions')).length,0);assert.equal((await as(student,'SELECT * FROM question_answer_keys')).length,0)
  assert.equal((await as(staff,save,[q.id,question,JSON.stringify(['3','4']),1]))[0].q.status,'DRAFT')
  // Existing unrelated active curriculum is reused without competing defaults.
  await c.query("UPDATE syllabi SET name='Institute supplied Mathematics syllabus' WHERE id=$1",[ctx.syllabus_id]);await c.query(setup)
  assert.equal((await c.query('SELECT count(*)::int n FROM syllabi')).rows[0].n,4)
 }finally{if(c)await c.end();if(created){await verify(admin);await admin.query(`DROP DATABASE "${db}"`)}await admin.end()}
})
