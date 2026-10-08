import {ArrowRight,CalendarCheck,Check,Clock,MapPin,Navigation,Phone} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import './home-v2.css'
import './pages-v2.css'
import brand from '../../config/brand.js'

const PHONE=brand.contact.phoneHref.replace('tel:',''),PHONE_LABEL=brand.contact.phone
const MAP='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(brand.contact.mapQuery||brand.contact.address+', '+brand.contact.city)
const [MAIN,...OTHERS]=brand.centres

function Contact(){
 return <>
  <div className="pg-contact">
   <div className="pg-contact-card is-navy"><span className="pg-ic"><Phone size={22}/></span><h2>Talk to our team</h2><p>Ask about programs, fees, batch timings or a free demo class.</p><p className="pg-big">{PHONE_LABEL}</p>
    <div className="pg-card-actions"><a className="ks-btn ks-btn-yellow" href={'tel:'+PHONE}><Phone size={16}/> Call now</a><a className="ks-btn ks-btn-outline-light" href={'sms:'+PHONE}>Send SMS</a></div></div>
   <div className="pg-contact-card"><span className="pg-ic"><MapPin size={22}/></span><h2>Visit us in {brand.contact.city}</h2><p className="pg-big" style={{fontSize:24}}>{brand.contact.address.split(',').pop().trim()}</p><p>{brand.contact.address}, {brand.contact.city}</p>
    <div className="pg-card-actions"><a className="ks-btn ks-btn-navy" href={MAP} target="_blank" rel="noreferrer"><Navigation size={16}/> Get directions</a><a className="ks-btn ks-btn-ghost" href="/branches">All branches</a></div></div>
  </div>
  <div className="pg-contact" style={{marginTop:22}}>
   <div className="pg-contact-card"><span className="pg-ic"><CalendarCheck size={22}/></span><h2>Book a free demo class</h2><p>Call us with the student's class and the program you are interested in. We will suggest a batch and a convenient demo time.</p>
    <ul className="pg-hours"><li><Check size={16}/>School Foundation · Classes VI – X</li><li><Check size={16}/>Sainik · RMS · RIMC · Navodaya</li><li><Check size={16}/>IIT / NEET Foundation, JEE Main, NEET</li><li><Check size={16}/>DSC · Group-II · SI &amp; Constable</li></ul></div>
   <div className="pg-contact-card"><span className="pg-ic"><Clock size={22}/></span><h2>Ready to join?</h2><p>See every course with its fee and enroll online in a few minutes. Pay securely with UPI, card or net banking and your course opens in your student portal right away.</p>
    <div className="pg-card-actions"><a className="ks-btn ks-btn-yellow" href="/courses">Courses &amp; fees <ArrowRight size={16}/></a><a className="ks-btn ks-btn-ghost" href="/login">Student login</a></div></div>
  </div>
 </>
}

function Branches(){
 return <>
  <div className="pg-branches">
   <article className="pg-branch is-main"><span className="pg-branch-tag">{MAIN.tag}</span><h3>{MAIN.name}</h3><p>{MAIN.address}</p>
    <div className="pg-card-actions"><a className="ks-btn ks-btn-navy" href={MAP} target="_blank" rel="noreferrer"><Navigation size={15}/> Directions</a><a className="ks-btn ks-btn-ghost" href={'tel:'+PHONE}><Phone size={15}/> Call</a></div></article>
   {OTHERS.map(b=><article key={b.name} className="pg-branch"><span className="pg-branch-tag">{b.tag}</span><h3>{b.name}</h3><p>{b.address}. Call us for batch timings and programs offered.</p>
    <div className="pg-card-actions"><a className="ks-btn ks-btn-ghost" href={'tel:'+PHONE}><Phone size={15}/> {PHONE_LABEL}</a></div></article>)}
  </div>
  <div className="pg-note"><div><h2>Not sure which branch suits you?</h2><p>Our team will help you choose the nearest centre and the right batch.</p></div><div className="pg-note-actions"><a className="ks-btn ks-btn-yellow" href={'tel:'+PHONE}><Phone size={16}/> Call {PHONE_LABEL}</a></div></div>
 </>
}

const pages={
 contact:{eyebrow:'Contact',title:'We’re here to help you choose the right path.',lead:'Call, visit our '+brand.contact.city+' centre or enroll online. Parents and students are always welcome.',Body:Contact},
 branches:{eyebrow:'Our branches',title:'Learn at a centre near you.',lead:brand.centres.map(c=>c.name).join(', ')+' — the same disciplined teaching and online student portal everywhere.',Body:Branches},
}
export default function InformationPage({page}){
 const {eyebrow,title,lead,Body}=pages[page]||pages.contact
 return <SiteLayout><div className="ksc-home2">
  <section className="pg-hero"><div className="ks-wrap"><p className="h2-eyebrow on-dark">{eyebrow}</p><h1>{title}</h1><p className="pg-lead">{lead}</p></div></section>
  <section className="ks-wrap pg-body"><Body/></section>
 </div></SiteLayout>
}
