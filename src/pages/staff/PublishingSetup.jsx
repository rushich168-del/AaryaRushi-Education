import {useState} from 'react'
import {CheckCircle2,Users} from 'lucide-react'

export default function PublishingSetup({paper,adminView,onRefresh,loading=false,basePath}){
 const [copied,setCopied]=useState(false),[error,setError]=useState('')
 const assignments='/dashboard/admin/assignments?program='+encodeURIComponent(paper.exam_id)+'&paper='+encodeURIComponent(paper.id)
 async function copyRequest(){
  setError('')
  try{await navigator.clipboard.writeText(`Please set up publishing access for “${paper.title}” (${paper.exam_name}). Link a course to its program track, create a student batch, enroll the intended students and assign my teacher account to the course and batch.`);setCopied(true)}catch{setError('Copy is unavailable in this browser. Use the setup details below when contacting your administrator.')}
 }
 return <section className="publishing-setup" aria-label="Set up publishing access">
  <span className="publishing-setup-icon"><Users size={24}/></span><h4>No matching course yet</h4>
  <p>{adminView?`Set up the audience for ${paper.exam_name}, then return here to publish.`:`Your administrator needs to connect ${paper.exam_name} to your teaching audience.`}</p>
  <ol>{[
   ['Course','Create or choose the course that will deliver this test.',adminView?'/dashboard/admin/courses':null,'Create or choose a course'],
   ['Program link','Connect the course to '+paper.exam_name+' so this paper is available for it.',adminView?'/dashboard/admin/exams':null,'Link program track'],
   ['Students & teachers','Create a batch, enroll the intended students and assign its teacher.',adminView?assignments:null,'Set up batch & access'],
  ].map(([title,description,href,label],i)=><li key={title}><span>{i+1}</span><div><strong>{title}</strong><p>{description}</p>{href&&<a href={href} target="_blank" rel="noopener noreferrer">{label} ↗</a>}</div></li>)}</ol>
  <p className="publishing-setup-kept"><CheckCircle2 size={18}/>Your paper stays selected while you complete setup.</p>
  <div className="publishing-setup-actions">{!adminView&&<><button onClick={copyRequest}>{copied?'Setup request copied':'Copy setup request'}</button><a href={basePath+'/courses'} target="_blank" rel="noopener noreferrer">Check my assignments ↗</a></>}<button className="staff-button" disabled={loading} onClick={onRefresh}>{loading?'Checking access…':'Refresh course & batch access'}</button></div>
  {error&&<p role="alert">{error}</p>}
 </section>
}
