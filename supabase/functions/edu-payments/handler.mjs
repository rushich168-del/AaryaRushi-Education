// KSC course payments (Razorpay). Pure handler: Deno entry (index.ts) and Node tests inject the dependencies.
// Actions (POST JSON, student bearer token): create_order, verify, failed.
// Webhook (POST, X-Razorpay-Signature header, no bearer): payment.captured / order.paid / payment.failed.
// The amount always comes from the database (ksc_payment_begin); the browser never sends a price.

const enc = new TextEncoder()
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
const ID = /^[A-Za-z0-9_]{6,64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * deps: { allowedOrigins: string[], keyId, keySecret, webhookSecret?,
 *   getUser(token) -> {id,email,name}|null, rpc(name,args) -> data (throws on error),
 *   razorpayCreateOrder({amount,currency,receipt,notes}) -> {id}, log? }
 */
export function createPaymentsHandler(deps) {
  const log = deps.log || (() => {})
  const cors = origin => ({
    'Access-Control-Allow-Origin': deps.allowedOrigins.includes(origin) ? origin : deps.allowedOrigins[0],
    'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin',
  })
  const json = (status, body, origin) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(origin) } })
  const userMessage = e => {
    const m = String(e?.message || '')
    return /student account|not open|class\/track|Too many|not found|does not match|already paid/i.test(m) ? m : 'Payment could not be processed. Please try again.'
  }

  return async function handle(request) {
    const origin = request.headers.get('origin') || ''
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed' }, origin)
    const raw = await request.text()
    if (raw.length > 20000) return json(413, { error: 'Request too large' }, origin)

    // Razorpay webhook (server to server). Signature over the raw body with the webhook secret.
    const webhookSig = request.headers.get('x-razorpay-signature')
    if (webhookSig) {
      if (!deps.webhookSecret) return json(503, { error: 'Webhook not configured' }, origin)
      if (!safeEqual(await hmacHex(deps.webhookSecret, raw), webhookSig)) return json(401, { error: 'Invalid signature' }, origin)
      let event; try { event = JSON.parse(raw) } catch { return json(400, { error: 'Invalid JSON' }, origin) }
      const p = event?.payload?.payment?.entity
      try {
        if ((event.event === 'payment.captured' || event.event === 'order.paid') && p?.order_id && p?.id) {
          await deps.rpc('ksc_payment_mark_paid', { p_order: p.order_id, p_payment_id: p.id, p_user: null, p_amount_paise: p.amount ?? null })
        } else if (event.event === 'payment.failed' && p?.order_id) {
          await deps.rpc('ksc_payment_mark_failed', { p_order: p.order_id, p_reason: p.error_description || 'Payment failed' })
        }
      } catch (e) { log('webhook', e?.message); /* acknowledge so Razorpay does not retry an unknown order forever */ }
      return json(200, { ok: true }, origin)
    }

    if (!deps.allowedOrigins.includes(origin)) return json(403, { error: 'Origin not allowed' }, origin)
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    const user = token ? await deps.getUser(token).catch(() => null) : null
    if (!user?.id) return json(401, { error: 'Please sign in to continue.' }, origin)
    let body; try { body = JSON.parse(raw || '{}') } catch { return json(400, { error: 'Invalid request' }, origin) }

    try {
      if (body.action === 'create_order') {
        if (!UUID.test(body.plan_id || '') || (body.level_id && !UUID.test(body.level_id))) return json(400, { error: 'Choose a course first.' }, origin)
        const begun = await deps.rpc('ksc_payment_begin', { p_user: user.id, p_plan: body.plan_id, p_level: body.level_id || null })
        const order = await deps.razorpayCreateOrder({ amount: begun.amount_paise, currency: begun.currency, receipt: begun.receipt,
          notes: { ksc_payment_id: begun.payment_id, plan: begun.title.slice(0, 200) } })
        if (!order?.id) throw new Error('Gateway order failed')
        await deps.rpc('ksc_payment_attach_order', { p_payment: begun.payment_id, p_order: order.id })
        return json(200, { key_id: deps.keyId, order_id: order.id, amount: begun.amount_paise, currency: begun.currency, receipt: begun.receipt,
          title: begun.title, prefill: { email: user.email || '', name: user.name || '' } }, origin)
      }
      if (body.action === 'verify') {
        const { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: s } = body
        if (!ID.test(o || '') || !ID.test(p || '') || typeof s !== 'string') return json(400, { error: 'Invalid payment response' }, origin)
        if (!safeEqual(await hmacHex(deps.keySecret, o + '|' + p), s)) return json(400, { error: 'Payment could not be verified. If money was deducted, it will be confirmed automatically or refunded by the bank.' }, origin)
        const result = await deps.rpc('ksc_payment_mark_paid', { p_order: o, p_payment_id: p, p_user: user.id, p_amount_paise: null })
        return json(200, result, origin)
      }
      if (body.action === 'failed') {
        if (!ID.test(body.razorpay_order_id || '')) return json(400, { error: 'Invalid request' }, origin)
        await deps.rpc('ksc_payment_mark_failed', { p_order: body.razorpay_order_id, p_reason: String(body.reason || 'Payment failed').slice(0, 300) })
        return json(200, { ok: true }, origin)
      }
      return json(400, { error: 'Unknown action' }, origin)
    } catch (e) {
      log(body.action, e?.message)
      return json(400, { error: userMessage(e) }, origin)
    }
  }
}
