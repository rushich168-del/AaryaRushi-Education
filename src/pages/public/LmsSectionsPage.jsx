import PublicLayout from '../../components/site/PublicLayout.jsx'
import LmsNavigation from '../../components/site/LmsNavigation.jsx'
import { lmsSections } from '../../data/lmsSections.js'
import brand from '../../config/brand.js'

// Public scope previews only. These pages never fetch staff or learner data.
export default function LmsSectionsPage({ sectionId }) {
  const section = lmsSections.find(item => item.id === sectionId)
  return <PublicLayout>
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      <a href="/" className="text-sm font-semibold text-blue-700">← Main website</a>
      <div className="mt-6 grid gap-8 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="rounded-2xl border border-slate-200 bg-white p-3 self-start">
          <details className="lg:hidden"><summary className="cursor-pointer p-3 font-bold">Browse all 8 sections</summary><LmsNavigation /></details>
          <div className="hidden lg:block"><LmsNavigation /></div>
        </aside>
        <section className="min-w-0">
          <p className="text-xs font-bold uppercase tracking-widest text-blue-700 mb-3">{brand.shortName} LMS · Section preview</p>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">{section?.title || 'Your LMS, section by section'}</h1>
          {section ? <>
            <span className="inline-block rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-sm font-semibold text-amber-900">{section.status}</span>
            <p className="text-lg leading-8 text-slate-600 mt-5">{section.description}</p>
            <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
              <h2 className="font-bold text-xl mb-4">{section.id === 'website' ? 'Website scope' : 'Planned features'}</h2>
              <ul className="list-disc pl-5 space-y-3 text-slate-700">{section.items.map(item => <li key={item}>{item}</li>)}</ul>
              {section.id !== 'website' && <p className="mt-6 text-sm text-slate-500">This page describes the planned section. Its full workflow is not available yet.</p>}
            </div>
            {section.href && <div className="mt-6 rounded-2xl border border-blue-200 bg-blue-50 p-6"><a href={section.href} className="inline-flex min-h-11 items-center rounded-lg bg-blue-700 text-white px-5 font-semibold">{section.action} →</a>{section.note && <p className="mt-3 text-sm leading-6 text-slate-700">{section.note}</p>}{section.id === 'progress' && <a href="/dashboard/admin/results" className="block mt-4 font-semibold text-blue-700">Open existing teacher results (staff access) →</a>}</div>}
          </> : <>
            <p className="text-slate-600 leading-7">All eight agreed sections are listed below. Open any section to see its scope and current availability.</p>
            <div className="my-6 rounded-xl border border-blue-200 bg-blue-50 p-5"><strong>First focus: Administrator workspace.</strong><p className="mt-2 text-sm text-slate-700">Account setup and permissions come first, followed by course and curriculum management.</p></div>
            <div className="grid gap-4 sm:grid-cols-2">{lmsSections.map((item, index) => <a href={`/lms/${item.id}`} key={item.id} className="rounded-2xl border border-slate-200 bg-white p-6 hover:border-blue-400"><p className="text-xs font-bold text-slate-500 mb-3">SECTION {index + 1} · {item.status}</p><h2 className="text-xl font-bold mb-3">{item.title}</h2><p className="text-sm leading-6 text-slate-600">{item.description}</p><span className="block mt-4 font-semibold text-blue-700">View section →</span></a>)}</div>
          </>}
        </section>
      </div>
    </div>
  </PublicLayout>
}
