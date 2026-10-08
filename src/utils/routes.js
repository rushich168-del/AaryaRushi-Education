import { crossesPortal } from '../lib/portalSession.js'

const historyPath = '/dashboard/history'
const historyScrollStorageKey = 'projectAtlas.history.scrollTop'

// History uses a dedicated, proven scroll-restoration path (this file +
// HistoryPage), separate from the app-wide scrollRestoration.js manager which
// handles Dashboard / Workspace / other routes. History is special-cased because
// its list loads asynchronously and its loading state is partially tall, which
// tripped the generic manager into saving 0 over a valid deep scroll value. The
// manager explicitly skips historyPath so the two never fight.
//
// The whole document is the History scroll container: the dashboard layout uses
// `min-h-screen` and grows with its content, so the window/document scrolls —
// there is no inner overflow-y-auto pane wrapping History.

function getScrollTop() {
  return window.document.scrollingElement?.scrollTop ?? window.scrollY ?? 0
}

function setScrollTop(top) {
  // `html { scroll-behavior: smooth }` is set globally (styles.css). A scrollTo
  // with behavior 'auto' follows that CSS and animates, which loses the target
  // while the page height is still settling after a route change. Assigning
  // scrollTop directly jumps instantly and ignores scroll-behavior.
  const scroller = window.document.scrollingElement || window.document.documentElement

  if (scroller) {
    scroller.scrollTop = top
  } else {
    window.scrollTo(0, top)
  }
}

export function saveHistoryScrollPosition() {
  try {
    window.sessionStorage.setItem(historyScrollStorageKey, String(getScrollTop()))
  } catch {
    // Best-effort UI state; ignore restricted storage contexts.
  }
}

function getSavedHistoryScrollPosition() {
  try {
    const savedScrollY = Number(window.sessionStorage.getItem(historyScrollStorageKey))
    return Number.isFinite(savedScrollY) && savedScrollY > 0 ? savedScrollY : null
  } catch {
    return null
  }
}

export function navigateTo(path) {
  if (crossesPortal(path)) {
    window.location.assign(path)
    return
  }
  // Save the outgoing History scroll BEFORE the URL changes and before any React
  // re-render — the reliable moment, while still on History with its DOM intact.
  if (window.location.pathname === historyPath) {
    saveHistoryScrollPosition()
  }

  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))

  // History restores through its own retry loop; every other route is restored
  // (or reset to top) by the app-wide scrollRestoration.js manager via popstate,
  // so navigateTo must NOT force those pages to the top here.
  if (path === historyPath) {
    restoreScrollForPath(path)
  }
}

export function getCurrentPath() {
  return window.location.pathname
}

// Restore the saved History scroll position. History data loads asynchronously,
// so the document is short right after the route mounts (internal nav, browser
// back/forward, remount) and grows over several frames. Keep re-applying the
// target (instantly) until the scroll lands there and the document height has
// settled, then stop. The saved value is intentionally NOT cleared so every
// return — including browser back/forward and post-reload remounts — can restore.
export function restoreScrollForPath(path) {
  if (path !== historyPath) {
    return false
  }

  const savedScrollY = getSavedHistoryScrollPosition()

  if (savedScrollY === null) {
    return false
  }

  const startedAt = Date.now()
  let lastMaxScrollY = -1

  function attempt() {
    // The user may have navigated away again while data was still loading; don't
    // fight the scroll position of whatever page is now showing.
    if (window.location.pathname !== historyPath) {
      return
    }

    const maxScrollY = Math.max(0, window.document.documentElement.scrollHeight - window.innerHeight)
    const targetScrollY = Math.min(savedScrollY, maxScrollY)

    setScrollTop(targetScrollY)

    const reachedTarget = Math.abs(getScrollTop() - targetScrollY) <= 2
    const heightStable = maxScrollY === lastMaxScrollY
    const tallEnough = maxScrollY >= savedScrollY
    const timedOut = Date.now() - startedAt > 3000

    lastMaxScrollY = maxScrollY

    // Stop once we've landed on the target and the document has either grown tall
    // enough or stopped growing (content genuinely shorter than when saved), or
    // after a safety timeout so we never fight the user indefinitely.
    if ((reachedTarget && (tallEnough || heightStable)) || timedOut) {
      return
    }

    window.requestAnimationFrame(attempt)
  }

  window.requestAnimationFrame(attempt)
  return true
}
