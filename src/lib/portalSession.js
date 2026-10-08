const portals = ['student', 'teacher', 'admin', 'testcreator']
const tabKey = 'ksc.auth.portal'

export function portalForUrl(value, fallback = 'student') {
  const url = new URL(value, 'http://ksc.local')
  for (const portal of portals) {
    if (url.pathname === `/${portal}/login` || url.pathname === `/${portal}/setup` || url.pathname === `/dashboard/${portal}` || url.pathname.startsWith(`/dashboard/${portal}/`)) return portal
  }
  if (url.pathname === '/login' || url.pathname === '/signup' || url.pathname.startsWith('/test/')) return 'student'
  if (url.pathname === '/forgot-password' || url.pathname === '/reset-password') {
    const requested = url.searchParams.get('portal')
    if (portals.includes(requested)) return requested
  }
  return portals.includes(fallback) ? fallback : 'student'
}

function initialPortal() {
  if (typeof window === 'undefined') return 'student'
  let remembered
  try { remembered = window.sessionStorage.getItem(tabKey) } catch {}
  const portal = portalForUrl(window.location.href, remembered)
  try { window.sessionStorage.setItem(tabKey, portal) } catch {}
  return portal
}

// One client per document. Crossing portals must load the destination document
// before its services run, so a previous portal's identity cannot be reused.
export const authPortal = initialPortal()
export const portalLoginPath = authPortal === 'student' ? '/login' : `/${authPortal}/login`
export const recoveryPath = authPortal === 'student' ? '/reset-password' : `/reset-password?portal=${authPortal}`

export function crossesPortal(path) {
  return portalForUrl(path, authPortal) !== authPortal
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (crossesPortal(window.location.href)) window.location.reload()
  })
}
