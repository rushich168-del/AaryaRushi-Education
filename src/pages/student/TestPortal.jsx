import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext.jsx'
import { programService, testKinds } from '../../services/programService.js'
import { studentExamService } from '../../services/studentExamService.js'
import { navigateTo } from '../../utils/routes.js'
import {useStudentProgram} from '../../components/auth/StudentProgramGate.jsx'

function ProgramCard({ program, onSelect }) {
  return <button onClick={()=>onSelect(program.id)} className="rounded-xl border border-slate-200 bg-white p-5 text-left font-semibold text-slate-900 shadow-sm hover:border-blue-500 focus-visible:outline-blue-600">{program.name}<span className="mt-2 block text-sm font-normal text-blue-700">Choose track →</span></button>
}
export default function TestPortal() {
  const { user }=useAuth()
  const preparation=useStudentProgram()?.selection
  const [data,setData]=useState(null),[tests,setTests]=useState([]),[attempts,setAttempts]=useState([]),[mine,setMine]=useState([])
  const [error,setError]=useState(''),[enrollmentError,setEnrollmentError]=useState(''),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0)
  const [program,setProgram]=useState(()=>preparation?.exam_id||new URLSearchParams(window.location.search).get('exam_id')||'')
  const [track,setTrack]=useState(()=>preparation?.level_id||(new URLSearchParams(window.location.search).has('exam_id')?new URLSearchParams(window.location.search).get('level_id')||'':''))
  const [area,setArea]=useState('AVAILABLE'),[tab,setTab]=useState('explore')
  useEffect(()=>{if(preparation){setProgram(preparation.exam_id);setTrack(preparation.level_id);setArea('AVAILABLE')}},[preparation?.exam_id,preparation?.level_id])
  useEffect(()=>{
    let active=true
    setLoading(true);setError('');setEnrollmentError('')
    Promise.all([programService.catalogue(),studentExamService.getAvailableTests(),studentExamService.getMyAttempts()])
      .then(([d,t,a])=>{if(active){setData(d);setTests(t);setAttempts(a)}})
      .catch(()=>{if(active)setError('Unable to load the Test Portal. Please retry.')}).finally(()=>{if(active)setLoading(false)})
    if(user?.id)programService.myTracks(user.id).then(m=>{if(active)setMine(m)}).catch(()=>{if(active)setEnrollmentError('Your program enrollments could not be loaded. Explore Programs is still available.')})
    return()=>{active=false}
  },[user?.id,retry])
  useEffect(()=>{
    const params=new URLSearchParams()
    if(program)params.set('exam_id',program)
    if(track)params.set('level_id',track)
    window.history.replaceState({},'',window.location.pathname+(params.size?'?'+params:''))
  },[program,track])
  function select(id){setProgram(id);setTrack('');setArea('AVAILABLE')}
  const heading=<header className="mb-8"><a href="/dashboard/student" className="text-sm font-semibold text-blue-700">← My dashboard</a><h1 className="mt-4 text-3xl font-bold">Test Portal</h1><p className="mt-2 text-slate-600">Choose your program, practise and review your results.</p><button disabled={loading} className="mt-4 rounded-lg border border-blue-200 bg-white px-4 py-2 font-semibold text-blue-700" onClick={()=>setRetry(x=>x+1)}>Refresh tests</button></header>
  if(loading||error)return <main className="mx-auto max-w-6xl p-5 md:p-8">{heading}{loading?<p role="status">Loading Test Portal…</p>:<p role="alert">{error} <button className="underline" onClick={()=>setRetry(x=>x+1)}>Retry</button></p>}</main>
  const activeExams=data.exams.filter(e=>e.is_active!==false)
  const selected=activeExams.find(e=>e.id===program)
  const tracks=data.levels.filter(l=>l.exam_id===program&&l.is_active!==false&&(!preparation||l.id===preparation.level_id))
  const selectedTrack=tracks.find(l=>l.id===track)
  const mineIds=new Set(mine.map(m=>m.level_id))
  const myExamIds=new Set(data.levels.filter(l=>mineIds.has(l.id)).map(l=>l.exam_id))
  const visibleExams=activeExams.filter(e=>tab==='explore'||myExamIds.has(e.id))
  const unclassified=track==='unclassified'
  const scoped=tests.filter(t=>t.exam_id===program&&(t.program_wide===true||(unclassified?!t.level_id:t.level_id===track)))
  const history=attempts.filter(a=>a.tests?.exam_id===program&&(a.tests.program_wide===true||(unclassified?!a.tests.level_id:a.tests.level_id===track)))
  const complete=history.filter(a=>['SUBMITTED','EXPIRED'].includes(a.status))
  const choices=Object.entries(testKinds).filter(([kind])=>scoped.some(t=>t.test_kind===kind||(kind==='GENERAL'&&!t.test_kind)))
  return <main className="min-h-screen bg-slate-50 text-slate-900"><div className="mx-auto max-w-6xl p-5 md:p-8">{heading}
    <p className="mb-6 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">Available tests includes papers published for your batches and shared practice. My Programs reflects your course enrollments; exploring a program does not enroll you.</p>
    {enrollmentError&&<p role="alert" className="mb-4 text-red-700">{enrollmentError} <button className="underline" onClick={()=>setRetry(x=>x+1)}>Retry enrollment</button></p>}
    {!program?<>
      <div className="mb-6 flex flex-wrap gap-3">{[['mine','My Programs'],['explore','Explore Programs']].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)} className={`rounded-lg border px-4 py-2 font-semibold ${tab===id?'bg-slate-900 text-white':'bg-white'}`}>{label}</button>)}</div>
      {tab==='mine'&&!enrollmentError&&!visibleExams.length&&<p className="rounded-xl border bg-white p-6">No program tracks have been linked to your enrolled courses yet. You can explore available programs below using Explore Programs.</p>}
      {[...data.categories.filter(c=>c.is_active),{id:null,name:'Other programs'}].map(c=>{
        const programs=visibleExams.filter(e=>e.category_id===c.id||(!e.category_id&&!c.id))
        if(!programs.length)return null
        return <section key={c.id||'other'} className="mb-8"><h2 className="mb-3 text-xl font-bold">{c.name}</h2><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{programs.map(p=><ProgramCard key={p.id} program={p} onSelect={select}/>)}</div></section>
      })}
      {!activeExams.length&&<p>No programs are currently available.</p>}
    </>:<>
      {preparation?<a href="/dashboard/student/program" className="mb-4 inline-block font-semibold text-blue-700">Switch program</a>:<button onClick={()=>select('')} className="mb-4 font-semibold text-blue-700">← All programs</button>}
      {!selected?<p>Program unavailable. Choose another program.</p>:<section>
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold mr-2 text-slate-900">{selected.name}</h2>
          {tracks.map(l=><button key={l.id} aria-pressed={track===l.id} onClick={()=>{setTrack(l.id);setArea('AVAILABLE')}} className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${track===l.id?'bg-slate-900 text-white border-slate-900':'bg-white text-slate-700 hover:bg-slate-50'}`}>{l.name}{mineIds.has(l.id)?' · Enrolled':''}</button>)}
          {(!preparation&&(tests.some(t=>t.exam_id===program&&!t.level_id)||attempts.some(a=>a.tests?.exam_id===program&&!a.tests.level_id)))&&<button aria-pressed={unclassified} onClick={()=>{setTrack('unclassified');setArea('FULL_MOCK')}} className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${unclassified?'bg-slate-900 text-white border-slate-900':'bg-white text-slate-700 hover:bg-slate-50'}`}>Earlier / unclassified tests</button>}
        </div>
        {!track?<p className="text-slate-600">{tracks.length?'Choose a track to see available tests.':'No tracks are configured for this program yet.'}</p>:!selectedTrack&&!unclassified?<p className="text-slate-600">Track unavailable. Choose one of the configured tracks.</p>:<>
          <h3 className="mb-4 text-lg font-bold uppercase tracking-tight text-slate-900">
            {selected.name} — {selectedTrack?.name||'Earlier Tests'} PREPARATION
          </h3>
          <div className="mb-6 flex flex-wrap gap-2">
            {[
              { id: 'AVAILABLE', label: 'Available tests' },
              { id: 'FULL_MOCK', label: 'Full Mock Tests' },
              { id: 'SUBJECT', label: 'Subject Tests' },
              { id: 'CHAPTER', label: 'Chapter / Topic Practice' },
              { id: 'PREVIOUS_MODEL', label: 'Previous / Model Papers' },
              { id: 'RESULTS', label: 'My Results' },
              { id: 'PERFORMANCE', label: 'Performance Analysis' }
            ].map(areaDef=><button key={areaDef.id} aria-pressed={area===areaDef.id} onClick={()=>setArea(areaDef.id)} className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${area===areaDef.id?'bg-blue-700 border-blue-700 text-white':'bg-white text-slate-700 hover:bg-slate-50 border-slate-200 shadow-sm'}`}>{areaDef.label}</button>)}
          </div>
          {area==='RESULTS'||area==='PERFORMANCE'?<div className="space-y-3">{!complete.length?<p className="rounded-xl border border-slate-200 bg-white p-6 text-slate-600 shadow-sm">No completed tests for this track yet.</p>:complete.map(a=><article key={a.id} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow transition-shadow"><div className="pr-4"><h4 className="font-bold text-slate-900">{a.tests?.name}</h4><p className="mt-1 text-sm text-slate-600">Score: <span className="font-semibold text-slate-900">{a.score??'—'}</span> / {a.max_score??'—'}</p></div><button onClick={()=>navigateTo(`/test/${a.test_id}/result`)} className="shrink-0 rounded-lg bg-slate-100 border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-200">{area==='PERFORMANCE'?'Performance Details':'View Result'}</button></article>)}<p className="mt-4 text-xs text-slate-500">Section details and answer review follow each test’s review policy.</p></div>:<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(()=>{
              const areaTests = scoped.filter(t => {
                if (area === 'AVAILABLE') return true
                if (area === 'PREVIOUS_MODEL') return t.test_kind === 'PREVIOUS' || t.test_kind === 'MODEL'
                return t.test_kind === area
              })
              if (!areaTests.length) return <p className="col-span-full rounded-xl border border-slate-200 bg-white p-6 text-slate-600 shadow-sm">No tests are currently available in this area.</p>
              return areaTests.map(t=>{const a=history.find(a=>a.test_id===t.id);const action=!a?'instructions':a.status==='IN_PROGRESS'?'attempt':'result';return <article key={t.id} className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm hover:shadow transition-shadow"><p className="text-xs font-bold text-blue-600 tracking-wide uppercase mb-2">{testKinds[t.test_kind]||'TEST'}</p><h4 className="mb-2 font-bold text-slate-900 leading-tight">{t.name}</h4><p className="mb-5 text-sm text-slate-600">{t.duration_minutes?`${t.duration_minutes} minutes · `:''}{t.total_marks??'—'} marks</p><button onClick={()=>navigateTo(`/test/${t.id}/${action}`)} className={`mt-auto w-full rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${!a?'bg-blue-600 text-white hover:bg-blue-700':action==='attempt'?'bg-orange-100 text-orange-800 hover:bg-orange-200':'bg-slate-100 text-slate-800 hover:bg-slate-200 border border-slate-200'}`}>{!a?'Start Test':action==='attempt'?'Resume Test':'View Result'}</button></article>})
            })()}
          </div>}
        </>}
      </section>}
    </>}
  </div></main>
}
