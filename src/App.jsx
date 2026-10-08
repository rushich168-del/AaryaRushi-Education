import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import ProtectedRoute from './components/auth/ProtectedRoute.jsx'
import StudentGate from './components/auth/StudentGate.jsx'
import StudentProgramGate from './components/auth/StudentProgramGate.jsx'
import StaffRoute from './components/auth/StaffRoute.jsx'
import StaffGate from './components/auth/StaffGate.jsx'
import StaffLoginPage from './pages/staff/StaffLoginPage.jsx'
import AdminSetupPage from './pages/staff/AdminSetupPage.jsx'
import AdminAccountsPage from './pages/staff/AdminAccountsPage.jsx'
import TeacherPortalPage from './pages/staff/TeacherPortalPage.jsx'
import AssignmentHub from './pages/staff/AssignmentHub.jsx'
import LocalLibraryPreview from './pages/staff/LocalLibraryPreview.jsx'

import CreatorPreparation from './pages/staff/CreatorPreparation.jsx'
import TestCreatorLoginPage from './pages/staff/TestCreatorLoginPage.jsx'
import LearningPage from './pages/student/LearningPage.jsx'
import { useAuth } from './context/AuthContext.jsx'

// Public pages
import HomePage from './pages/public/HomePage.jsx'
import CoursesPage from './pages/public/CoursesPage.jsx'
import CheckoutPage from './pages/payments/CheckoutPage.jsx'
import MyPaymentsPage from './pages/payments/MyPaymentsPage.jsx'
import AdminFeesPage from './pages/staff/AdminFeesPage.jsx'
import PreviewAccessPage from './pages/public/PreviewAccessPage.jsx'
import InformationPage from './pages/public/InformationPage.jsx'
import NotFoundPage from './pages/public/NotFoundPage.jsx'
import AboutPage from './pages/public/AboutPage.jsx'
import ExamsListingPage from './pages/public/ExamsListingPage.jsx'
import ExamDetailsPage from './pages/public/ExamDetailsPage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import SignupPage from './pages/SignupPage.jsx'
import PasswordRecoveryPage from './pages/PasswordRecoveryPage.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import AdminExamsConfig from './pages/admin/AdminExamsConfig.jsx'
import AdminDashboardPage from './pages/admin/AdminDashboardPage.jsx'
import AdminOverviewPage from './pages/staff/AdminOverviewPage.jsx'
import DraftReviewCenter from './components/site/review/DraftReviewCenter.jsx'

// Student Area
import StudentDashboardPage from './pages/student/StudentDashboardPage.jsx'
import TestInstructions from './pages/student/TestInstructions.jsx'
import ExamWorkspace from './pages/student/ExamWorkspace.jsx'
import TestResult from './pages/student/TestResult.jsx'

import { getCurrentPath } from './utils/routes.js'
import { crossesPortal } from './lib/portalSession.js'
import TestDemoPage from './pages/TestDemoPage.jsx'
import { demoTests } from './data/tests/demoTests.js'
import LmsSectionsPage from './pages/public/LmsSectionsPage.jsx'
import { lmsSections } from './data/lmsSections.js'

function AuthRedirect({ to }) {
  useEffect(() => {
    if (crossesPortal(to)) {
      window.location.replace(to)
      return
    }
    window.history.replaceState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [to])

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 font-sans text-slate-900">
      <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
        <Loader2 size={20} className="animate-spin text-blue-600" aria-hidden="true" />
        <span className="text-sm font-semibold text-slate-600">Redirecting</span>
      </div>
    </main>
  )
}

