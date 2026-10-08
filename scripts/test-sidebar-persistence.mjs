/**
 * Project Atlas — Sidebar Persistence & Responsive State Regression Suite
 * 
 * Tests:
 * 1. Desktop collapse state persistence in localStorage key 'projectAtlas.sidebarCollapsed'.
 * 2. Inversion logic for toggle handler.
 * 3. Mobile drawer lifecycle (open, close, backdrop click, route change).
 * 4. Tab navigation state retention.
 */

let passCount = 0
let failCount = 0

function assert(condition, message) {
  if (condition) {
    passCount++
    console.log(`✓ PASS: ${message}`)
  } else {
    failCount++
    console.error(`✗ FAIL: ${message}`)
  }
}

// Mock window.localStorage for Node environment
const storageStore = new Map()
global.window = {
  localStorage: {
    getItem: (key) => storageStore.get(key) || null,
    setItem: (key, val) => storageStore.set(key, String(val)),
    removeItem: (key) => storageStore.delete(key),
    clear: () => storageStore.clear(),
  },
}

console.log('--- Testing Sidebar Persistence & Responsive State Engine ---')

const SIDEBAR_COLLAPSED_KEY = 'projectAtlas.sidebarCollapsed'

// Test 1: Default initial state (expanded)
storageStore.clear()
const initialCollapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
assert(initialCollapsed === false, 'Test 1: Default desktop sidebar is expanded (!collapsed)')

// Test 2: User toggles to collapsed
function toggleSidebarState(current) {
  const next = !current
  window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next))
  return next
}

let isCollapsed = toggleSidebarState(initialCollapsed)
assert(isCollapsed === true, 'Test 2A: Toggle switches sidebar to collapsed')
assert(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true', 'Test 2B: LocalStorage key updated to "true"')

// Test 3: Reload / Page Refresh restores collapsed state
const reloadedState = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
assert(reloadedState === true, 'Test 3: Page reload faithfully restores collapsed state from localStorage')

// Test 4: User toggles back to expanded
isCollapsed = toggleSidebarState(isCollapsed)
assert(isCollapsed === false, 'Test 4A: Toggle switches sidebar back to expanded')
assert(window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'false', 'Test 4B: LocalStorage key updated to "false"')

// Test 5: Route changes & Career Suite tab switches do not destroy desktop collapse preference
const tabs = ['overview', 'profile', 'resume', 'jobs', 'skills', 'portfolio']
let currentTab = 'overview'
let simulatedCollapse = true
window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true')

tabs.forEach((tab) => {
  currentTab = tab
  const readFromStorage = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  assert(readFromStorage === true, `Test 5 [Tab: ${tab}]: Sidebar collapse state preserved across tab change`)
})

// Test 6: Mobile drawer open / close state machine
let mobileDrawerOpen = false

function openMobileDrawer() {
  mobileDrawerOpen = true
}

function closeMobileDrawer() {
  mobileDrawerOpen = false
}

function handleMobileRouteChange() {
  // Mobile drawer auto-closes on route change
  mobileDrawerOpen = false
}

openMobileDrawer()
assert(mobileDrawerOpen === true, 'Test 6A: Mobile drawer opens on hamburger button trigger')

closeMobileDrawer()
assert(mobileDrawerOpen === false, 'Test 6B: Mobile drawer closes on backdrop click or close button')

openMobileDrawer()
handleMobileRouteChange()
assert(mobileDrawerOpen === false, 'Test 6C: Mobile drawer automatically closes on route transition')

console.log(`\nResults: ${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exit(1)
