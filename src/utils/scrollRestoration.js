// App-wide scroll restoration.
//
// Architecture notes (why this is a singleton driven by route events, not a
// per-component React hook):
//
//   * Every authenticated page renders through the shared DashboardLayout and the
//     real scroller is the window/document — the layout grows with its content
//     (`min-h-screen`) and no inner overflow-y-auto pane wraps routed content. A
//     future page that owns a genuinely-scrollable pane can opt in by tagging it
//     `data-scroll-restore="..."`; this module uses that element only when it is
//     actually scrollable, otherwise it falls back to the document scroller.
//
//   * Saving on React unmount is unreliable: useEffect cleanup runs after React
//     has already swapped in the next page. Instead we save on the `popstate`
//     event (fired while the outgoing DOM is still mounted), continuously on
//     scroll, and on pagehide / visibilitychange:hidden — and we track the
//     current route key ourselves so a save is always written under the page
//     being left.
//
//   * History is deliberately NOT handled here — it has its own dedicated path
//     (routes.js + HistoryPage) that is guarded by React's real loading state.
//     This manager skips HISTORY_PATH for both save and restore so the two never
//     conflict. The continuous scroll-saver is also suppressed WHILE a restore is
//     running, so a restore's own intermediate scrollTop writes can't overwrite a
//     saved offset.
//
// Route key = pathname. Stored as sessionStorage `projectAtlas.scrollRestore:<path>`.
// sessionStorage is per-tab and survives in-tab navigation, back/forward, bfcache
// and tab switching (all same-tab), which is exactly the scope we support; we do
// not attempt cross-browser sync.

const STORAGE_PREFIX = 'projectAtlas.scrollRestore:'
const RESTORE_TIMEOUT_MS = 5000

// History is handled by its own dedicated, proven path (routes.js + HistoryPage),
// because its async, partially-tall loading state made this generic manager save
// 0 over a valid deep scroll value. The manager skips this route entirely so the
// two systems never fight.
const HISTORY_PATH = '/dashboard/history'

let installed = false
let currentKey = null
let saveFrame = 0
let restoreToken = 0
let activeRestores = 0

function keyForPath(pathname) {
  return pathname || '/'
}

function getDocumentScroller() {
  return window.document.scrollingElement || window.document.documentElement
}

function maxScrollTop(element) {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

// Resolve the element that actually scrolls for the current page. Prefer a
// tagged, genuinely-scrollable container; otherwise the whole document scrolls.
function getActiveScroller() {
  const tagged = window.document.querySelector('[data-scroll-restore]')

  if (tagged && maxScrollTop(tagged) > 1) {
    return tagged
  }

  return getDocumentScroller()
}

function readSaved(key) {
  try {
    const value = Number(window.sessionStorage.getItem(STORAGE_PREFIX + key))
    return Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

function writeSaved(key, top) {
  try {
    window.sessionStorage.setItem(STORAGE_PREFIX + key, String(top))
  } catch {
    // Best-effort UI state; ignore restricted storage contexts.
  }
}

// Persist the current route's scroll position. Skipped when there is nothing to
// scroll (page short / mid-load) and while a restore is running, so a transient
// collapse or the restore's own clamped writes never overwrite a good value.
function saveCurrent() {
  if (!currentKey || currentKey === HISTORY_PATH || activeRestores > 0) {
    return
  }

  const scroller = getActiveScroller()

  if (maxScrollTop(scroller) <= 1) {
    return
  }

  writeSaved(currentKey, scroller.scrollTop || 0)
}

// Restore a route's saved position, retrying across frames because History /
// Workspace data renders after the route mounts and grows the page.
function scheduleRestore(key) {
  // History restores through its own path; do not touch it here.
  if (key === HISTORY_PATH) {
    return
  }

  const token = ++restoreToken
  const target = readSaved(key)

  if (target === null) {
    // Fresh route (no saved position) — reset to top once, no retry needed.
    window.requestAnimationFrame(() => {
      if (token === restoreToken && currentKey === key) {
        getActiveScroller().scrollTop = 0
      }
    })
    return
  }

  const startedAt = Date.now()
  let lastMax = -1
  let stableFrames = 0
  let finished = false

  activeRestores += 1

  function finish() {
    if (!finished) {
      finished = true
      activeRestores = Math.max(0, activeRestores - 1)
    }
  }

  function attempt() {
    // Superseded by a newer navigation, or the route changed again mid-retry.
    if (token !== restoreToken || currentKey !== key) {
      finish()
      return
    }

    const scroller = getActiveScroller()
    const max = maxScrollTop(scroller)
    const desired = Math.min(target, max)

    // Assign scrollTop directly: instant, and it ignores the global
    // `html { scroll-behavior: smooth }` that would otherwise animate.
    scroller.scrollTop = desired

    if (max === lastMax) {
      stableFrames += 1
    } else {
      stableFrames = 0
    }
    lastMax = max

    const reached = Math.abs(scroller.scrollTop - desired) <= 2
    const tallEnough = max >= target
    const elapsed = Date.now() - startedAt

    // Accept a page that is genuinely shorter than the saved offset ONLY once its
    // height has held steady for many frames AND enough time has passed for async
    // content to have rendered. History's loading state is itself partially tall
    // and height-stable, so a naive "stable => done" check would stop the retry
    // before the async list grew the page to the saved depth.
    const settledShorter = max > 0 && stableFrames >= 12 && elapsed > 1500
    const timedOut = elapsed > RESTORE_TIMEOUT_MS

    if ((reached && (tallEnough || settledShorter)) || timedOut) {
      finish()
      return
    }

    window.requestAnimationFrame(attempt)
  }

  window.requestAnimationFrame(attempt)
}

function handleScroll() {
  if (saveFrame) {
    return
  }

  saveFrame = window.requestAnimationFrame(() => {
    saveFrame = 0
    saveCurrent()
  })
}

function handleVisibilityChange() {
  if (window.document.visibilityState === 'hidden') {
    saveCurrent()
  }
}

function handlePopState() {
  // The outgoing DOM is still mounted here (React re-renders after this handler),
  // so this reads the correct leaving-route scroll. Save it under the OLD key.
  saveCurrent()

  // Switch to the new route and restore once React has rendered it.
  currentKey = keyForPath(window.location.pathname)
  scheduleRestore(currentKey)
}

// Fired on initial load AND when a page is restored from the bfcache (back/forward
// to a document without a React remount or loading transition). Re-sync the key
// and restore, so a bfcache return doesn't leave History pinned at the top.
function handlePageShow() {
  currentKey = keyForPath(window.location.pathname)
  scheduleRestore(currentKey)
}

// Idempotent. Safe to call from every DashboardLayout mount; listeners install
// once. Independent of React lifecycle so it survives remounts and covers both
// in-app navigation and native browser back/forward (both emit popstate).
export function installScrollRestoration() {
  if (installed || typeof window === 'undefined') {
    return
  }

  installed = true

  try {
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual'
    }
  } catch {
    // Ignore environments that block history access.
  }

  currentKey = keyForPath(window.location.pathname)

  // Capture phase so scroll from the document AND any internal scroll container
  // is observed (scroll events don't bubble but do have a capture phase).
  window.addEventListener('scroll', handleScroll, { passive: true, capture: true })
  window.addEventListener('popstate', handlePopState)
  window.addEventListener('pageshow', handlePageShow)
  window.addEventListener('pagehide', saveCurrent)
  window.document.addEventListener('visibilitychange', handleVisibilityChange)

  // Restore the initial route (direct load / refresh with a saved position).
  scheduleRestore(currentKey)
}
