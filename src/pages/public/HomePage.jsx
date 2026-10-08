import {useState} from 'react'
import {ArrowRight,ArrowUpRight,BadgeCheck,BookOpen,BookOpenCheck,ChartNoAxesCombined,ChevronDown,ClipboardCheck,CreditCard,GraduationCap,Landmark,LockKeyhole,MapPin,MonitorSmartphone,Phone,PlayCircle,ReceiptText,ShieldCheck,Smartphone,Target,Trophy,UsersRound} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import FeeCard,{usePublicPlans} from '../../components/site/FeeCard.jsx'
import './home-v2.css'
import brand from '../../config/brand.js'

const families=[
 {icon:BookOpen,title:'School Foundation',tag:'CBSE · ICSE · State Board',classes:'Classes VI – X',points:['Mathematics, Science & English','Concept strengthening','Regular chapter tests'],tone:'blue'},
 {icon:ShieldCheck,title:'Military Entrance',tag:'Sainik School · RMS · RIMC · Navodaya',classes:'Class VI · VIII · IX',points:['Entrance exam pattern','Mock tests','Interview guidance'],tone:'green'},
 {icon:GraduationCap,title:'IIT / NEET',tag:'Foundation · JEE Main · NEET',classes:'Classes VI – XII',points:['Physics, Chemistry, Maths, Biology','Concept + practice','Previous papers'],tone:'red'},
 {icon:Landmark,title:'Government Exams',tag:'DSC · Group-II · SI & Constable',classes:'Graduates & aspirants',points:['Topic-wise classes','Full-length test series','Exam strategy'],tone:'amber'},
]
const why=[
 [UsersRound,'Experienced faculty','Concept-based teaching from teachers who know each exam pattern.'],
 [BookOpenCheck,'Well-structured material','Lessons and study material organised class by class, chapter by chapter.'],
 [ClipboardCheck,'Regular tests & analysis','Online tests with instant scores and a question-by-question review.'],
 [Target,'Personal attention','Small batches so every student is seen, heard and guided.'],
]
const faqs=[
 ['How do I enroll online?','Open Courses & fees, choose your course and class, and pay online. Your course is added to your student account as soon as the payment is confirmed.'],
 ['Which payment methods can I use?','UPI (Google Pay, PhonePe, Paytm), debit and credit cards, net banking and popular wallets — all through Razorpay’s secure checkout.'],
 ['Is online payment safe?','Yes. Card and UPI details are entered on Razorpay’s secure page, never on our website. Every payment is verified on our server before your course opens.'],
 ['Will I get a receipt?','Yes. A receipt number is shown immediately after payment and is always available under My payments in your student portal.'],
 ['Can I visit before joining?','Of course. Call us or send an enquiry to book a free demo class at our '+brand.contact.city+' centre.'],
]

function Faq(){
 const [open,setOpen]=useState(0)
 return <div className="h2-faq">{faqs.map(([q,a],i)=><div key={q} className={'h2-faq-item'+(open===i?' is-open':'')}>
  <button type="button" aria-expanded={open===i} onClick={()=>setOpen(open===i?-1:i)}><span>{q}</span><ChevronDown size={20}/></button>
  <div className="h2-faq-a" hidden={open!==i}><p>{a}</p></div></div>)}</div>
}

function PortalMock(){
 return <div className="h2-mock" aria-hidden="true">
  <div className="h2-mock-bar"><i/><i/><i/><span>{brand.shortName.toLowerCase()} · student portal</span></div>
  <div className="h2-mock-body">
   <aside><img src={brand.logo.mark} alt=""/><b className="on">Dashboard</b><b>Learning</b><b>Tests</b><b>Results</b><b>Payments</b></aside>
   <div className="h2-mock-main">
    <p className="h2-mock-hello">Welcome back, Asha 👋</p>
    <div className="h2-mock-tiles"><div><small>Tests taken</small><strong>12</strong></div><div><small>Average</small><strong>78%</strong></div><div className="y"><small>Next test</small><strong>Sat</strong></div></div>
    <div className="h2-mock-card"><div><small>CONTINUE LEARNING</small><b>Algebra · Linear equations</b><span className="h2-mock-prog"><i style={{width:'64%'}}/></span></div><span className="h2-mock-go">Resume</span></div>
    <div className="h2-mock-card"><div><small>AVAILABLE TEST</small><b>Weekly Test 6 · 50 questions</b></div><span className="h2-mock-go y">Start</span></div>
    <div className="h2-mock-chart">{[42,58,51,66,72,69,81].map((h,i)=><i key={i} style={{height:h+'%'}}/>)}</div>
   </div>
  </div>
  <p className="h2-mock-note">Illustration of the student portal</p>
 </div>
}

