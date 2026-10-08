import {useEffect,useRef,useState} from 'react'
import PrintedQuestionContent from '../../components/site/PrintedQuestionContent.jsx'

export default function ReadyVersionPreview({paper,onClose,onRevise}){
 const dialog=useRef(null),[index,setIndex]=useState(0)
 useEffect(()=>{const node=dialog.current;node.showModal();return()=>node.close()},[])
 const question=paper.questions[index]
 return <dialog ref={dialog} className="lp-version-dialog" aria-label={'Ready version: '+paper.title} onCancel={e=>{e.preventDefault();onClose()}}>
  <header><div><span className="lp-eyebrow">READY VERSION · V{paper.version}</span><h2>{paper.title}</h2></div><button onClick={onClose}>Close version</button></header>
  <div className="lp-version-body"><p>{paper.questions.length} questions · {paper.duration} minutes · {paper.marks} {Number(paper.marks)===1?'mark':'marks'} per question · {paper.negative} negative {Number(paper.negative)===1?'mark':'marks'}</p><p className="lp-muted">Preview the finished paper here. To edit questions, answers or details, create a revised draft. This ready version and published tests are kept.</p>
   <nav className="lp-version-navigation" aria-label="Version questions"><button disabled={index===0} onClick={()=>setIndex(i=>i-1)}>Previous question</button><label>Question<select value={index} onChange={e=>setIndex(Number(e.target.value))}>{paper.questions.map((q,i)=><option key={i} value={i}>{q.number||i+1}</option>)}</select></label><button disabled={index===paper.questions.length-1} onClick={()=>setIndex(i=>i+1)}>Next question</button></nav>
   {question&&<section className="lp-version-question" aria-label="Question preview"><h3>Question {question.number||index+1}</h3><PrintedQuestionContent text={question.content}/><p className="lp-version-answer">Answer: {Number.isInteger(question.correct)?String.fromCharCode(65+question.correct):'Not set'}</p></section>}
  </div><footer><button onClick={onClose}>Back to library</button><button className="lp-primary" onClick={onRevise}>Create revised draft</button></footer>
 </dialog>
}
