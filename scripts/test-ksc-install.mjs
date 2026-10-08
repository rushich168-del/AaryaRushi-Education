import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';

const target={host:'127.0.0.1',port:54322,user:'postgres',connectionTimeoutMillis:3000,query_timeout:20000};
async function verify(c){
 const {rows:[r]}=await c.query("SELECT current_setting('data_directory') dir,host(inet_server_addr()) host,inet_server_port() port,system_identifier::text sys FROM pg_control_system()");
 assert.equal(r.dir.replaceAll('\\','/').toLowerCase(),'c:/kst/.local_pg');
 assert.equal(r.host,'127.0.0.1');assert.equal(r.port,54322);assert.equal(r.sys,'7684311220310446404');
}
const install=await readFile('docs/ksc/setup/KSC-INSTALL.sql','utf8');
const fixture=await readFile('scripts/fixtures/ksc-auto-rls.sql','utf8');
for(const scenario of ['complete','existing table','modified RLS','unknown definer']) test(`combined installer: ${scenario}`,async()=>{
 const admin=new pg.Client({...target,database:'postgres'});await admin.connect();
 const db='ksc_contract_clean_'+randomUUID().replaceAll('-','');let c,created=false;
 try{
  await verify(admin);await admin.query(`CREATE DATABASE "${db}"`);created=true;
  c=new pg.Client({...target,database:db});await c.connect();await verify(c);
  await c.query(await readFile('scripts/setup_auth.sql','utf8'));
  await c.query('ALTER TABLE auth.users ADD COLUMN raw_user_meta_data jsonb, ADD COLUMN email_confirmed_at timestamptz');
  // Model projects without historical API default grants.
  await c.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon,authenticated,service_role');
  await c.query(fixture);
  await c.query("CREATE EVENT TRIGGER fixture_rls ON ddl_command_end WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') EXECUTE FUNCTION public.rls_auto_enable()");
  if(scenario==='existing table')await c.query('CREATE TABLE public.atlas_sentinel(id int)');
  if(scenario==='modified RLS')await c.query("CREATE OR REPLACE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN NULL; END $$");
  if(scenario==='unknown definer')await c.query('CREATE FUNCTION public.unreviewed() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$');
  if(scenario!=='complete'){
   await assert.rejects(c.query(install),scenario==='existing table'?/Fresh KSC target/:scenario==='modified RLS'?/differs from reviewed/:/Unrecognized definer/);
   await c.query('ROLLBACK');
   assert.equal((await c.query("SELECT to_regclass('public.student_profiles') value")).rows[0].value,null);
   return;
  }
  await c.query(install);
  const uid=randomUUID();await c.query('INSERT INTO auth.users(id,raw_user_meta_data) VALUES($1,$2)',[uid,{full_name:'Installer learner',role:'admin'}]);
  assert.equal((await c.query('SELECT full_name FROM student_profiles WHERE id=$1',[uid])).rows[0].full_name,'Installer learner');
  await c.query('BEGIN; SET LOCAL ROLE authenticated');
  await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[uid]);
  assert.equal((await c.query('SELECT * FROM student_profiles')).rowCount,1);
  assert.equal((await c.query('SELECT is_teacher() value')).rows[0].value,false);
  await c.query('COMMIT');
  assert.equal((await c.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity")).rows[0].n,0);
  await c.query('CREATE TABLE public.future_rls_probe(id int)');
  assert.equal((await c.query("SELECT relrowsecurity FROM pg_class WHERE oid='future_rls_probe'::regclass")).rows[0].relrowsecurity,true);
  for(const role of ['anon','authenticated','service_role'])assert.equal((await c.query("SELECT has_function_privilege($1,'public.rls_auto_enable()','execute') value",[role])).rows[0].value,false);
  assert.equal((await c.query("SELECT has_table_privilege('authenticated','test_answer_key_snapshots','INSERT') value")).rows[0].value,false);
  await assert.rejects(c.query(install),/Fresh KSC target/);await c.query('ROLLBACK');
  assert.equal((await c.query('SELECT count(*)::int n FROM student_profiles')).rows[0].n,1);
  // Exercise the exact operator script against the installed baseline.
  const grantTemplate=await readFile('docs/ksc/setup/KSC-GRANT-TEACHER.sql','utf8');
  const grant=grantTemplate.replace("target_id uuid := '00000000-0000-0000-0000-000000000000'",`target_id uuid := '${uid}'`)
    .replace("expected_email text := 'REPLACE_WITH_CONFIRMED_ACCOUNT_EMAIL'", "expected_email text := 'staff@example.com'");
  await assert.rejects(c.query(grantTemplate),/Select the intended/);await c.query('ROLLBACK');
  await c.query("UPDATE auth.users SET email='staff@example.com' WHERE id=$1",[uid]);
  await assert.rejects(c.query(grant),/identity mismatch or email not confirmed/);await c.query('ROLLBACK');
  await c.query('UPDATE auth.users SET email_confirmed_at=now() WHERE id=$1',[uid]);
  await assert.rejects(c.query(grant.replace("expected_email text := 'staff@example.com'","expected_email text := 'wrong@example.com'")),/identity mismatch/);await c.query('ROLLBACK');
  for(const role of ['anon','authenticated','service_role']){
    await c.query(`SET ROLE ${role}`);
    await assert.rejects(c.query(grant),/Trusted database owner|permission denied/);
    await c.query('ROLLBACK; RESET ROLE');
  }
  await c.query(grant);await c.query(grant);
  assert.equal((await c.query('SELECT count(*)::int n FROM teacher_profiles WHERE id=$1',[uid])).rows[0].n,1);
  assert.equal((await c.query('SELECT full_name FROM student_profiles WHERE id=$1',[uid])).rows[0].full_name,'Installer learner');
  await c.query('BEGIN; SET LOCAL ROLE authenticated');
  await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[uid]);
  assert.equal((await c.query('SELECT is_teacher() value')).rows[0].value,true);
  await c.query('COMMIT');
  const learner=randomUUID();await c.query('INSERT INTO auth.users(id) VALUES($1)',[learner]);
  await c.query('BEGIN; SET LOCAL ROLE authenticated');
  await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[learner]);
  assert.equal((await c.query('SELECT is_teacher() value')).rows[0].value,false);
  await assert.rejects(c.query("INSERT INTO teacher_profiles(id,full_name) VALUES($1,'Spoof')",[learner]),/permission denied/);
  await c.query('ROLLBACK');
 }finally{
  if(c)await c.end();
  if(created){await verify(admin);await admin.query(`DROP DATABASE "${db}"`);}
  await admin.end();
 }
});
