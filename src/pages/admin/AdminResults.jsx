import { useState, useEffect } from 'react'
import { CheckCircle2, ListFilter, Eye, Search } from 'lucide-react'
import { resultService, resultValue, resultPercent } from '../../services/resultService.js'
import AcademicContext from '../../components/site/AcademicContext.jsx'
import { contextFromUrl } from '../../services/programService.js'

function navigateTo(path) {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export default function AdminResults() {
  const [academic,setAcademic]=useState(contextFromUrl)
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  
  const [search, setSearch] = useState('')

  useEffect(() => {
    load()
  }, [academic])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      await resultService.triggerExpiredFinalization()
      const data = await resultService.getTeacherResults(null,academic)
      setResults(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const filtered = results.filter(r => 
    r.student_profiles?.full_name?.toLowerCase().includes(search.toLowerCase()) || 
    r.tests?.name?.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) return <div className="p-8 text-slate-500">Loading results...</div>
  if (error) return <div role="alert" className="p-8 text-red-500">{error} <button onClick={load} className="underline">Retry results</button></div>

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <AcademicContext value={academic} onChange={setAcademic} depth="level"/>
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-black text-slate-900">Test Results</h1>
          <p className="text-slate-500 mt-1">Review finalized student attempts and performance.</p>
        </div>
      </div>

      <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-col md:flex-row gap-4 justify-between items-center">
        <div className="relative w-full md:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input 
            type="text" 
            placeholder="Search student or test..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:border-transparent outline-none"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-12 text-center text-slate-500">
            No completed attempts found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wider border-b">
                  <th className="p-4 font-semibold">Student</th>
                  <th className="p-4 font-semibold">Test</th>
                  <th className="p-4 font-semibold">Status</th>
                  <th className="p-4 font-semibold text-right">Score</th>
                  <th className="p-4 font-semibold text-right">%</th>
                  <th className="p-4 font-semibold text-center">Action</th>
                </tr>
              </thead>
              <tbody className="text-sm divide-y divide-slate-100">
                {filtered.map(r => {
                  const percent = resultPercent(r.score, r.max_score)
                  return (
                    <tr key={r.id} className="hover:bg-slate-50 transition">
                      <td className="p-4">
                        <div className="font-bold text-slate-800">{r.student_profiles?.full_name}</div>
                      </td>
                      <td className="p-4">
                        <div className="font-medium text-slate-800">{r.tests?.name}</div>
                        <div className="text-xs text-slate-500">{r.tests?.exams?.name}</div>
                      </td>
                      <td className="p-4">
                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold ${r.status === 'SUBMITTED' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-700'}`}>
                          {r.status === 'SUBMITTED' ? <CheckCircle2 size={12}/> : null} {r.status}
                        </span>
                      </td>
                      <td className="p-4 text-right font-black text-slate-800">
                        {resultValue(r.score)} <span className="text-slate-400 text-xs font-medium">/ {resultValue(r.max_score)}</span>
                      </td>
                      <td className="p-4 text-right font-bold text-blue-600">
                        {percent}
                      </td>
                      <td className="p-4 text-center">
                        <button 
                          onClick={() => navigateTo(`/dashboard/admin/results/${r.id}`)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium rounded border border-blue-200 transition"
                        >
                          <Eye size={16} /> Details
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
