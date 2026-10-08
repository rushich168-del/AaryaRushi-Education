import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import { requireDisposableTestTarget } from './lib/live-test-guard.mjs'

// P0-A persistence + security checks for the durable Draft Paper tables.
//
// NOTE ON SCOPE: teacher accounts are provisioned out-of-band (signups become
// students via the 0010 trigger), and migration 0017 may not be applied to the
// remote KSC project yet. Full authenticated CRUD is therefore proven by the
// HUMAN browser acceptance (see the P0-A report). These automated tests cover
// what is reliably checkable without a teacher session: the security envelope
// (anon/student cannot read draft tables) and the RPC access guard. When 0017
// is not present remotely the RPC guard test SKIPS with a clear message rather
// than failing — matching the repository's existing test convention.

// Fail-closed live-test guard (incident 2026-09-23): refuses KSC production, unknown, mismatched or
// unapproved targets BEFORE any auth, table or CLI call. See scripts/lib/live-test-guard.mjs.
const { url, key } = requireDisposableTestTarget({ script: 'test-draft-paper-persistence', usesLinkedCli: false })

const DRAFT_TABLES = ['draft_papers', 'draft_materials', 'draft_questions', 'draft_options']

test('anonymous cannot read any draft table', async (t) => {
  if (!url || !key) return t.skip('Missing Supabase credentials in .env.local')
  const anon = createClient(url, key)
  for (const tbl of DRAFT_TABLES) {
    const { data, error } = await anon.from(tbl).select('*').limit(1)
    // Acceptable: RLS blocks (error), returns empty, or table not yet applied (error).
    assert.ok(error || !data || data.length === 0, `Anonymous must not read ${tbl}`)
  }
})

test('freshly signed-up (student) account cannot read draft tables', async (t) => {
  if (!url || !key) return t.skip('Missing Supabase credentials in .env.local')
  const s = createClient(url, key)
  const email = 'student_draft_' + Date.now() + '@test.com'
  const { error: signErr } = await s.auth.signUp({ email, password: 'Password123!' })
  if (signErr) return t.skip('Sign-up unavailable in this environment: ' + signErr.message)
  for (const tbl of DRAFT_TABLES) {
    const { data, error } = await s.from(tbl).select('*').limit(1)
    assert.ok(error || !data || data.length === 0, `Student must not read ${tbl}`)
  }
})

test('draft analysis RPC enforces teacher access (or is not applied yet)', async (t) => {
  if (!url || !key) return t.skip('Missing Supabase credentials in .env.local')
  const s = createClient(url, key)
  const email = 'nonteacher_' + Date.now() + '@test.com'
  await s.auth.signUp({ email, password: 'Password123!' })

  const { error } = await s.rpc('ksc_replace_draft_analysis', {
    p_import_id: '00000000-0000-0000-0000-000000000000',
    p_paper: {},
    p_materials: [],
    p_questions: [],
    p_options: [],
  })

  if (error && /could not find|does not exist|schema cache|function/i.test(error.message)) {
    return t.skip('Migration 0017 not applied to this environment yet: ' + error.message)
  }
  // If the function exists, a non-teacher / bad import must be rejected.
  assert.ok(error, 'RPC must reject a non-teacher / unauthorized import')
})

test('confirm RPC rejects unauthorized callers (or is not applied yet)', async (t) => {
  if (!url || !key) return t.skip('Missing Supabase credentials in .env.local')
  const s = createClient(url, key)
  await s.auth.signUp({ email: 'nonteacher2_' + Date.now() + '@test.com', password: 'Password123!' })
  const { error } = await s.rpc('ksc_confirm_draft_single_choice', {
    p_question_id: '00000000-0000-0000-0000-000000000000',
    p_option_id: null,
  })
  if (error && /could not find|does not exist|schema cache|function/i.test(error.message)) {
    return t.skip('Migration 0017 not applied to this environment yet: ' + error.message)
  }
  assert.ok(error, 'Confirm RPC must reject unauthorized callers')
})
