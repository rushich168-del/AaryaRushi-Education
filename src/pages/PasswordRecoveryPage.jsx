import { useRef, useState } from 'react'
import {CheckCircle2,MailCheck} from 'lucide-react'
import ProgramOnboardingShell from '../components/site/ProgramOnboardingShell.jsx'
import { useAuth } from '../context/AuthContext.jsx'
import { getAuthError, isEmailSendLimitError } from '../utils/authErrors.js'
import { navigateTo } from '../utils/routes.js'
import { portalLoginPath } from '../lib/portalSession.js'
import brand from '../config/brand.js'

export default function PasswordRecoveryPage({ reset = false }) {
  const { session, loading, isConfigured, requestPasswordReset, updatePassword } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [emailLimit, setEmailLimit] = useState(false)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [invalidLink] = useState(() => {
    const query = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.slice(1))
    return query.has('error') || query.has('error_code') || hash.has('error') || hash.has('error_code')
  })

  async function submit(event) {
    event.preventDefault()
    if (pending.current || done) return
    setError('')
    setEmailLimit(false)
    if (!isConfigured) return setError('Account recovery is not available yet. Please try again later.')
    if (reset && (loading || !session || invalidLink)) return setError('Open a new recovery link to continue.')
    if (reset && password !== confirmation) return setError('Passwords do not match.')
    pending.current = true
    setBusy(true)
    try {
      const result = reset ? await updatePassword(password) : await requestPasswordReset(email.trim())
      if (result.error) throw result.error
      if (reset && !result.data?.user) throw new Error('No updated user returned')
      setPassword('')
      setConfirmation('')
      setDone(true)
    } catch (err) {
      setEmailLimit(!reset && isEmailSendLimitError(err))
      setError(getAuthError(err, reset ? 'Password could not be updated. Try again or request a new recovery link.' : 'Recovery email could not be requested. Please try again.'))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return <ProgramOnboardingShell recovery>
    <section className="program-account-form program-recovery">
      <small className="program-recovery-eyebrow">ACCOUNT RECOVERY</small>
      <h2>{reset ? 'Set a new password' : 'Forgot your password?'}</h2>
      <p>{reset ? 'Choose a new password to continue learning.' : 'Enter the email you registered with. We’ll send you a recovery link.'}</p>
      {done ? <div className="program-confirmation" role="status">
        {reset ? <CheckCircle2 size={36}/> : <MailCheck size={36}/>}
        <h3>{reset ? 'Password updated' : 'Recovery request accepted'}</h3>
        <p>{reset ? 'Your password has been updated.' : 'If an account matches this email, you will receive a recovery link. Check your inbox and spam folder.'}</p>
        <button type="button" className="program-primary" onClick={() => navigateTo(reset ? '/dashboard' : portalLoginPath)}>{reset ? 'Continue to portal' : 'Back to sign in'}</button>
      </div> : reset && loading ? <p role="status">Checking recovery session…</p> : reset && (!session || invalidLink) ? <div className="program-notice">
        <p role="alert">This recovery link is invalid or expired. Request a new link to continue.</p>
        <button type="button" onClick={() => navigateTo('/forgot-password')} className="program-text-button">Request a new link</button>
      </div> : <form onSubmit={submit}>
        {error && <div role="alert" className="program-error">
          {emailLimit ? <><strong>Recovery email is temporarily unavailable</strong><p>The email sending allowance has been reached. This can happen on your first attempt because signup and recovery emails share the same allowance.</p><p>No recovery link was sent for this request. Try again later, or contact us for help.</p><a className="program-text-button" href="/contact">Contact {brand.name}</a></> : error}
        </div>}
        {reset ? <>
          <label>New password<input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} disabled={busy}/></label>
          <p className="program-recovery-hint">Use at least 8 characters.</p>
          <label>Confirm new password<input type="password" autoComplete="new-password" minLength={8} required value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={busy}/></label>
        </> : <label>Email address<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} disabled={busy}/></label>}
        <button type="submit" disabled={busy || !isConfigured} className="program-primary">{busy ? 'Please wait…' : reset ? 'Update password' : 'Send recovery link'}</button>
      </form>}
      {!reset&&!done&&<p className="program-notice">Already registered but not confirmed your email? Open your original signup confirmation email first. Password recovery does not replace email confirmation.</p>}
      {!done&&<div className="program-onboarding-actions"><a href={portalLoginPath} className="program-text-button">Back to sign in</a>{!reset&&<a href="/contact" className="program-text-button">Need help with your account?</a>}</div>}
    </section>
  </ProgramOnboardingShell>
}
