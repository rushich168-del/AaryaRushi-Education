import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { isSupabaseConfigured, supabase } from '../lib/supabaseClient.js'
import { recoveryPath } from '../lib/portalSession.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const authRevision = useRef(0)
  const authPending = useRef(false)
  const rejectedUserId = useRef(null)

  useEffect(() => {
    let active = true
    let authEventReceived = false
    const initialRevision = authRevision.current

    async function loadSession() {
      if (!isSupabaseConfigured) {
        setLoading(false)
        return
      }

      try {
        const sessionPromise = supabase.auth.getSession()
        const timeoutPromise = new Promise((resolve) =>
          setTimeout(() => resolve({ data: { session: null }, error: new Error('Auth session check timed out') }), 4000)
        )
        const { data, error } = await Promise.race([sessionPromise, timeoutPromise])
        if (error) {
          console.warn('[AuthContext] Failed to get auth session:', error.message)
        }
        if (active && !authEventReceived && authRevision.current === initialRevision) {
          setSession(data?.session || null)
        }
      } catch (err) {
        console.warn('[AuthContext] Unexpected auth session failure:', err)
        if (active && !authEventReceived && authRevision.current === initialRevision) {
          setSession(null)
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    loadSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      // An explicit account action owns its result; delayed startup snapshots cannot replace it.
      if (authPending.current || (_event === 'INITIAL_SESSION' && authRevision.current > 0)) return
      if (nextSession?.user?.id && nextSession.user.id === rejectedUserId.current) return
      if (active) {
        authEventReceived = true
        setSession(nextSession)
        setLoading(false)
        if (_event === 'PASSWORD_RECOVERY') {
          window.history.replaceState({}, '', recoveryPath)
          window.dispatchEvent(new PopStateEvent('popstate'))
        }
      }
    })

    return () => {
      active = false
      subscription?.unsubscribe()
    }
  }, [])

  async function signIn(email, password) {
    if (authPending.current) return {data:null,error:new Error('An account action is already in progress. Please wait.')}
    authRevision.current++;authPending.current=true
    const requestedEmail=email.trim().toLowerCase()
    try {
      const response=await supabase.auth.signInWithPassword({ email:email.trim(), password })
      if(response.error)return response
      const next=response.data?.session
      if(!next?.user?.id)return {data:null,error:new Error('Sign in failed. No active session established.')}
      if(next.user.email?.trim().toLowerCase()!==requestedEmail){
        rejectedUserId.current=next.user.id
        try{await supabase.auth.signOut({scope:'local'})}catch{}
        setSession(null)
        return {data:null,error:new Error('The signed-in account does not match the email entered. Please sign in again.')}
      }
      rejectedUserId.current=null
      setSession(next);setLoading(false)
      return response
    } finally {authPending.current=false}
  }

  async function signUp(email, password, preparation) {
    return supabase.auth.signUp({ email, password, ...(preparation ? {options:{
      data:{full_name:preparation.name.trim(),ksc_requested_level:preparation.level},
      emailRedirectTo:`${window.location.origin}/dashboard/student`,
    }} : {}) })
  }

  async function signOut() {
    if(authPending.current)return {error:new Error('An account action is already in progress. Please wait.')}
    authRevision.current++;authPending.current=true
    try{const response=await supabase.auth.signOut({scope:'local'});if(!response?.error){rejectedUserId.current=null;setSession(null)}return response}
    finally{authPending.current=false}
  }

  async function requestPasswordReset(email) {
    return supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}${recoveryPath}` })
  }

  async function updatePassword(password) {
    return supabase.auth.updateUser({ password })
  }

  const value = useMemo(
    () => ({
      session,
      user: session?.user || null,
      loading,
      signIn,
      signUp,
      signOut,
      requestPasswordReset,
      updatePassword,
      isConfigured: isSupabaseConfigured,
    }),
    [session, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }

  return context
}
