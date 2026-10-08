// Course fees + Razorpay payments + automatic enrollment (migration 0049) on a throwaway PostgreSQL with the real KSC chain.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createLocalKscDb} from './lib/local-draft-db.mjs'

const CHAIN=['202610020036_staff_accounts.sql','202610020037_creator_accounts.sql','202610020038_student_program_onboarding.sql','202610020039_program_families.sql','202610030040_teaching_result_review.sql','202610030041_student_program_memberships.sql','202610030042_student_enrollment_audit.sql','202610040043_exam_library_delivery.sql','202610060044_library_archive.sql','202610060045_simple_library_sharing.sql','202610060046_program_paper_publishing.sql','202610070047_admin_delete_tests_results.sql','202610070048_navodaya_signup.sql']

test('admins set fees, the server freezes the price, verified payment enrolls the student once',async()=>{
 const db=await createLocalKscDb();try{
  await db.pool.query("ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz, ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb DEFAULT '{}'")
  for(const f of CHAIN)await db.applyMigration(f)
  await db.applyMigration('202610070049_course_fees_payments.sql')
  const admin=db.teacher,teacher=db.otherTeacher,student=randomUUID(),other=randomUUID()
  await db.pool.query("UPDATE ksc_staff_access SET state='active',password_change_required=false,role=CASE WHEN user_id=$1 THEN 'admin' ELSE 'teacher' END",[admin])
  for(const id of [student,other]){await db.pool.query('INSERT INTO auth.users(id,email,email_confirmed_at) VALUES($1,$2,now())',[id,id.slice(0,6)+'@ksc.test']);await db.pool.query("INSERT INTO student_profiles(id,full_name) VALUES($1,$2) ON CONFLICT (id) DO NOTHING",[id,'Student '+id.slice(0,4)])}
  const rpc=(uid,name,args={})=>db.runner.rpc(uid,name,args)
  const svc=async(sql,args)=>(await db.pool.query(sql,args)).rows[0]
  const {examId,levelId}=db.catalogue
  await db.pool.query('INSERT INTO ksc_signup_programs(exam_id,enabled) VALUES($1,true) ON CONFLICT (exam_id) DO UPDATE SET enabled=true',[examId])
  await db.pool.query('UPDATE exam_levels SET is_signup_enabled=true WHERE id=$1',[levelId])

  // Only admins manage fees.
  const plan={exam_id:examId,level_id:'',title:'SI & Constable full course',description:'Complete preparation',features:['Weekly tests',' ','Study material'],duration_label:'6 months',amount_paise:1500000,original_amount_paise:1800000,is_featured:true}
  for(const uid of [null,teacher,student])await assert.rejects(rpc(uid,'ksc_save_fee_plan',{p_plan:plan}),/Administrator access|permission denied/)
  const planId=await rpc(admin,'ksc_save_fee_plan',{p_plan:plan})
  const adminView=await rpc(admin,'ksc_admin_fee_plans')
  assert.deepEqual(adminView.plans[0].features,['Weekly tests','Study material'])
  await assert.rejects(rpc(admin,'ksc_save_fee_plan',{p_plan:{...plan,amount_paise:0}}),/check/i)

  // Anyone can read the public price list (with selectable tracks for a program-wide plan).
  const pub=await rpc(null,'ksc_public_fee_plans')
  assert.equal(pub.length,1);assert.equal(pub[0].amount_paise,1500000);assert.deepEqual(pub[0].tracks.map(t=>t.id),[levelId])

  // Payment server functions are not callable by browsers.
  for(const uid of [null,student,admin])await assert.rejects(rpc(uid,'ksc_payment_begin',{p_user:student,p_plan:planId,p_level:levelId}),/permission denied/)
  for(const uid of [null,student])await assert.rejects(rpc(uid,'ksc_payment_mark_paid',{p_order:'x',p_payment_id:'y'}),/permission denied/)
  // Nobody writes payments directly.
  await assert.rejects(db.runner.asUser(student,c=>c.query("INSERT INTO ksc_payments(user_id,plan_id,level_id,plan_title,amount_paise,receipt) VALUES($1,$2,$3,'x',1,'r')",[student,planId,levelId])),/permission denied/)

  // Staff cannot pay; a track is required.
  await assert.rejects(svc('SELECT ksc_payment_begin($1,$2,$3) r',[teacher,planId,levelId]),/student account/)
  await assert.rejects(svc('SELECT ksc_payment_begin($1,$2,NULL) r',[student,planId]),/class\/track/)
  const begun=(await svc('SELECT ksc_payment_begin($1,$2,$3) r',[student,planId,levelId])).r
  assert.equal(begun.amount_paise,1500000);assert.match(begun.receipt,/^KSC-\d{6}-[0-9A-F]{8}$/)
  await svc('SELECT ksc_payment_attach_order($1,$2)',[begun.payment_id,'order_A'])

  // A later price change does not change the frozen checkout amount.
  await rpc(admin,'ksc_save_fee_plan',{p_plan:{...plan,id:planId,amount_paise:2000000,original_amount_paise:''}})
  assert.equal((await svc('SELECT amount_paise FROM ksc_payments WHERE id=$1',[begun.payment_id])).amount_paise,1500000)

  // Wrong owner / wrong amount refused; not enrolled yet.
  await assert.rejects(svc('SELECT ksc_payment_mark_paid($1,$2,$3,NULL)',['order_A','pay_1',other]),/not found/)
  await assert.rejects(svc('SELECT ksc_payment_mark_paid($1,$2,NULL,$3)',['order_A','pay_1',100]),/does not match/)
  assert.equal((await svc('SELECT count(*)::int n FROM ksc_student_program_memberships WHERE user_id=$1',[student])).n,0)

  // Verified: paid + enrolled + preference set. Repeat (webhook after browser verify) is a no-op.
  const paid=(await svc('SELECT ksc_payment_mark_paid($1,$2,$3,$4) r',['order_A','pay_1',student,1500000])).r
  assert.equal(paid.status,'paid');assert.equal(paid.enrolled,true)
  const again=(await svc('SELECT ksc_payment_mark_paid($1,$2,NULL,NULL) r',['order_A','pay_1'])).r
  assert.equal(again.receipt,paid.receipt)
  await assert.rejects(svc('SELECT ksc_payment_mark_paid($1,$2,NULL,NULL)',['order_A','pay_2']),/different payment/)
  assert.equal((await svc('SELECT count(*)::int n FROM ksc_student_program_memberships WHERE user_id=$1 AND level_id=$2',[student,levelId])).n,1)
  const state=await rpc(student,'ksc_student_program_state')
  assert.equal(state.selection.level_id,levelId)

  // Students see only their own payments; admin sees all.
  assert.equal((await rpc(student,'ksc_my_payments')).length,1)
  assert.equal((await rpc(other,'ksc_my_payments')).length,0)
  assert.equal((await db.runner.asUser(other,c=>c.query('SELECT * FROM ksc_payments'))).rows.length,0)
  const all=await rpc(admin,'ksc_admin_payments',{p_limit:50});assert.equal(all.length,1);assert.equal(all[0].status,'paid')
  await assert.rejects(rpc(teacher,'ksc_admin_payments',{p_limit:50}),/Administrator access/)

  // Failed payments are recorded and never enroll; inactive plans disappear and cannot be bought.
  const b2=(await svc('SELECT ksc_payment_begin($1,$2,$3) r',[other,planId,levelId])).r
  await svc('SELECT ksc_payment_attach_order($1,$2)',[b2.payment_id,'order_B']);await svc('SELECT ksc_payment_mark_failed($1,$2)',['order_B','Card declined'])
  assert.equal((await rpc(other,'ksc_my_payments'))[0].status,'failed')
  assert.equal((await svc('SELECT count(*)::int n FROM ksc_student_program_memberships WHERE user_id=$1',[other])).n,0)
  await rpc(admin,'ksc_save_fee_plan',{p_plan:{...plan,id:planId,is_active:false}})
  assert.equal((await rpc(null,'ksc_public_fee_plans')).length,0)
  await assert.rejects(svc('SELECT ksc_payment_begin($1,$2,$3)',[other,planId,levelId]),/not open/)
 }finally{await db.stop()}
})
