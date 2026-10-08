import {useEffect,useState} from 'react'
import {LayoutDashboard,BookOpen,FileText,LibraryBig,ClipboardList,ChartNoAxesColumn,LogOut,Menu,X} from 'lucide-react'
import {useAuth} from '../../context/AuthContext.jsx'
import {navigateTo} from '../../utils/routes.js'
import './staff.css'
import './teacher-portal.css'
import AdminWorkspace from './AdminWorkspace.jsx'
import brand from '../../config/brand.js'
export default function StaffWorkspace({role,accountRole=role,children}){
 const {user,signOut}=useAuth()
 const [menu,setMenu]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const [avatarFailed,setAvatarFailed]=useState(false)
 const [view,setView]=useState(()=>new URLSearchParams(window.location.search).get('view'))
 useEffect(()=>{const update=()=>setView(new URLSearchParams(window.location.search).get('view'));window.addEventListener('ksc-library-view',update);return()=>window.removeEventListener('ksc-library-view',update)},[])
 if(role==='admin')return <AdminWorkspace user={user} signOut={signOut}>{children}</AdminWorkspace>
 const base='/dashboard/teacher',path=window.location.pathname
 const links=[[base,'Dashboard',LayoutDashboard],[base+'/courses','My courses',BookOpen],[base+'/materials','Study materials',FileText],[base+'/library','Paper library',LibraryBig],[base+'/library?view=published','Published tests',ClipboardList],[base+'/results','Student results',ChartNoAxesColumn]]
 const name=user?.user_metadata?.full_name||user?.user_metadata?.name||user?.email?.split('@')[0]||'Teacher'
 const avatar=user?.user_metadata?.avatar_url
 async function exit(){if(busy)return;setBusy(true);setError('');try{const result=await signOut();if(result?.error)throw result.error;navigateTo('/teacher/login')}catch{setError('Sign out failed. Please retry.');setBusy(false)}}
 return <div className="staff-workspace admin-workspace teacher-role-workspace"><a className="admin-skip" href="#teacher-main">Skip to content</a><aside className={'admin-sidebar'+(menu?' is-open':'')} id="teacher-navigation"><a className="admin-brand" href="/" aria-label={brand.name+' home'}><img src={brand.logo.markLight} alt="" aria-hidden="true" width="46" height="46"/><span>{brand.name}<small>{brand.tagline}</small></span></a><p className="admin-caption">TEACHER WORKSPACE</p><nav aria-label="Teacher navigation">{links.map(([href,label,Icon])=><a key={label} href={href} aria-current={path===href.split('?')[0]&&(href.includes('?')?view==='published':!href.endsWith('/library')||view!=='published')?'page':undefined}><Icon size={19}/>{label}</a>)}</nav><details className="admin-tools"><summary>More teaching tools</summary><a href={base+'/students'}>My students</a><a href={base+'/paper-tests'}>Paper → Online test</a>{accountRole==='admin'&&<a href="/dashboard/admin">Admin portal</a>}</details><div className="admin-sidebar-bottom"><button disabled={busy} onClick={exit}><LogOut size={18}/>{busy?'Signing out…':'Sign out / switch account'}</button>{error&&<p role="alert">{error}</p>}</div></aside><div className="admin-body"><header className="admin-topbar"><button className="admin-menu" aria-label={menu?'Close navigation':'Open navigation'} aria-expanded={menu} aria-controls="teacher-navigation" onClick={()=>setMenu(x=>!x)}>{menu?<X/>:<Menu/>}</button><div className="admin-profile">{avatar&&!avatarFailed?<img className="admin-avatar" src={avatar} alt="Your profile" onError={()=>setAvatarFailed(true)}/>:<span className="admin-avatar" aria-hidden="true">{name.slice(0,1).toUpperCase()}</span>}<div><h1>Hello, {name}</h1><p>{accountRole==='admin'?'Administrator · teaching view':'Teacher workspace'} · {user?.email}</p></div></div></header><main id="teacher-main" className="staff-workspace-content admin-content" onKeyDown={e=>{if(e.key==='Escape')setMenu(false)}}>{children}</main></div></div>
}

