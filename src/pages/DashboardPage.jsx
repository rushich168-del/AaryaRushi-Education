import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient.js'
import { navigateTo } from '../utils/routes.js'

export default function DashboardPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    async function checkRole() {
      setLoading(true)
      setError(null)
      try {
        const { data, error: authError } = await supabase.auth.getUser()
        if (!active) return
        if (authError) throw new Error('Failed to verify your session. Please try again.')
        const user = data?.user
        if (!user) {
          navigateTo('/login')
          return
        }

        const { data: access, error: accessError } = await supabase.rpc('ksc_my_access')
        if (!active) return
        if (!accessError && access && ['admin','teacher','creator','student'].includes(access.role)) {
          navigateTo(access.role === 'admin' ? '/dashboard/admin' : access.role === 'teacher' ? '/dashboard/teacher' : access.role === 'creator' ? '/dashboard/testcreator' : '/dashboard/student')
          return
        }
        // Ordinary student onboarding remains compatible with the installed baseline.
        // New staff portals still fail closed until the forward update is enabled.
        if (!accessError || !['PGRST202','42883'].includes(accessError.code)) throw new Error('Failed to verify account permissions.')
        const { data: isTeacher, error: roleError } = await supabase.rpc('is_teacher')
        if (!active) return

        if (roleError || typeof isTeacher !== 'boolean') {
          throw new Error('Failed to verify account permissions.')
        }

        if (isTeacher === true) {
          navigateTo('/dashboard/admin')
        } else {
          navigateTo('/dashboard/student')
        }
      } catch (err) {
        if (!active) return
        setError('Failed to verify account permissions. Please try again.')
        setLoading(false)
      }
    }
    checkRole()
    return () => { active = false }
  }, [retry])

  if (error) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-slate-50 gap-4 p-4 text-center">
        <div className="text-red-600 font-semibold">{error}</div>
        <button onClick={() => setRetry(value => value + 1)} className="px-4 py-2 bg-slate-800 text-white font-medium rounded-md hover:bg-slate-700">
          Retry
        </button>
      </div>
    )
  }

  if (loading) return (
    <div className="h-screen flex items-center justify-center bg-slate-50">
      <Loader2 size={32} className="animate-spin text-blue-600" />
    </div>
  )
  return null
}
