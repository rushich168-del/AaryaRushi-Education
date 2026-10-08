import { useState } from 'react'
import { BookOpen, Database, LogOut, Settings, Users } from 'lucide-react'
import { useAuth } from '../../context/AuthContext.jsx'
import TeacherOverview from './TeacherOverview.jsx'
import AdminExamsConfig from './AdminExamsConfig.jsx'
import AdminQuestionBank from './AdminQuestionBank.jsx'
import AdminExamPatterns from './AdminExamPatterns.jsx'
import AdminTestBuilder from './AdminTestBuilder.jsx'
import AdminResults from './AdminResults.jsx'
import AdminAttemptDetail from './AdminAttemptDetail.jsx'
import { getCurrentPath } from '../../utils/routes.js'
import LmsNavigation from '../../components/site/LmsNavigation.jsx'
import LearningPage from '../student/LearningPage.jsx'
import PrintedPaperWorkspace from '../../components/site/PrintedPaperWorkspace.jsx'

export default function AdminDashboardPage({ portal = 'teacher' }) {
  const { signOut, user } = useAuth()
  const [signOutError, setSignOutError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const path = getCurrentPath()
  const [menuOpen, setMenuOpen] = useState(false)

  const handleSignOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    setSignOutError('')
    try {
      const result = await signOut()
      if (result?.error) throw result.error
      window.location.href = '/'
    } catch {
      setSignOutError('Sign out failed. Please try again.')
      setSigningOut(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 font-sans md:flex-row text-slate-900">
      <aside className="w-full border-r border-slate-200 bg-white md:w-64 flex-shrink-0 flex flex-col">
        <div className="p-6 border-b border-slate-100">
          <h1 className="text-xl font-bold text-slate-800">{portal === 'admin' ? 'Admin Portal' : 'Teacher Portal'}</h1>
          {portal === 'admin' && <a href="/dashboard/admin" className="mt-3 block font-semibold text-blue-700">Teachers & access →</a>}
          <button className="mt-3 font-semibold text-blue-700 md:hidden" aria-expanded={menuOpen} aria-controls="teacher-navigation" onClick={()=>setMenuOpen(open=>!open)}>{menuOpen ? 'Close menu' : 'Open menu'}</button>
        </div>
        <div id="teacher-navigation" className={`${menuOpen ? 'flex' : 'hidden'} flex-col md:flex md:flex-1`}>
        <nav className="flex-1 space-y-1 p-4 font-medium text-slate-600">
          {[
            ['', 'Overview', Database], ['courses','Courses & batches',BookOpen], ['exams','Exam Programs',Settings],
            ['teaching/library','Publish tests & library',BookOpen], ['paper-tests','Paper → Online test',BookOpen], ['questions','Question bank',Database], ['patterns','Test patterns',Settings], ['tests','Tests',BookOpen],
            ['results','Results',Database], ['students','Student enrollment',Users],
          ].map(([route,label,Icon])=>{const href='/dashboard/admin'+(route?'/'+route:'');const selected=path===href||(route==='results'&&path.startsWith(href+'/'));return <a key={href} href={href} aria-current={selected?'page':undefined} className={`flex items-center gap-3 rounded-lg px-4 py-3 ${selected?'bg-blue-50 text-blue-700':'hover:bg-slate-50'}`}><Icon size={20}/>{label}</a>})}
        </nav>
        <details className="px-4 py-4 border-t border-slate-100"><summary className="cursor-pointer text-sm font-semibold text-slate-600">Planned LMS scope</summary><LmsNavigation /></details>
        <div className="p-4 border-t border-slate-100 space-y-2">
          <div className="text-xs text-slate-400 mb-2 truncate px-4">{user?.email}</div>
          {signOutError && <p role="alert" className="text-sm text-red-700">{signOutError}</p>}
          <button disabled={signingOut} onClick={handleSignOut} className="flex w-full items-center gap-3 rounded-lg px-4 py-2 hover:bg-red-50 text-slate-600 hover:text-red-600 font-medium transition">
            <LogOut size={18} /> Sign Out
          </button>
        </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 p-4 md:p-8">
        <header className="mb-10">
          <h2 className="text-3xl font-extrabold tracking-tight">{portal === 'admin' ? 'Institute workspace' : 'Teaching workspace'}</h2>
          <p className="text-slate-600 mt-1">Manage courses, publish lessons and prepare student tests.</p>
        </header>

        {path === '/dashboard/admin/courses' || path === '/dashboard/admin/students' ? <LearningPage staff /> : path === '/dashboard/admin/exams' ? (
          <AdminExamsConfig />
        ) : path === '/dashboard/admin/paper-tests' ? (
          <PrintedPaperWorkspace />
        ) : path === '/dashboard/admin/patterns' ? (
          <AdminExamPatterns />
        ) : path === '/dashboard/admin/tests' ? (
          <AdminTestBuilder />
        ) : path === '/dashboard/admin/questions' ? (
          <AdminQuestionBank />
        ) : path === '/dashboard/admin/results' ? (
          <AdminResults />
        ) : path.startsWith('/dashboard/admin/results/') ? (
          <AdminAttemptDetail attemptId={path.split('/').pop()} />
        ) : <TeacherOverview />}

      </main>
    </div>
  )
}