function App() {
  const [path, setPath] = useState(getCurrentPath())
  const { loading } = useAuth()
  const route = path.replace(/\/+$/, '') || '/'

  useEffect(() => {
    const handleRouteChange = () => setPath(getCurrentPath())

    window.addEventListener('popstate', handleRouteChange)
    return () => window.removeEventListener('popstate', handleRouteChange)
  }, [])

  // Sample-data creator preview (browser storage only) stays on the local dev server.
  if (route === '/testcreator/preview') return import.meta.env.DEV && ['127.0.0.1','localhost','[::1]'].includes(window.location.hostname)
    ? <LocalLibraryPreview role="creator" /> : <NotFoundPage />

  if (import.meta.env.VITE_PUBLIC_PREVIEW === 'true' &&
    (route === '/login' || route === '/signup' || route === '/teacher/login' || route === '/admin/login' || route === '/testcreator/login' || route === '/staff/change-password' || route === '/forgot-password' || route === '/reset-password' || route === '/dashboard' || route.startsWith('/dashboard/') || route.startsWith('/test/'))) {
    return <PreviewAccessPage />
  }

  if ((route === '/login' || route === '/signup') && loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 font-sans text-slate-900">
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <Loader2 size={20} className="animate-spin text-blue-600" aria-hidden="true" />
          <span className="text-sm font-semibold text-slate-600">Checking session</span>
        </div>
      </main>
    )
  }

  if (route === '/testcreator/login') return <TestCreatorLoginPage />
  if (route === '/dashboard/testcreator') return <StaffGate role="creator"><AuthRedirect to="/dashboard/testcreator/prepare" /></StaffGate>
  if (route === '/dashboard/testcreator/prepare') return <StaffGate role="creator"><CreatorPreparation/></StaffGate>
  if (route === '/admin/setup') return <AdminSetupPage />
  if (route === '/login') return <StudentGate entry><LoginPage /></StudentGate>
  if (route === '/teacher/login' || route === '/admin/login') return <StaffLoginPage key={route} role={route === '/admin/login' ? 'admin' : 'teacher'} />
  if (route === '/staff/change-password') return <StaffGate role="either"><AuthRedirect to="/dashboard" /></StaffGate>
  if (['/dashboard/teacher','/dashboard/teacher/courses','/dashboard/teacher/materials','/dashboard/teacher/students','/dashboard/teacher/paper-tests','/dashboard/teacher/results','/dashboard/teacher/library'].includes(route)) return <StaffGate role="teacher">{access => <TeacherPortalPage key={route} staffRole={access.role} />}</StaffGate>
  if (route === '/dashboard/admin/assignments') return <StaffGate role="admin"><AssignmentHub /></StaffGate>
  if (route === '/dashboard/admin/fees') return <StaffGate role="admin"><AdminFeesPage /></StaffGate>
  if (route === '/dashboard/student/checkout') return <StudentGate><CheckoutPage /></StudentGate>
  if (route === '/dashboard/student/payments') return <ProtectedRoute><StudentGate><MyPaymentsPage /></StudentGate></ProtectedRoute>
  if (route === '/dashboard/admin/overview') return <StaffGate role="admin"><AdminOverviewPage /></StaffGate>
  if (route === '/dashboard/admin/results' || route.startsWith('/dashboard/admin/results/')) return <StaffGate role="admin"><AuthRedirect to={'/dashboard/admin/teaching/results'+(route.startsWith('/dashboard/admin/results/')?'?attempt='+encodeURIComponent(route.split('/').pop()):window.location.search)} /></StaffGate>
  if (['/dashboard/admin/teaching','/dashboard/admin/teaching/courses','/dashboard/admin/teaching/students','/dashboard/admin/teaching/results','/dashboard/admin/teaching/paper-tests','/dashboard/admin/teaching/library'].includes(route)) return <StaffGate role="admin"><TeacherPortalPage key={route} staffRole="admin" adminView /></StaffGate>
  if (route === '/dashboard/admin') return <StaffGate role="either">{access => access.role === 'admin' ? <AdminAccountsPage /> : <AuthRedirect to="/dashboard/teacher" />}</StaffGate>
  if (route === '/forgot-password' || route === '/reset-password') return <PasswordRecoveryPage key={route} reset={route === '/reset-password'} />
  if (route === '/signup') return <StudentGate entry><SignupPage /></StudentGate>
  if (route === '/lms') return <LmsSectionsPage />
  if (route.startsWith('/lms/')) {
    const sectionId = route.slice('/lms/'.length)
    return lmsSections.some(section => section.id === sectionId)
      ? <LmsSectionsPage sectionId={sectionId} /> : <NotFoundPage />
  }

  if (route.startsWith('/demo/tests/')) {
    const id = route.slice('/demo/tests/'.length)
    if (!Object.hasOwn(demoTests, id)) return <NotFoundPage />
    return <TestDemoPage key={id} {...demoTests[id]} />
  }

  if (route === '/about') return <AboutPage />
  if (route === '/exams') return <ExamsListingPage />
  if (route === '/branches') return <InformationPage page="branches" />
  if (route === '/contact') return <InformationPage page="contact" />
  if (route === '/courses') return <CoursesPage />
  
  if (route.startsWith('/exams/')) {
    const slug = route.slice('/exams/'.length)
    return <ExamDetailsPage slug={slug} />
  }

  if (['/dashboard/admin', '/dashboard/admin/courses', '/dashboard/admin/paper-tests', '/dashboard/admin/exams', '/dashboard/admin/students', '/dashboard/admin/questions', '/dashboard/admin/patterns', '/dashboard/admin/tests', '/dashboard/admin/results'].includes(route) || route.startsWith('/dashboard/admin/results/')) {
    return (
      <ProtectedRoute>
        <StaffGate role="either">{access => access.role === 'admin' ? <AdminDashboardPage portal="admin" /> : <AuthRedirect to={route.includes('/paper-tests') ? '/dashboard/teacher/paper-tests' + window.location.search : route.includes('/courses') || route.includes('/students') ? '/dashboard/teacher/courses' + window.location.search : route.includes('/results') ? '/dashboard/teacher/results' : '/dashboard/teacher'} />}</StaffGate>
      </ProtectedRoute>
    )
  }

  // B4.6 Teacher Preparation & Exception Review Center for one prepared Draft paper.
  const draftReview = /^\/dashboard\/admin\/draft-review\/([0-9a-f-]{36})$/i.exec(route)
  if (draftReview) {
    return (
      <ProtectedRoute>
        <StaffRoute><DraftReviewCenter key={draftReview[1]} draftPaperId={draftReview[1]} /></StaffRoute>
      </ProtectedRoute>
    )
  }

  const studentSections = { '/dashboard': 'overview', '/dashboard/tests': 'tests', '/dashboard/performance': 'performance', '/dashboard/settings': 'settings' }
  if (Object.hasOwn(studentSections, route)) {
    return (
      <ProtectedRoute>
        <DashboardPage key={route} section={studentSections[route]} />
      </ProtectedRoute>
    )
  }

  if (route === '/dashboard/student/program') return <ProtectedRoute><StudentGate><StudentProgramGate><AuthRedirect to="/dashboard/student" /></StudentProgramGate></StudentGate></ProtectedRoute>
  if (route === '/dashboard/student/tests') return <ProtectedRoute><StudentGate><StudentProgramGate><AuthRedirect to="/dashboard/student#student-tests" /></StudentProgramGate></StudentGate></ProtectedRoute>
  if (route === '/dashboard/student/courses') return <ProtectedRoute><StudentGate><StudentProgramGate><LearningPage /></StudentProgramGate></StudentGate></ProtectedRoute>
  if (route === '/dashboard/student') {
    return (
      <ProtectedRoute>
        <StudentGate><StudentProgramGate><StudentDashboardPage /></StudentProgramGate></StudentGate>
      </ProtectedRoute>
    )
  }

  if (route.startsWith('/test/')) {
    const parts = route.split('/')
    const testId = parts[2]
    const action = parts[3]

    if (action === 'instructions') {
      return <ProtectedRoute><TestInstructions testId={testId} /></ProtectedRoute>
    }
    if (action === 'attempt') {
      return <ProtectedRoute><ExamWorkspace testId={testId} /></ProtectedRoute>
    }
    if (action === 'result') {
      return <ProtectedRoute><TestResult testId={testId} /></ProtectedRoute>
    }
  }

  if (route === '/') return <HomePage />
  return <NotFoundPage />
}

export default App
