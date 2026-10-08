// LOCAL-ONLY subset of the Supabase HTTP protocol over a throwaway KSC PostgreSQL (B4.6/B4.7).
//
// It is NOT PostgREST and NOT Supabase. It implements what the KSC app actually uses:
//   REST   GET/HEAD/POST/PATCH/DELETE /rest/v1/<table>: select lists with nested embeds resolved
//          through foreign keys (both directions), eq/neq/gt/gte/lt/lte/like/ilike/in/is filters,
//          order, limit/offset, Prefer count=exact / return=representation / resolution=merge-duplicates
//          (+on_conflict), single-object Accept.
//   RPC    POST /rest/v1/rpc/<fn> for any public function (arguments by name).
//   STORAGE upload (raw or multipart), download, signed URLs, remove — bucket ksc-source-documents
//          with the 0014 policy evaluated as the caller (is_teacher() + imports/<uid>/ prefix).
// Every statement runs as `authenticated`/`anon` with the caller's sub, so RLS, grants and the
// migrations' SECURITY DEFINER checks are the real ones. Identifiers are validated and quoted;
// values are always bound parameters.

import fs from 'fs'
import path from 'path'

const IDENT = /^[a-z_][a-z0-9_]*$/
const q = s => { if (!IDENT.test(s)) throw Object.assign(new Error(`invalid identifier ${s}`), { status: 400, code: 'PGRST100' }); return `"${s}"` }
const BUCKET = 'ksc-source-documents'

// ---- select parsing: "*, exams(name), draft_options(*, draft_media(*))" --------------------------
export function parseSelect(s) {
  const items = []
  let depth = 0, cur = ''
  for (const ch of String(s || '*').replace(/\s+/g, '')) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) items.push(cur)
  return items.map(it => {
    const m = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)(?:!([a-z_][a-z0-9_]*))?\((.*)\)$/.exec(it)
    if (m) return { embed: true, alias: m[1] || m[2], rel: m[2], hint: m[3] || null, select: parseSelect(m[4] || '*') }
    if (it === '*') return { star: true }
    const c = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)$/.exec(it)
    if (!c) throw Object.assign(new Error(`unsupported select item ${it}`), { status: 400, code: 'PGRST100' })
    return { col: c[2], alias: c[1] || c[2] }
  })
}

