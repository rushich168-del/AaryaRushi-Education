import {useAuth} from '../../context/AuthContext.jsx'
import './staff.css'

export default function AdminSetupPage(){
 const {user}=useAuth()
 return <main className="staff-status"><section className="staff-card staff-access-message">
  <p className="staff-eyebrow">ONE-TIME INSTITUTE SETUP</p>
  <h1>Set up your first administrator</h1>
  <p>Your account and administrator permission are two separate steps. You can use an existing account; you do not need to sign up again.</p>
  {user?.email&&<p className="staff-account-email">Current account: {user.email}</p>}
  <ol>
   <li><strong>Choose the institute owner.</strong><p>Use their confirmed email account and existing password.</p></li>
   <li><strong>Enable staff management.</strong><p>The setup operator connects the verified backend and grants that account administrator access. This step cannot be completed by public signup.</p></li>
   <li><strong>Sign in and add your teachers.</strong><p>Open Staff &amp; access, select Add teacher, enter their name, email and temporary password, then choose their courses and batches.</p></li>
   <li><strong>Give teachers their login link.</strong><p>Teachers use /teacher/login and change the temporary password before opening their assigned workspace.</p></li>
  </ol>
  <p>Staff &amp; access becomes available after backend setup. This page does not create an administrator or change account permissions.</p>
  <div className="staff-actions"><a className="staff-button" href="/admin/login">Return to Admin Login</a><a className="staff-link" href="/">Back to homepage</a></div>
 </section></main>
}

