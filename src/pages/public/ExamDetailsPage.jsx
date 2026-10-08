import {ArrowLeft,ArrowRight,ClipboardCheck,Phone} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import {findExam} from '../../data/exams.js'
import NotFoundPage from './NotFoundPage.jsx'
import {demoTests} from '../../data/tests/demoTests.js'
import './home-v2.css'
import './pages-v2.css'
import brand from '../../config/brand.js'

export default function ExamDetailsPage({slug}){
 const exam=findExam(slug)
 if(!exam)return <NotFoundPage exam/>
 const demo=exam.demoTestId?demoTests[exam.demoTestId]?.test:null
 return <SiteLayout><div className="ksc-home2">
  <section className="pg-hero"><div className="ks-wrap"><a href="/exams" className="pg-crumb"><ArrowLeft size={16}/> All exams &amp; programs</a><h1>{exam.name}</h1><p className="pg-lead">{exam.fullName}</p></div></section>
  <section className="ks-wrap pg-body"><div className="pg-detail">
   <div>
    {demo&&<div className="pg-demo"><p className="h2-eyebrow">{exam.audience||'Practice'} · Free sample test</p><h2>{demo.title}</h2>
     <p>Take the {demo.questions.length}-question, {demo.durationSeconds/60}-minute practice paper and get your result with a worked answer review. {demo.excludedQuestionCount?`${demo.excludedQuestionCount} questions are held for teacher review, so the demo is scored out of ${demo.questions.length-demo.excludedQuestionCount}.`:''}</p>
     <div className="h2-cta" style={{marginTop:20}}><a className="ks-btn ks-btn-yellow" href={'/demo/tests/'+exam.demoTestId}><ClipboardCheck size={17}/> Start the sample test</a></div></div>}
    <dl className="pg-facts">{['Eligibility and entry class','Subjects and syllabus','Sections and question types','Duration and marking scheme'].map(l=><div key={l}><dt>{l}</dt><dd>Our team shares the latest official details during counselling.</dd></div>)}</dl>
   </div>
   <aside className="pg-side">
    <div className="pg-contact-card is-navy"><h2>Prepare with {brand.shortName}</h2><p>See the course, fee and batch for {exam.name} and enroll online.</p><div className="pg-card-actions"><a className="ks-btn ks-btn-yellow" href="/courses">Courses &amp; fees <ArrowRight size={16}/></a></div></div>
    <div className="pg-contact-card"><h2>Have a question?</h2><p>Talk to our team about eligibility, batches and a free demo class.</p><div className="pg-card-actions"><a className="ks-btn ks-btn-navy" href={brand.contact.phoneHref}><Phone size={16}/> {brand.contact.phone}</a></div></div>
   </aside>
  </div></section>
 </div></SiteLayout>
}
