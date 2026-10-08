import {useEffect,useRef,useState} from 'react'
import {ArrowRight,ArrowUpRight,Mail,MapPin,Menu,Phone,X} from 'lucide-react'
import './site.css'
import brand from '../../config/brand.js'

const links=[['/','Home'],['/courses','Courses & fees'],['/exams','Exams'],['/about','About'],['/contact','Contact']]

export function Logo({light=false}){
 return <a href="/" className={'ks-logo'+(light?' is-light':'')} aria-label={brand.name+' home'}>
  <img src={light?brand.logo.markLight:brand.logo.mark} alt="" width="46" height="46"/>
  <span><strong>{brand.name}</strong><small>{brand.tagline}</small></span>
 </a>
}

export default function SiteLayout({children}){
 const [open,setOpen]=useState(false),[scrolled,setScrolled]=useState(false)
 const button=useRef(null)
 const path=window.location.pathname.replace(/\/+$/,'')||'/'
 useEffect(()=>{const on=()=>setScrolled(window.scrollY>8);on();window.addEventListener('scroll',on,{passive:true});return()=>window.removeEventListener('scroll',on)},[])
 const close=e=>{if(e.key==='Escape'){setOpen(false);button.current?.focus()}}
 return <div className="ks-site">
  <a href="#main" className="ks-skip">Skip to content</a>
  <header className={'ks-header'+(scrolled?' is-scrolled':'')} onKeyDown={close}>
   <div className="ks-wrap ks-header-row">
    <Logo/>
    <button ref={button} type="button" className="ks-menu" aria-label={open?'Close menu':'Open menu'} aria-expanded={open} aria-controls="ks-nav" onClick={()=>setOpen(!open)}>{open?<X size={22}/>:<Menu size={22}/>}</button>
    <nav id="ks-nav" aria-label="Main" className={'ks-nav'+(open?' is-open':'')}>
     {links.map(([href,label])=><a key={href} href={href} aria-current={path===href||(href!=='/'&&path.startsWith(href+'/'))?'page':undefined}>{label}</a>)}
     <span className="ks-nav-actions">
      <a href="/login" className="ks-btn ks-btn-ghost">Student login</a>
      <a href="/courses" className="ks-btn ks-btn-yellow">Enroll now <ArrowRight size={16}/></a>
     </span>
    </nav>
   </div>
  </header>
  <main id="main" tabIndex={-1}>{children}</main>
  <footer className="ks-footer">
   <div className="ks-wrap">
    <div className="ks-footer-grid">
     <div className="ks-footer-brand"><Logo light/><p>Disciplined learning for a brighter tomorrow. School foundation, military entrance, IIT / NEET and government exam coaching.</p></div>
     <div><h2>Learn</h2><a href="/courses">Courses &amp; fees</a><a href="/exams">Exams we prepare for</a><a href="/demo/tests/foundation-practice-test-1">Try a sample test</a></div>
     <div><h2>Students</h2><a href="/login">Student login</a><a href="/signup">Create an account</a><a href="/dashboard/student/payments">My payments</a></div>
     <div><h2>Contact</h2><a href={brand.contact.phoneHref}><Phone size={15}/> {brand.contact.phone}</a><span><MapPin size={15}/> {brand.contact.address}, {brand.contact.city}</span><a href="/contact"><Mail size={15}/> Send an enquiry <ArrowUpRight size={14}/></a></div>
    </div>
    <div className="ks-footer-bottom"><p>© {new Date().getFullYear()} {brand.name}. Demo project — all names and contact details are placeholders.</p><p>Payments are processed securely by Razorpay.</p></div>
   </div>
  </footer>
 </div>
}
