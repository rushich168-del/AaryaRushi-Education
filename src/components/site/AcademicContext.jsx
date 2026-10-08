import { useEffect, useState } from 'react'
import { programService, emptyAcademicContext } from '../../services/programService.js'
import { academicChoices, academicFields, reconcileAcademicContext } from '../../services/academicContext.js'

export default function AcademicContext({ value, onChange, depth = 'topic', catalogue: supplied, disabled = false, authoring = false, syncUrl = true, optionalLevel = false, paperSubjects = false }) {
  const [data, setData] = useState(supplied)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (supplied) { setData(supplied); return }
    let active = true
    setError('')
    programService.catalogue().then(d=>{if(active)setData(d)}).catch(()=>{if(active)setError('Program context could not be loaded.')})
    return ()=>{active=false}
  }, [supplied,retry])
  const v = { ...emptyAcademicContext, ...value }
  const fields = academicFields
  function commit(context) {
    if (syncUrl) {
      const url=new URL(window.location.href)
      for(const field of fields){if(context[field])url.searchParams.set(field,context[field]);else url.searchParams.delete(field)}
      window.history.replaceState({},'',url.pathname+url.search)
    }
    onChange(context)
  }
  useEffect(() => {
    if (!authoring || !data || disabled) return
    const next = reconcileAcademicContext(data, v)
    if (fields.some(key => next[key] !== v[key])) commit(next)
  }, [data, authoring, disabled, ...fields.map(key => v[key])])
  function change(key, next) {
    const index=fields.indexOf(key)
    const context={...v,...Object.fromEntries(fields.slice(index+1).map(k=>[k,''])),[key]:next}
    commit(authoring ? reconcileAcademicContext(data, context) : context)
  }
  if(error)return <p role="alert" className="text-red-700">{error} <button type="button" className="underline" onClick={()=>setRetry(x=>x+1)}>Retry program context</button></p>
  if(!data)return <p role="status">Loading program context…</p>
  const choices = academicChoices(data, v, authoring)
  const emptyLabels = ['No programs configured', 'No tracks configured', 'No subjects configured', 'No active syllabi configured', 'No chapters configured', 'No topics configured']
  const count=depth==='level'?2:depth==='subject'?3:6
  return <div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {choices.slice(0,count).map(([key,label,options],i)=><label key={key} className="min-w-0 text-sm font-medium text-slate-700">{label}
      <select aria-label={label} className="mt-1 block w-full min-w-0 rounded-lg border border-slate-300 bg-white p-2" value={v[key]} disabled={disabled||(i>0&&!(optionalLevel&&key==='subject_id'?v.exam_id:v[fields[i-1]]))||options.length===0} onChange={e=>change(key,e.target.value)}>
        <option value="">{paperSubjects&&key==='subject_id'?'General / mixed subjects (automatic)':optionalLevel&&key==='level_id'?'No track / class (optional)':(i===0||v[fields[i-1]]||(optionalLevel&&key==='subject_id'&&v.exam_id))&&options.length===0 ? emptyLabels[i] : key==='exam_id'?'Select program':`Select ${label.toLowerCase()}`}</option>
        {options.map(x=><option key={x.id} value={x.id}>{x.name}{x.is_active===false||x.status==='ARCHIVED'?' (inactive)':''}</option>)}
      </select>
      {authoring && key==='syllabus_id' && options.length===1 && v[key]===options[0].id && <span className="block text-xs text-slate-500">Only active syllabus selected automatically.</span>}
    </label>)}
  </div>{paperSubjects && v.exam_id && <p className="mt-3 text-sm text-slate-600">Subject is optional. Publishing uses General / mixed subjects unless you choose a specific subject.</p>}</div>
}
