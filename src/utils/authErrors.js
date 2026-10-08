export function isEmailSendLimitError(error) {
  return error?.code === 'over_email_send_rate_limit' || /email rate limit exceeded/i.test(String(error?.message || ''))
}

export function getAuthError(error, fallback = 'Account request failed. Please try again.') {
  const code = error?.code || ''
  const message = String(error?.message || '')
  if (/signed-in account does not match/i.test(message)) return 'The signed-in account does not match the email entered. Please sign in again.'
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return 'Sign in failed. Check the email and password, then try again.'
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) return 'Confirm your email before signing in. Check your inbox and spam folder.'
  if (isEmailSendLimitError(error)) return 'The email service has reached its sending limit. Signup and password recovery share this limit. Please try later; changing your email address will not resolve it.'
  if (error?.status === 429 || /rate.limit|too many requests/i.test(code + ' ' + message)) return 'Too many requests. Please try again later.'
  if (['user_already_exists', 'email_exists'].includes(code) || /already (registered|exists)/i.test(message)) return 'Unable to create this account. Try signing in if you already registered.'
  if (code === 'weak_password' || /weak password|password should/i.test(message)) return 'Choose a stronger password and try again.'
  if (/network|failed to fetch|fetch failed|timeout|timed out/i.test(message)) return 'Network connection failed. Check your connection and try again.'
  return fallback
}
