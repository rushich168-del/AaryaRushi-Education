import {examFormat,formatSettings} from '../../services/examFormats.js'
import {importedSubjectSections} from '../../services/sourceSubjectHeadings.js'
// Format cards, question target and subject sections for any exam in the exam-format registry.
export default function ExamFormatSetup({paper,update}) {
 const exam=examFormat(paper.exam)
 if(!exam)return null
 const format=exam.formats.find(f=>f.id===paper.testFormat)
 const fixed=!format?.custom
 const target=fixed?format?.count:Number(paper.targetCount)
 const sections=paper.sections||[]
 const total=sections.reduce((n,s)=>n+Number(s.count||0),0)
 const sectionChange=(i,patch)=>update({sections:sections.map((s,j)=>j===i?{...s,...patch}:s)})
 return <div className="lp-dsc-setup"><div className="lp-panel-title"><div><h3>{exam.title}</h3><p>{exam.intro}</p></div><span className="lp-tag">{exam.tag}</span></div>
 <div className={'lp-format-grid'+(exam.formats.length===2?' is-pair':'')} role="group" aria-label={exam.groupLabel}>{exam.formats.map(f=><button key={f.id} aria-pressed={paper.testFormat===f.id} onClick={()=>{const imported=importedSubjectSections(paper.questions);update({...formatSettings(paper.exam,f.id),...(imported?{sections:imported}:{})})}}><strong>{f.name}</strong><small>{f.hint}</small></button>)}</div>
 {exam.stale?.when(paper)&&<p className="lp-error">{exam.stale.prompt}</p>}
 {!format&&exam.earlierPapers&&<p className="lp-error lp-format-prompt">{exam.chooseFormat}</p>}
 {(format||!exam.earlierPapers)&&<><div className="lp-format-summary"><label>Questions<input aria-label="Target questions" type="number" min="1" max={format?.max||1000} step="1" value={target||''} disabled={fixed} onChange={e=>update({targetCount:Number(e.target.value),sections:sections.length===1?[{...sections[0],count:Number(e.target.value)}]:sections})}/></label><strong>{target||0} questions × {paper.marks} mark = {(target||0)*Number(paper.marks)} marks</strong></div>
 <p className="lp-format-hint">The count must match the questions in the paper and the answer key.</p>
 {format?.label&&<p className="lp-format-note">{format.label}</p>}
 <details className="lp-sections" open={!paper.questions.length}><summary>Subject sections <span className={total===target?'is-matched':undefined}>{total} / {target} questions</span></summary><p>Set sections in source-paper order. Question numbers are grouped automatically; you can change an individual question’s subject below.</p>{format?.note&&<p>{format.note}</p>}
 {sections.map((s,i)=><div key={i} className="lp-section-row"><label>Subject {i+1}<select aria-label={`Section ${i+1} subject`} value={s.subject} onChange={e=>sectionChange(i,{subject:e.target.value})}>{[...new Set([...exam.subjectOptions,s.subject])].map(x=><option key={x}>{x}</option>)}</select></label><label>Questions<input aria-label={`Section ${i+1} questions`} type="number" min="1" step="1" value={s.count} onChange={e=>sectionChange(i,{count:Number(e.target.value)})}/></label><button aria-label={`Remove section ${i+1}`} disabled={sections.length===1} onClick={()=>update({sections:sections.filter((_,j)=>j!==i)})}>Remove</button></div>)}<button onClick={()=>update({sections:[...sections,{subject:exam.subjects[0],count:1}]})}>+ Add subject section</button>{total!==target&&<p className="lp-error">Assign {target} questions across your sections. Current total: {total}.</p>}</details></>}
 {exam.reference&&<details className="lp-reference"><summary>{exam.reference.summary}</summary><p>{exam.reference.text}</p><a href={exam.reference.url} target="_blank" rel="noreferrer">{exam.reference.label}</a></details>}</div>
}
