// One request id per paper + program, kept across retries and page reloads,
// so retrying after a lost connection can never publish the same test twice.
const remembered = new Map()

export function requestIdFor(storageKey, signature) {
  let request = remembered.get(storageKey)
  if (request?.signature !== signature) {
    let saved
    try {
      saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
    } catch {}
    request = saved?.signature === signature ? saved : { signature, id: crypto.randomUUID() }
    remembered.set(storageKey, request)
  }
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(request))
  } catch {}
  return request.id
}

export function clearRequest(storageKey) {
  remembered.delete(storageKey)
  try {
    sessionStorage.removeItem(storageKey)
  } catch {}
}
