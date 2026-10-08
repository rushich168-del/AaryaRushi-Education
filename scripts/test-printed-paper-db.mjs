import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createLocalKscDb } from './lib/local-draft-db.mjs'
import { printedContent } from '../src/services/printedPaperContract.js'

test('printed paper: private drafts → atomic publication → student attempt and score', async () => {
  const db = await createLocalKscDb()
  try {
    const rpc = (uid, name, args) => db.runner.rpc(uid, name, args)
    const student = randomUUID()
    await db.pool.query("INSERT INTO auth.users(id,email) VALUES($1,'printed-student@ksc.local')", [student])
    const subject = (await db.pool.query("INSERT INTO exam_subjects(exam_id,name) VALUES($1,'General paper') RETURNING id", [db.catalogue.examId])).rows[0].id
    const metadata = { name: 'Printed test', exam_id: db.catalogue.examId, subject_id: subject, level_id: db.catalogue.levelId, duration_minutes: 60, marks: 2, negative_marks: 0.5, expected_count: 2 }
    const questions = [0, 1].map(position => ({ position, number: position + 1, content: printedContent([{ type: 'text', text: `తెలుగు question ${position + 1}` }]), options: ['A','B','C','D'], correct: position }))
    const create = () => rpc(db.teacher, 'ksc_save_printed_paper', { p_id: null, p_metadata: metadata, p_questions: questions, p_revision: null })
    let paper = await create()
    // Version 2 reviews survive save/reopen and cannot be bypassed by calling
    // publication directly. Failed review rolls back every downstream write.
    let flagged=await rpc(db.teacher,'ksc_save_printed_paper',{p_id:null,p_revision:null,p_metadata:{...metadata,review_version:2},p_questions:questions.map(q=>({...q,reviewReasons:q.position===0?['Check boundary']:[],reviewConfirmed:false}))})
    await assert.rejects(rpc(db.teacher,'ksc_publish_printed_paper',{p_id:flagged.id,p_revision:flagged.revision,p_reviewed:true}),/still needs teacher review/)
    assert.equal(Number((await db.pool.query('SELECT count(*) FROM tests')).rows[0].count),0)
    flagged=await rpc(db.teacher,'ksc_save_printed_paper',{p_id:flagged.id,p_revision:flagged.revision,p_metadata:null,p_questions:questions.map(q=>({...q,number:q.position===1?3:1,reviewReasons:[],reviewConfirmed:true}))})
    await assert.rejects(rpc(db.teacher,'ksc_publish_printed_paper',{p_id:flagged.id,p_revision:flagged.revision,p_reviewed:true}),/numbering needs review/)
    assert.equal(Number((await db.pool.query('SELECT count(*) FROM tests')).rows[0].count),0)
    const publish = (uid = db.teacher, revision = paper.revision, reviewed = true) => rpc(uid, 'ksc_publish_printed_paper', { p_id: paper.id, p_revision: revision, p_reviewed: reviewed })
    await assert.rejects(publish(student), /Teacher access/)
    await assert.rejects(publish(db.otherTeacher), /Paper not found/)
    await assert.rejects(publish(db.teacher, paper.revision, false), /Review/)
    await assert.rejects(publish(db.teacher, paper.revision - 1), /Review/)
    const hidden = await db.runner.asUser(student, c => c.query('SELECT * FROM printed_paper_questions'))
    assert.equal(hidden.rows.length, 0)
    await assert.rejects(db.runner.asUser(db.teacher, c => c.query('UPDATE printed_papers SET test_id=gen_random_uuid() WHERE id=$1', [paper.id])), /permission denied/)
    paper = await rpc(db.teacher, 'ksc_save_printed_paper', { p_id: paper.id, p_metadata: null, p_questions: [{ ...questions[1], correct: null }], p_revision: paper.revision })
    await assert.rejects(publish(), /valid answer/)
    assert.equal(Number((await db.pool.query('SELECT count(*) FROM tests')).rows[0].count), 0)
    paper = await rpc(db.teacher, 'ksc_save_printed_paper', { p_id: paper.id, p_metadata: null, p_questions: [questions[1]], p_revision: paper.revision })
    const [testId, duplicate] = await Promise.all([publish(), publish()])
    assert.equal(testId, duplicate)
    assert.equal(Number((await db.pool.query('SELECT count(*) FROM tests')).rows[0].count), 1)
    await assert.rejects(rpc(db.teacher, 'ksc_save_printed_paper', { p_id: paper.id, p_metadata: metadata, p_questions: null, p_revision: paper.revision }), /cannot be changed/)
    const available = await db.runner.asUser(student, c => c.query('SELECT id FROM tests WHERE is_published AND snapshot_contract_version=1'))
    assert.equal(available.rows[0].id, testId)
    const attempt = await rpc(student, 'start_test_attempt', { p_test_id: testId })
    const snapshots = await db.runner.asUser(student, c => c.query('SELECT * FROM test_question_snapshots WHERE test_id=$1 ORDER BY sort_order', [testId]))
    assert.equal(snapshots.rows.length, 2)
    assert.equal(snapshots.rows[0].content, questions[0].content)
    const hiddenKeys = await db.runner.asUser(student, c => c.query('SELECT * FROM test_answer_key_snapshots'))
    assert.equal(hiddenKeys.rows.length, 0)
    const options = (await db.pool.query('SELECT * FROM test_option_snapshots WHERE test_id=$1 AND question_id=$2 ORDER BY sort_order', [testId, snapshots.rows[0].question_id])).rows
    await rpc(student, 'save_attempt_answer', { p_attempt_id: attempt, p_question_id: snapshots.rows[0].question_id, p_option_id: options[0].id, p_is_marked: false, p_clear: false })
    await rpc(student, 'submit_test_attempt', { p_attempt_id: attempt })
    const result = (await db.pool.query('SELECT * FROM test_attempts WHERE id=$1', [attempt])).rows[0]
    assert.equal(result.status, 'SUBMITTED')
    assert.equal(Number(result.score), 2)
    console.log('Verified teacher-only draft, stale/review gates, rollback, idempotency, student visibility, key privacy, real attempt and scoring.')
    // Full-size real-source data; review here is a simulated local test, never a live teacher decision.
    const golden = JSON.parse(fs.readFileSync('scratch/printed-paper/test10.json'))
    let full = await rpc(db.teacher, 'ksc_save_printed_paper', { p_id: null, p_revision: null, p_metadata: { ...metadata, name: 'SI Constable Test 10 - local verification', expected_count: 200 }, p_questions: null })
    for (let i = 0; i < golden.questions.length; i += 10) full = await rpc(db.teacher, 'ksc_save_printed_paper', { p_id: full.id, p_revision: full.revision, p_metadata: null, p_questions: golden.questions.slice(i,i+10).map((q,k)=>({...q,position:i+k})) })
    const fullTest = await rpc(db.teacher, 'ksc_publish_printed_paper', { p_id: full.id, p_revision: full.revision, p_reviewed: true })
    const counts = await db.runner.asUser(student, c => c.query('SELECT (SELECT count(*) FROM test_question_snapshots WHERE test_id=$1) questions,(SELECT count(*) FROM test_option_snapshots WHERE test_id=$1) options', [fullTest]))
    assert.equal(Number(counts.rows[0].questions),200); assert.equal(Number(counts.rows[0].options),800)
    console.log('Real Test 10: all 200 printed questions and 800 answer buttons published and readable by student locally.')
    flagged=await rpc(db.teacher,'ksc_save_printed_paper',{p_id:flagged.id,p_revision:flagged.revision,p_metadata:null,p_questions:questions.map(q=>({...q,reviewReasons:['Check boundary'],reviewConfirmed:true,edited:true}))})
    const checkedTest=await rpc(db.teacher,'ksc_publish_printed_paper',{p_id:flagged.id,p_revision:flagged.revision,p_reviewed:true})
    assert.ok(checkedTest)
    const confirmed=(await db.runner.asUser(db.teacher,c=>c.query('SELECT question FROM printed_paper_questions WHERE paper_id=$1 ORDER BY position',[flagged.id]))).rows
    assert.ok(confirmed.every(r=>r.question.reviewConfirmed===true))
    console.log('V2 review: unresolved review and numbering rejected atomically; corrected, checked questions publish and persist.')
  } finally { await db.stop() }
})
