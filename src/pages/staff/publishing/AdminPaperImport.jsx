import { useState } from 'react'
import { staffAccountService } from '../../../services/staffAccountService.js'
import ReadyPaperTransfer from '../ReadyPaperTransfer.jsx'
import { plainMessage } from './paperFormat.js'
import '../exam-library.css'

// Lets an admin add a finished paper that is still saved only in this browser.
export default function AdminPaperImport({ onAdded }) {
  const [open, setOpen] = useState(false)
  const [programs, setPrograms] = useState([])
  const [error, setError] = useState('')

  async function toggle() {
    setOpen(value => !value)
    if (open) return
    setError('')
    try {
      setPrograms(await staffAccountService.creatorSetup())
    } catch (e) {
      setError(plainMessage(e, 'Programs could not be loaded. Close this and try again.'))
    }
  }

  return (
    <div className="pub-import">
      <button type="button" className="pub-link-button" aria-expanded={open} onClick={toggle}>
        {open ? 'Close' : 'Add a ready paper from this device'}
      </button>
      {open && (error ? <p className="pub-alert" role="alert">{error}</p> : <ReadyPaperTransfer exams={programs} onAdded={onAdded} />)}
    </div>
  )
}
