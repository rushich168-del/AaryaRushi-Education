import { createClient } from '@supabase/supabase-js'
import { authPortal } from './portalSession.js'

// Capture recovery routing before the SDK consumes the URL and emits its
// one-time event. React may not have mounted its subscriber at that point.
if (typeof window !== 'undefined') {
  const callback = new URL(window.location.href)
  const fragment = new URLSearchParams(callback.hash.slice(1))
  if (fragment.get('type') === 'recovery' || callback.searchParams.get('type') === 'recovery') {
    window.history.replaceState(window.history.state, '', `/reset-password${callback.search}${callback.hash}`)
  }
}

const env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : (typeof process !== 'undefined' ? process.env : {})
const supabaseUrl = env.VITE_SUPABASE_URL
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  { auth: { storageKey: `sb-${new URL(supabaseUrl || 'https://placeholder.supabase.co').hostname}-ksc-${authPortal}-auth-token` } },
)
