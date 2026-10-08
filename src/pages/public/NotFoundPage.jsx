import {ArrowRight} from 'lucide-react'
import SiteLayout from '../../components/site/SiteLayout.jsx'
import './pages-v2.css'

export default function NotFoundPage({exam=false}){
 return <SiteLayout><section className="ks-wrap pg-404">
  <b>4<span>0</span>4</b>
  <h1>{exam?'Exam not found':'Page not found'}</h1>
  <p>{exam?'This exam is not in our current catalogue.':'This address does not match a page on our website.'}</p>
  <div className="h2-cta" style={{justifyContent:'center',display:'flex',gap:10,flexWrap:'wrap',marginTop:10}}><a className="ks-btn ks-btn-navy" href={exam?'/exams':'/'}>{exam?'Browse exams & programs':'Back to home'} <ArrowRight size={16}/></a><a className="ks-btn ks-btn-ghost" href="/courses">Courses &amp; fees</a></div>
 </section></SiteLayout>
}
