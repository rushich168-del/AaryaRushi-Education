import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { supabase } from '../../lib/supabaseClient.js'
import { navigateTo } from '../../utils/routes.js'

export default function StaffRoute({ children }) {
  const { user, loading } = useAuth()
  const [check, setCheck] = useState(null)
  const [retry, setRetry] = useState(0)
  const userId = user?.id
  useEffect(() => {
    let active = true
    if (loading || !userId) return () => { active = false }
    setCheck(null)
    async function verify() {
      try {
        const { data, error } = await supabase.rpc('is_teacher')
        if (error || typeof data !== 'boolean') throw new Error('Role verification failed')
        if (active) setCheck({ userId, state: data ? 'allowed' : 'denied' })
      } catch {
        if (active) setCheck({ userId, state: 'error' })
      }
    }
    verify()
    return () => { active = false }
  }, [userId, loading, retry])

  const state = check?.userId === userId ? check?.state : null
  if (!loading && userId && state === 'allowed') return children
  return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-900">
    <div className="max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-6">
      {state === 'error' ? <>
        <h1 className="text-xl font-bold">Unable to verify staff access</h1>
        <p role="alert">Staff access could not be checked. Please try again.</p>
        <button onClick={() => { setCheck(null); setRetry(value => value + 1) }} className="font-semibold text-blue-700">Retry</button>
      </> : state === 'denied' || (!loading && !userId) ? <>
        <h1 className="text-xl font-bold">Staff access required</h1>
        <p>This account does not have teacher access. Staff access must be assigned by the institute.</p>
        <button onClick={() => navigateTo(userId ? '/dashboard' : '/login')} className="font-semibold text-blue-700">{userId ? 'Back to my portal' : 'Sign in'}</button>
      </> : <p role="status">Checking staff access…</p>}
    </div>
  </main>
}
