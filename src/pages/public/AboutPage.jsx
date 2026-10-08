import {ArrowRight,BookOpenCheck,ClipboardCheck,Target,UsersRound} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import './home-v2.css'
import './pages-v2.css'
import brand from '../../config/brand.js'

const values=[
 [BookOpenCheck,'Concepts first','We teach the “why” before the shortcut, so knowledge lasts beyond the exam.'],
 [ClipboardCheck,'Regular practice','Chapter tests and full-length mocks in the real exam pattern, with answer review.'],
 [Target,'Personal attention','Small batches so every student is seen, guided and corrected early.'],
 [UsersRound,'Discipline & care','A focused, respectful environment that parents trust and students enjoy.'],
]
export default function AboutPage(){
 return <SiteLayout><div className="ksc-home2">
  <section className="pg-hero"><div className="ks-wrap">
   <p className="h2-eyebrow on-dark">About {brand.name}</p>
   <h1>Success, built one small step at a time.</h1>
   <p className="pg-lead">{brand.name} coaches students for school foundation, military school entrance, IIT / NEET and government exams — with disciplined teaching, regular tests and personal attention.</p>
  </div></section>
  <section className="ks-wrap pg-body">
   <div className="pg-split">
    <div>
     <p className="h2-eyebrow">Our approach</p>
     <h2>Understanding first. Confidence follows.</h2>
     <p className="pg-text">Every program starts with strong basics. Students learn the concept, practise it step by step, and review their tests to see exactly where to improve next. Parents can follow the progress, and students always know their next step.</p>
     <p className="pg-text">Today our students learn in the classroom and continue online — lessons, study material, timed tests and instant results in one student portal.</p>
     <div className="h2-cta"><a className="ks-btn ks-btn-navy" href="/courses">Explore courses &amp; fees <ArrowRight size={16}/></a><a className="ks-btn ks-btn-ghost" href="/contact">Visit or call us</a></div>
    </div>
    <div className="pg-photo"><img src={brand.images.hero} alt="Illustration of study materials, a test paper and a progress chart" loading="lazy"/></div>
   </div>
   <div className="pg-values">{values.map(([Icon,t,c])=><div key={t} className="pg-value"><span><Icon size={21}/></span><h3>{t}</h3><p>{c}</p></div>)}</div>
   <div className="pg-note"><div><h2>See the classroom for yourself</h2><p>Book a free demo class at our {brand.contact.city} centre.</p></div><div className="pg-note-actions"><a className="ks-btn ks-btn-yellow" href="/contact">Book a demo class</a></div></div>
  </section>
 </div></SiteLayout>
}