export default function HomePage(){
 const {plans,error,setup,retry}=usePublicPlans()
 const shown=(plans||[]).slice(0,3)
 return <SiteLayout><div className="ksc-home2">
  {/* HERO */}
  <section className="h2-hero">
   <div className="h2-hero-bg" aria-hidden="true"/>
   <div className="ks-wrap h2-hero-grid">
    <div className="h2-hero-copy">
     <p className="h2-pill"><span className="h2-dot"/> Admissions open · Enroll online in minutes</p>
     <h1>Disciplined learning for a <em>brighter</em> tomorrow.</h1>
     <p className="h2-lead">Expert coaching for School, Military, Engineering, Medical and Government exams — with classes, study material and online tests in one place.</p>
     <div className="h2-cta"><a className="ks-btn ks-btn-yellow ks-btn-lg" href="/courses">View courses &amp; fees <ArrowRight size={18}/></a><a className="ks-btn ks-btn-outline-light ks-btn-lg" href="/contact"><PlayCircle size={18}/> Book a free demo class</a></div>
     <ul className="h2-hero-points"><li><BadgeCheck size={17}/> Structured learning</li><li><BadgeCheck size={17}/> Regular tests &amp; analysis</li><li><BadgeCheck size={17}/> Personal attention</li></ul>
    </div>
    <div className="h2-hero-visual">
     <div className="h2-photo"><img src={brand.images.hero} alt="Illustration of study materials, a test paper and a progress chart" width="760" height="931"/></div>
     <div className="h2-float h2-float-score"><span className="h2-float-icon"><ChartNoAxesCombined size={18}/></span><div><small>Weekly test result</small><strong>42 / 50</strong><span className="h2-mini-bar"><i/></span></div></div>
     <div className="h2-float h2-float-pay"><span className="h2-float-icon y"><LockKeyhole size={17}/></span><div><small>Secure online payment</small><strong>UPI · Cards · Net banking</strong></div></div>
     <div className="h2-float h2-float-badge"><Trophy size={18}/><span>Small steps,<br/><b>big futures</b></span></div>
    </div>
   </div>
   <div className="ks-wrap h2-strip">
    {[['School Foundation','VI – X'],['Sainik · RMS · RIMC','Entrance'],['IIT / NEET','Foundation & XI–XII'],['DSC · Group-II · SI','Government exams']].map(([a,b])=><div key={a}><strong>{a}</strong><span>{b}</span></div>)}
   </div>
  </section>

  {/* PROGRAMS */}
  <section className="ks-wrap h2-section">
   <div className="h2-head"><div><p className="h2-eyebrow">Our programs</p><h2>Focused coaching for every goal.</h2><p>From strong school basics to competitive entrance and government exams — choose the path that fits where you are today.</p></div><a href="/courses" className="h2-link">All courses &amp; fees <ArrowRight size={17}/></a></div>
   <div className="h2-families">{families.map(({icon:Icon,title,tag,classes,points,tone})=><a key={title} href="/courses" className={'h2-family t-'+tone}>
    <span className="h2-family-icon"><Icon size={24}/></span><h3>{title}</h3><p className="h2-family-tag">{tag}</p><span className="h2-family-classes">{classes}</span>
    <ul>{points.map(p=><li key={p}>{p}</li>)}</ul><span className="h2-family-go">Explore <ArrowUpRight size={18}/></span></a>)}</div>
  </section>

  {/* FEES */}
  <section className="h2-fees-band">
   <div className="ks-wrap h2-section">
    <div className="h2-head"><div><p className="h2-eyebrow">Courses &amp; fees</p><h2>Clear fees. Enroll and pay online.</h2><p>Pick a course, choose your class and pay securely. Your course opens in your student portal right after payment.</p></div><a href="/courses" className="h2-link">See every course <ArrowRight size={17}/></a></div>
    {plans===null?<div className="h2-fee-grid">{[0,1,2].map(i=><div key={i} className="ks-fee is-loading" aria-hidden="true"/>)}<span className="ks-sr" role="status">Loading courses…</span></div>
     :shown.length?<div className="h2-fee-grid">{shown.map(p=><FeeCard key={p.id} plan={p} compact/>)}</div>
     :<div className="h2-fee-empty"><ReceiptText size={28}/><div><h3>{error?'Courses could not be loaded':'Fees are being updated'}</h3><p>{error?'Please check your connection and try again.':setup?'Online fees will appear here once the institute publishes them.':'Call us for the latest fees and batch timings.'}</p></div>{error?<button type="button" className="ks-btn ks-btn-navy" onClick={retry}>Try again</button>:<a className="ks-btn ks-btn-navy" href={brand.contact.phoneHref}><Phone size={16}/> {brand.contact.phone}</a>}</div>}
    <div className="h2-pay-row"><span><LockKeyhole size={16}/> Secured by Razorpay</span><span><Smartphone size={16}/> UPI</span><span><CreditCard size={16}/> Debit &amp; credit cards</span><span><Landmark size={16}/> Net banking</span><span><ReceiptText size={16}/> Instant receipt</span></div>
   </div>
  </section>

  {/* HOW IT WORKS */}
  <section className="ks-wrap h2-section">
   <div className="h2-head h2-head-center"><div><p className="h2-eyebrow">How enrollment works</p><h2>Start learning in three simple steps.</h2></div></div>
   <ol className="h2-steps">
    <li><span className="h2-step-n">1</span><span className="h2-step-icon"><BookOpen size={24}/></span><h3>Choose your course</h3><p>Compare programs and fees, then pick your class or track.</p></li>
    <li><span className="h2-step-n">2</span><span className="h2-step-icon"><ShieldCheck size={24}/></span><h3>Pay securely</h3><p>Sign in and pay with UPI, card or net banking on Razorpay&rsquo;s secure checkout.</p></li>
    <li><span className="h2-step-n">3</span><span className="h2-step-icon"><MonitorSmartphone size={24}/></span><h3>Start learning</h3><p>Your course appears in your student portal instantly — lessons, tests and results.</p></li>
   </ol>
  </section>

  {/* PORTAL */}
  <section className="h2-portal">
   <div className="ks-wrap h2-portal-grid">
    <div><p className="h2-eyebrow on-dark">Student portal</p><h2>Classes, material and tests — always with you.</h2><p className="h2-portal-lead">Every student gets a personal portal on phone or laptop.</p>
     <ul className="h2-portal-list"><li><BookOpenCheck size={20}/><div><b>Lessons &amp; study material</b><span>Continue exactly where you stopped.</span></div></li><li><ClipboardCheck size={20}/><div><b>Online tests in real exam format</b><span>Timer, question navigator and mark-for-review.</span></div></li><li><ChartNoAxesCombined size={20}/><div><b>Instant results with answers</b><span>See every correct and wrong answer after the test.</span></div></li></ul>
     <div className="h2-cta"><a className="ks-btn ks-btn-yellow" href="/demo/tests/foundation-practice-test-1">Try a free sample test <ArrowRight size={17}/></a><a className="ks-btn ks-btn-outline-light" href="/login">Student login</a></div>
    </div>
    <PortalMock/>
   </div>
  </section>

  {/* WHY */}
  <section className="ks-wrap h2-section">
   <div className="h2-why">
    <div className="h2-why-copy"><p className="h2-eyebrow">Why {brand.name}</p><h2>Understanding first. Confidence follows.</h2><p>We build strong concepts, make room for regular practice and keep every student moving towards their goal — one step at a time.</p><a href="/about" className="h2-link">Get to know {brand.shortName} <ArrowRight size={17}/></a></div>
    <div className="h2-why-grid">{why.map(([Icon,t,c])=><div key={t} className="h2-why-card"><span><Icon size={22}/></span><h3>{t}</h3><p>{c}</p></div>)}</div>
   </div>
  </section>

  {/* FAQ */}
  <section className="h2-faq-band"><div className="ks-wrap h2-section h2-faq-grid">
   <div><p className="h2-eyebrow">Questions</p><h2>Fees &amp; payment, answered.</h2><p>Still unsure? Our team is happy to help on the phone.</p><a className="ks-btn ks-btn-navy" href={brand.contact.phoneHref}><Phone size={16}/> Call {brand.contact.phone}</a></div>
   <Faq/>
  </div></section>

  {/* CTA */}
  <section className="ks-wrap h2-final">
   <div><p className="h2-eyebrow on-dark">Give your child the right guidance</p><h2>A brighter tomorrow begins today.</h2><p><MapPin size={16}/> {brand.contact.address}, {brand.contact.city}</p></div>
   <div className="h2-final-actions"><a className="ks-btn ks-btn-yellow ks-btn-lg" href="/courses">Enroll now <ArrowRight size={18}/></a><a className="ks-btn ks-btn-outline-light ks-btn-lg" href="/contact">Book a demo class</a></div>
  </section>
 </div></SiteLayout>
}
