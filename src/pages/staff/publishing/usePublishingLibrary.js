import { useCallback, useEffect, useRef, useState } from 'react'
import { plainMessage } from './paperFormat.js'

const QUIET_REFRESH_GAP = 2000
const newestFirst = (a, b) => new Date(b.created_at || b.opens_at || 0) - new Date(a.created_at || a.opens_at || 0)

// Loads ready papers and published tests. The first load shows a skeleton;
// later refreshes keep what is on screen so the user's selection never jumps.
export function usePublishingLibrary(api, pausedRef) {
  const [papers, setPapers] = useState([])
  const [programTests, setProgramTests] = useState([])
  const [batchTests, setBatchTests] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [revision, setRevision] = useState(0)
  const latest = useRef(0)
  const lastStarted = useRef(0)

  const refresh = useCallback(() => setRevision(count => count + 1), [])

  useEffect(() => {
    const request = ++latest.current
    lastStarted.current = Date.now()
    setRefreshing(true)
    Promise.allSettled([api.list(), api.programDeliveries(), api.deliveries()]).then(([list, program, batch]) => {
      if (request !== latest.current) return
      if (list.status === 'fulfilled') {
        setPapers(list.value || [])
        setError('')
      } else {
        setError(plainMessage(list.reason, 'The paper library could not be loaded. Please retry.'))
      }
      if (program.status === 'fulfilled') setProgramTests(program.value || [])
      if (batch.status === 'fulfilled') setBatchTests(batch.value || [])
      const failed = [program, batch].find(result => result.status === 'rejected')
      setHistoryError(failed ? plainMessage(failed.reason, 'Published tests could not be loaded. Please retry.') : '')
      setLoading(false)
      setRefreshing(false)
    })
  }, [api, revision])

  // Coming back to the tab picks up papers a creator shared in the meantime.
  useEffect(() => {
    const quietRefresh = () => {
      if (document.visibilityState !== 'visible' || pausedRef.current) return
      if (Date.now() - lastStarted.current < QUIET_REFRESH_GAP) return
      refresh()
    }
    window.addEventListener('focus', quietRefresh)
    document.addEventListener('visibilitychange', quietRefresh)
    return () => {
      window.removeEventListener('focus', quietRefresh)
      document.removeEventListener('visibilitychange', quietRefresh)
    }
  }, [refresh, pausedRef])

  const published = [...programTests, ...batchTests].sort(newestFirst)
  return { papers, programTests, published, loading, refreshing, error, historyError, refresh }
}
