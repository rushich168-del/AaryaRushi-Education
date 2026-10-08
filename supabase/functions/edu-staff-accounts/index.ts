import { createClient } from 'npm:@supabase/supabase-js@2.110.0'
import { createStaffHandler } from './handler.mjs'

// No default/fallback backend: deployment operator must supply the verified KSC target.
const url = Deno.env.get('SUPABASE_URL') || ''
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
const origins = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean)
if (url !== 'https://REPLACE_WITH_NEW_PROJECT_REF.supabase.co' || !secret || !publicKey || !origins.length) {
  throw new Error('Verified KSC backend, server keys and explicit allowed origins are required')
}
Deno.serve(async request => {
  // Per-request clients avoid auth-session mutation crossing concurrent requests.
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }) } }
  const publicClient = createClient(url, publicKey, options)
  const adminClient = createClient(url, secret, options)
  return createStaffHandler({
    publicClient, adminClient, allowedOrigins: origins,
    rateLimit: async (actor: string) => {
      const { data, error } = await adminClient.rpc('ksc_staff_rate_limit', { p_actor: actor })
      return !error && data === true
    },
  })(request)
})
