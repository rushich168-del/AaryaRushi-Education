// Local-only PostgreSQL helpers for the throwaway KSC database (never a remote target).
//
// Every call runs in its own transaction as role `authenticated` (or `anon`) with
// request.jwt.claim.sub set, exactly like Supabase's API gateway, so RLS, grants, SECURITY DEFINER
// RPCs and triggers behave as defined by the migrations.

export function createPgRunner(pool) {
  const fnCache = new Map()
  async function asUser(uid, fn) {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(uid ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon')
      if (uid) await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid])
      const out = await fn(c)
      await c.query('COMMIT')
      return out
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
  }
  // Public functions by name: argument names/types, set-returning, return type kind.
  async function functionsNamed(name) {
    if (!fnCache.has(name)) {
      const { rows } = await pool.query(`SELECT p.oid, p.proname, coalesce(p.proargnames, '{}') AS names, p.pronargs, p.pronargdefaults,
          array(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS types, p.proretset,
          t.typtype, format_type(p.prorettype, NULL) AS rettype
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_type t ON t.oid = p.prorettype
        WHERE n.nspname = 'public' AND p.proname = $1`, [name])
      fnCache.set(name, rows)
    }
    return fnCache.get(name)
  }
  // Call a public function with named arguments, PostgREST-style result shape.
  async function rpc(uid, name, args = {}) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw Object.assign(new Error(`Invalid function name ${name}`), { code: 'PGRST202', status: 404 })
    const keys = Object.keys(args || {})
    const cands = (await functionsNamed(name)).filter(f => keys.every(k => f.names.includes(k)) && (f.pronargs - f.pronargdefaults) <= keys.length)
    if (!cands.length) throw Object.assign(new Error(`Could not find the function public.${name}(${keys.join(', ')})`), { code: 'PGRST202', status: 404 })
    const f = cands[0]
    const values = [], parts = []
    for (const k of keys) {
      const type = f.types[f.names.indexOf(k)]
      const v = args[k]
      values.push(v === null || v === undefined ? null : (typeof v === 'object' && !Array.isArray(v)) || (Array.isArray(v) && /json/.test(type)) ? JSON.stringify(v) : v)
      parts.push(`${k} => $${values.length}::${type}`)
    }
    const call = `public.${name}(${parts.join(', ')})`
    return asUser(uid, async c => {
      if (f.proretset) return (await c.query(`SELECT * FROM ${call}`, values)).rows
      if (f.typtype === 'c') return (await c.query(`SELECT * FROM ${call}`, values)).rows[0] ?? null
      if (f.rettype === 'void') { await c.query(`SELECT ${call}`, values); return null }
      return (await c.query(`SELECT ${call} AS r`, values)).rows[0].r
    })
  }
  return { asUser, rpc, pool }
}

// Flat Draft rows (the same shape the browser's draftReviewService.loadDraft returns), read as the teacher.
export async function readDraftFlatAs(runner, uid, paperId) {
  return runner.asUser(uid, async c => {
    const q = (sql, args = [paperId]) => c.query(sql, args).then(r => r.rows)
    const questions = await q('SELECT * FROM public.draft_questions WHERE draft_paper_id = $1 ORDER BY position')
    const ids = questions.map(x => x.id)
    const options = await q('SELECT * FROM public.draft_options WHERE draft_question_id = ANY($1::uuid[])', [ids])
    return {
      paper: (await q('SELECT * FROM public.draft_papers WHERE id = $1'))[0] || null,
      questions, options,
      questionTexts: await q('SELECT * FROM public.draft_question_texts WHERE draft_question_id = ANY($1::uuid[])', [ids]),
      optionTexts: await q('SELECT * FROM public.draft_option_texts WHERE draft_option_id = ANY($1::uuid[])', [options.map(o => o.id)]),
      media: await q('SELECT * FROM public.draft_media WHERE draft_paper_id = $1'),
      materials: await q('SELECT * FROM public.draft_materials WHERE draft_paper_id = $1 ORDER BY position'),
      materialTexts: await q('SELECT mx.* FROM public.draft_material_texts mx JOIN public.draft_materials m ON m.id = mx.draft_material_id WHERE m.draft_paper_id = $1'),
    }
  })
}
