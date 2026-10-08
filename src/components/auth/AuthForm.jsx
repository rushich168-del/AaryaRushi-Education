import { AlertCircle, ArrowRight, Loader2 } from 'lucide-react'
import brand from '../../config/brand.js'

export default function AuthForm({
  mode,
  email,
  password,
  loading,
  error,
  message,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}) {
  const isSignup = mode === 'signup'

  return (
    <form onSubmit={onSubmit} className="grid gap-5">
      <div>
        <h2 className="text-2xl font-semibold text-primary">{isSignup ? 'Create account' : 'Sign in'}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {isSignup ? `Create your ${brand.name} account.` : `Use your ${brand.name} email and password.`}
        </p>
      </div>

      {!message && (
        <>
          <label className="grid gap-2">
            <span className="text-sm font-semibold text-slate-600">Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => onEmailChange(event.target.value)}
              required
              autoComplete="email"
              className="min-h-11 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-primary outline-none transition focus:border-accentBlue"
              placeholder="you@example.com"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-semibold text-slate-600">Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              required
              minLength={6}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              className="min-h-11 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-primary outline-none transition focus:border-accentBlue"
              placeholder="At least 6 characters"
            />
          </label>
        </>
      )}

      {error && (
        <div className="flex gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-medium leading-6 text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      {message && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium leading-6 text-emerald-700">
          {message}
        </div>
      )}

      {!message && (
        <button
          type="submit"
          disabled={loading}
          className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {loading ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : null}
          {isSignup ? 'Create account' : 'Sign in'}
          {!loading ? <ArrowRight size={17} aria-hidden="true" /> : null}
        </button>
      )}
    </form>
  )
}