export function createRestHandler({ runner, storageDir, storageMap, sign, verifyStorageToken }) {
  const fkCache = { rows: null }
  async function fks() {
    if (!fkCache.rows) {
      fkCache.rows = (await runner.pool.query(`SELECT tc.relname AS from_table, a.attname AS from_col, rc.relname AS to_table, ra.attname AS to_col, con.conname
        FROM pg_constraint con JOIN pg_class tc ON tc.oid = con.conrelid JOIN pg_class rc ON rc.oid = con.confrelid
        JOIN pg_namespace n ON n.oid = tc.relnamespace JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
        JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[1]
        WHERE con.contype = 'f' AND n.nspname = 'public' AND rn.nspname = 'public' AND array_length(con.conkey, 1) = 1`)).rows
    }
    return fkCache.rows
  }
  // SQL select list for `table AS alias`, embeds as correlated json subqueries (RLS applies inside).
  async function selectList(table, alias, items, depth = 0) {
    const out = []
    for (const it of items) {
      if (it.star) { out.push(`${alias}.*`); continue }
      if (!it.embed) { out.push(`${alias}.${q(it.col)} AS ${q(it.alias)}`); continue }
      const all = await fks()
      const sub = `t${depth + 1}`
      const toOne = all.find(f => f.from_table === table && f.to_table === it.rel && (!it.hint || f.conname === it.hint || f.from_col === it.hint))
      const toMany = all.find(f => f.from_table === it.rel && f.to_table === table && (!it.hint || f.conname === it.hint || f.from_col === it.hint))
      if (!toOne && !toMany) throw Object.assign(new Error(`Could not find a relationship between '${table}' and '${it.rel}'`), { status: 400, code: 'PGRST200' })
      const inner = await selectList(it.rel, sub, it.select, depth + 1)
      if (toOne) out.push(`(SELECT row_to_json(x) FROM (SELECT ${inner} FROM public.${q(it.rel)} ${sub} WHERE ${sub}.${q(toOne.to_col)} = ${alias}.${q(toOne.from_col)} LIMIT 1) x) AS ${q(it.alias)}`)
      else out.push(`(SELECT coalesce(json_agg(row_to_json(x)), '[]'::json) FROM (SELECT ${inner} FROM public.${q(it.rel)} ${sub} WHERE ${sub}.${q(toMany.from_col)} = ${alias}.${q(toMany.to_col)}) x) AS ${q(it.alias)}`)
    }
    return out.join(', ')
  }
  const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' }
  function whereClause(params, values, alias = 't0') {
    const conds = []
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(k)) continue
      if (k.includes('.')) throw Object.assign(new Error(`embedded filters are not supported locally (${k})`), { status: 400, code: 'PGRST100' })
      const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.(.*)$/s.exec(v)
      if (!m) throw Object.assign(new Error(`unsupported filter ${k}=${v}`), { status: 400, code: 'PGRST100' })
      const [, not, op, raw] = m
      let cond
      if (op === 'is') {
        const val = raw.toLowerCase()
        if (!['null', 'true', 'false'].includes(val)) throw Object.assign(new Error('bad is filter'), { status: 400 })
        cond = `${alias}.${q(k)} IS ${val.toUpperCase()}`
      } else if (op === 'in') {
        const list = (raw.replace(/^\(|\)$/g, '').match(/"(?:[^"\\]|\\.)*"|[^,]+/g) || []).map(s => s.replace(/^"|"$/g, ''))
        values.push(list); cond = `${alias}.${q(k)}::text = ANY($${values.length}::text[])`
      } else {
        values.push(op.endsWith('like') ? raw.replace(/\*/g, '%') : raw)
        cond = `${alias}.${q(k)}::text ${OPS[op]} $${values.length}`
      }
      conds.push(not ? `NOT (${cond})` : cond)
    }
    return conds.length ? ` WHERE ${conds.join(' AND ')}` : ''
  }
  function orderClause(v, alias = 't0') {
    if (!v) return ''
    return ' ORDER BY ' + v.split(',').map(t => {
      const [col, dir = 'asc', nulls] = t.split('.')
      if (!['asc', 'desc'].includes(dir)) throw Object.assign(new Error('bad order'), { status: 400 })
      return `${alias}.${q(col)} ${dir.toUpperCase()}${nulls === 'nullsfirst' ? ' NULLS FIRST' : nulls === 'nullslast' ? ' NULLS LAST' : ''}`
    }).join(', ')
  }
  async function tableColumns(table) {
    const { rows } = await runner.pool.query(`SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped`, [table])
    if (!rows.length) throw Object.assign(new Error(`relation "public.${table}" does not exist`), { status: 404, code: '42P01' })
    return new Set(rows.map(r => r.attname))
  }
  async function primaryKey(table) {
    const { rows } = await runner.pool.query(`SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey) WHERE i.indisprimary AND n.nspname = 'public' AND c.relname = $1`, [table])
    return rows.map(r => r.attname)
  }

  async function rest({ method, table, url, headers, body, uid }) {
    const params = url.searchParams
    const prefer = String(headers.prefer || '')
    const wantsObject = /vnd\.pgrst\.object/.test(String(headers.accept || ''))
    const cols = await tableColumns(table)
    const result = (rows, extra = {}) => {
      if (wantsObject) {
        if (rows.length !== 1) return { status: 406, body: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null } }
        return { status: extra.status || 200, body: rows[0], headers: extra.headers }
      }
      return { status: extra.status || 200, body: rows, headers: extra.headers }
    }
    if (method === 'GET' || method === 'HEAD') {
      const values = []
      const list = await selectList(table, 't0', parseSelect(params.get('select') || '*'))
      const where = whereClause(params, values)
      const limit = params.get('limit') ? ` LIMIT ${Number(params.get('limit'))}` : ''
      const offset = params.get('offset') ? ` OFFSET ${Number(params.get('offset'))}` : ''
      const out = await runner.asUser(uid, async c => {
        const rows = method === 'HEAD' ? [] : (await c.query(`SELECT ${list} FROM public.${q(table)} t0${where}${orderClause(params.get('order'))}${limit}${offset}`, values)).rows
        const count = /count=exact/.test(prefer) ? Number((await c.query(`SELECT count(*) AS n FROM public.${q(table)} t0${where}`, values)).rows[0].n) : null
        return { rows, count }
      })
      const from = Number(params.get('offset') || 0)
      const range = `${out.rows.length ? `${from}-${from + out.rows.length - 1}` : '*'}/${out.count ?? '*'}`
      return result(out.rows, { headers: { 'Content-Range': range } })
    }
    const rowsIn = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : []
    const returning = /return=representation/.test(prefer)
    if (method === 'POST') {
      const keys = [...new Set(rowsIn.flatMap(r => Object.keys(r)))]
      keys.forEach(k => { if (!cols.has(k)) throw Object.assign(new Error(`Could not find the '${k}' column of '${table}'`), { status: 400, code: 'PGRST204' }) })
      const colSql = keys.map(q).join(', ')
      let sql = `INSERT INTO public.${q(table)} (${colSql}) SELECT ${colSql} FROM json_populate_recordset(NULL::public.${q(table)}, $1::json)`
      if (/resolution=merge-duplicates|resolution=ignore-duplicates/.test(prefer)) {
        const target = params.get('on_conflict') ? params.get('on_conflict').split(',') : await primaryKey(table)
        const upd = keys.filter(k => !target.includes(k))
        sql += ` ON CONFLICT (${target.map(q).join(', ')}) ` + (/ignore-duplicates/.test(prefer) || !upd.length ? 'DO NOTHING' : `DO UPDATE SET ${upd.map(k => `${q(k)} = EXCLUDED.${q(k)}`).join(', ')}`)
      }
      const rows = await runner.asUser(uid, c => c.query(`${sql} RETURNING *`, [JSON.stringify(rowsIn)]).then(r => r.rows))
      return returning ? result(rows, { status: 201 }) : { status: 201, body: null }
    }
    if (method === 'PATCH') {
      const keys = Object.keys(rowsIn[0] || {})
      if (!keys.length) throw Object.assign(new Error('empty PATCH'), { status: 400 })
      keys.forEach(k => { if (!cols.has(k)) throw Object.assign(new Error(`Could not find the '${k}' column of '${table}'`), { status: 400, code: 'PGRST204' }) })
      const values = [JSON.stringify(rowsIn[0])]
      const where = whereClause(params, values)
      const rows = await runner.asUser(uid, c => c.query(`UPDATE public.${q(table)} t0 SET ${keys.map(k => `${q(k)} = p.${q(k)}`).join(', ')}
        FROM json_populate_record(NULL::public.${q(table)}, $1::json) p${where} RETURNING t0.*`, values).then(r => r.rows))
      return returning ? result(rows) : { status: 204, body: null }
    }
    if (method === 'DELETE') {
      const values = []
      const where = whereClause(params, values)
      const rows = await runner.asUser(uid, c => c.query(`DELETE FROM public.${q(table)} t0${where} RETURNING t0.*`, values).then(r => r.rows))
      return returning ? result(rows) : { status: 204, body: null }
    }
    return { status: 405, body: { message: `${method} not supported locally` } }
  }

  // ---- storage ------------------------------------------------------------------------------
  // The 0014 policy, evaluated as the caller: teacher, and the object lives under imports/<uid>/.
  async function mayUse(uid, objectPath) {
    if (!uid || !objectPath.startsWith(`imports/${uid}/`) || objectPath.includes('..')) return false
    return runner.asUser(uid, c => c.query('SELECT public.is_teacher() AS t').then(r => r.rows[0].t === true))
  }
  function fileFor(objectPath) { return path.join(storageDir, ...objectPath.split('/')) }
  function extractUpload(headers, raw) {
    const ct = String(headers['content-type'] || '')
    const m = /multipart\/form-data;\s*boundary=(.+)$/.exec(ct)
    if (!m) return { bytes: raw, contentType: ct || 'application/octet-stream' }
    const boundary = Buffer.from(`--${m[1].replace(/^"|"$/g, '')}`)
    let at = raw.indexOf(boundary)
    while (at > -1) {
      const next = raw.indexOf(boundary, at + boundary.length)
      if (next < 0) break
      const part = raw.subarray(at + boundary.length + 2, next - 2)
      const sep = part.indexOf('\r\n\r\n')
      const head = part.subarray(0, sep).toString()
      if (/filename=/.test(head) || /name=""/.test(head)) {
        const type = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || 'application/octet-stream'
        return { bytes: part.subarray(sep + 4), contentType: type }
      }
      at = next
    }
    throw Object.assign(new Error('No file in multipart upload'), { status: 400 })
  }
  async function storage({ method, url, headers, raw, uid }) {
    const p = url.pathname.replace(/^\/storage\/v1/, '')
    const mUpload = /^\/object\/([^/]+)\/(.+)$/.exec(p)
    const signOne = /^\/object\/sign\/([^/]+)\/(.+)$/.exec(p)
    const signMany = /^\/object\/sign\/([^/]+)$/.exec(p)
    const authed = /^\/object\/authenticated\/([^/]+)\/(.+)$/.exec(p)
    const removeMany = /^\/object\/([^/]+)$/.exec(p)
    const bucketOk = b => b === BUCKET
    const signedPath = (objectPath, expiresIn) => { const exp = Math.floor(Date.now() / 1000) + Number(expiresIn || 300); return `/object/sign/${BUCKET}/${objectPath}?token=${sign(`${objectPath}|${exp}`)}.${exp}` }
    const body = () => (raw && raw.length ? JSON.parse(raw.toString('utf8')) : {})
    if (method === 'GET' && signOne && bucketOk(signOne[1])) {
      const objectPath = decodeURIComponent(signOne[2])
      if (!verifyStorageToken(objectPath, url.searchParams.get('token')) || !storageMap[objectPath]) return { status: 400, body: { statusCode: '403', error: 'invalid_signature', message: 'Invalid or expired signed URL' } }
      return { status: 200, file: storageMap[objectPath] }
    }
    if (method === 'POST' && signMany && bucketOk(signMany[1])) {
      const { paths = [], expiresIn } = body()
      const out = []
      for (const objectPath of paths) out.push(storageMap[objectPath] && await mayUse(uid, objectPath) ? { path: objectPath, signedURL: signedPath(objectPath, expiresIn), error: null } : { path: objectPath, signedURL: null, error: 'Object not found' })
      return { status: 200, body: out }
    }
    if (method === 'POST' && signOne && bucketOk(signOne[1])) {
      const objectPath = decodeURIComponent(signOne[2])
      return storageMap[objectPath] && await mayUse(uid, objectPath) ? { status: 200, body: { signedURL: signedPath(objectPath, body().expiresIn) } } : { status: 400, body: { statusCode: '404', error: 'not_found', message: 'Object not found' } }
    }
    if (method === 'GET' && authed && bucketOk(authed[1])) {
      const objectPath = decodeURIComponent(authed[2])
      return storageMap[objectPath] && await mayUse(uid, objectPath) ? { status: 200, file: storageMap[objectPath] } : { status: 400, body: { statusCode: '404', error: 'not_found', message: 'Object not found' } }
    }
    if (method === 'DELETE' && removeMany && bucketOk(removeMany[1])) {
      const { prefixes = [] } = body()
      const removed = []
      for (const objectPath of prefixes) if (storageMap[objectPath] && await mayUse(uid, objectPath)) { try { fs.rmSync(storageMap[objectPath]) } catch {} delete storageMap[objectPath]; removed.push({ name: objectPath }) }
      return { status: 200, body: removed }
    }
    if ((method === 'POST' || method === 'PUT') && mUpload && bucketOk(mUpload[1])) {
      const objectPath = decodeURIComponent(mUpload[2])
      if (!await mayUse(uid, objectPath)) return { status: 403, body: { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' } }
      const upsert = String(headers['x-upsert'] || 'false') === 'true' || method === 'PUT'
      if (storageMap[objectPath] && !upsert) return { status: 409, body: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } }
      const { bytes } = extractUpload(headers, raw)
      const file = fileFor(objectPath)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes)
      storageMap[objectPath] = file
      return { status: 200, body: { Key: `${BUCKET}/${objectPath}`, Id: objectPath } }
    }
    return { status: 404, body: { statusCode: '404', error: 'not_found', message: 'Not available in the local backend' } }
  }

  return { rest, storage }
}
