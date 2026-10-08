import { Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { navigateTo } from '../../utils/routes.js'

export default function ProtectedRoute({ children }) {
  const { loading, session } = useAuth()

  useEffect(() => {
    if (!loading && !session) {
      navigateTo('/login')
    }
  }, [loading, session])

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-lightBg font-sans text-slateText">
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <Loader2 size={20} className="animate-spin text-accentBlue" aria-hidden="true" />
          <span className="text-sm font-semibold text-slate-600">Checking session</span>
        </div>
      </main>
    )
  }

  if (!session) {
    return null
  }

  return children
}
