import { createClient } from 'npm:@supabase/supabase-js@2.110.0'
import { createPaymentsHandler } from './handler.mjs'

// Required secrets (set with `supabase secrets set`, never committed):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET (optional but recommended), ALLOWED_ORIGINS
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are provided by Supabase.
const url = Deno.env.get('SUPABASE_URL') || ''
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
const keyId = (Deno.env.get('RAZORPAY_KEY_ID') || '').trim()
const keySecret = (Deno.env.get('RAZORPAY_KEY_SECRET') || '').trim()
const webhookSecret = (Deno.env.get('RAZORPAY_WEBHOOK_SECRET') || '').trim()
const origins = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean)
if (url !== 'https://REPLACE_WITH_NEW_PROJECT_REF.supabase.co' || !secret || !publicKey) {
  throw new Error('Verified KSC backend and server keys are required')
}
// Missing Razorpay keys or origins: answer clearly instead of crashing, so the site shows a helpful message.
const configured = Boolean(keyId && keySecret && origins.length)
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
const adminClient = createClient(url, secret, options)
const publicClient = createClient(url, publicKey, options)

const handler = createPaymentsHandler({
  allowedOrigins: origins.length ? origins : ['http://127.0.0.1:5173'], keyId, keySecret, webhookSecret,
  log: (...a: unknown[]) => console.error('[edu-payments]', ...a),
  getUser: async (token: string) => {
    const { data, error } = await publicClient.auth.getUser(token)
    if (error || !data?.user) return null
    return { id: data.user.id, email: data.user.email, name: data.user.user_metadata?.full_name || '' }
  },
  rpc: async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await adminClient.rpc(name, args)
    if (error) throw new Error(error.message)
    return data
  },
  razorpayCreateOrder: async (body: Record<string, unknown>) => {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(keyId + ':' + keySecret) },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error('Razorpay order failed: ' + res.status + (res.status === 401 ? ' (check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are a matching Test pair)' : ''))
    return await res.json()
  },
})
Deno.serve((request: Request) => {
  if (configured) return handler(request)
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-client-info, apikey', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  console.error('[edu-payments] missing secrets:', !keyId ? 'RAZORPAY_KEY_ID ' : '', !keySecret ? 'RAZORPAY_KEY_SECRET ' : '', !origins.length ? 'ALLOWED_ORIGINS' : '')
  return new Response(JSON.stringify({ error: 'Online payment is not switched on yet. Please contact the institute.' }), { status: 503, headers })
})
