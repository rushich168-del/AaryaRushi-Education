import { lmsSections } from '../../data/lmsSections.js'

export default function LmsNavigation() {
  const path = window.location.pathname.replace(/\/+$/, '')
  return <nav aria-label="LMS sections" className="space-y-1">
    <a href="/lms" aria-current={path === '/lms' ? 'page' : undefined} className="block rounded-lg px-3 py-3 font-bold text-blue-800 hover:bg-blue-50">All LMS sections</a>
    {lmsSections.map(section => <a key={section.id} href={`/lms/${section.id}`} aria-current={path === `/lms/${section.id}` ? 'page' : undefined} className={`block rounded-lg px-3 py-3 text-sm hover:bg-blue-50 ${path === `/lms/${section.id}` ? 'bg-blue-50 text-blue-800 font-bold' : 'text-slate-700'}`}>
      <span className="block">{section.title}</span>
      <span className="block mt-1 text-xs text-slate-500">{section.status}</span>
    </a>)}
  </nav>
}
