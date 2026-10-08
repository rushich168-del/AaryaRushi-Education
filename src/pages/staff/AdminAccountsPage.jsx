import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, BookOpen, Check, Copy, Eye, EyeOff, GraduationCap, KeyRound, PenLine, RefreshCw, Search, ShieldCheck, UserPlus, Users, X } from 'lucide-react'
import StaffWorkspace from './StaffWorkspace.jsx'
import RowMenu from './RowMenu.jsx'
import AccessEditor, { accessChanges } from './access/AccessEditor.jsx'
import { keepTabInside } from './dialogFocus.js'
import { staffAccountService as service, temporaryPassword } from '../../services/staffAccountService.js'
import { learningService } from '../../services/learningService.js'
import { programService } from '../../services/programService.js'
import { studentProgramService } from '../../services/studentProgramService.js'
import { passwordChecks, passwordError, staffAccountErrors } from '../../../supabase/functions/edu-staff-accounts/validation.mjs'
import './access/staff-access.css'
import brand from '../../config/brand.js'

const toggle = (array, id) => (array.includes(id) ? array.filter(x => x !== id) : [...array, id])
const initials = name =>
  String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(word => word[0])
    .join('')
    .toUpperCase()
const ROLE = { teacher: 'Teacher', creator: 'Test Creator', admin: 'Administrator' }

function statusOf(person) {
  if (person.state === 'suspended') return { label: 'Suspended', tone: 'off' }
  if (person.state === 'pending') return { label: 'Waiting to activate', tone: 'warn' }
  if (person.password_change_required) return { label: 'Must set own password', tone: 'warn' }
  return { label: 'Active', tone: 'ok' }
}
const needsAttention = person =>
  person.role !== 'admin' &&
  (statusOf(person).tone !== 'ok' || (person.role === 'teacher' && !person.batches?.length) || (person.role === 'creator' && !person.exams?.length))

// The Staff & access drawer: one place to add staff, change their access, or issue a password.
function Drawer({ title, subtitle, busy, onClose, children }) {
  const dialog = useRef(null)
  useEffect(() => {
    const node = dialog.current
    node.showModal()
    return () => node.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      className="sa-drawer"
      aria-labelledby="sa-drawer-title"
      onKeyDown={event => {
        if (event.key === 'Escape' && busy) event.preventDefault()
        keepTabInside(event, dialog.current)
      }}
      onCancel={event => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <header className="sa-drawer-head">
        <div>
          <h3 id="sa-drawer-title">{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button type="button" className="sa-icon-button" aria-label="Close" disabled={busy} onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      {children}
    </dialog>
  )
}

function Step({ number, title, children, hint }) {
  return (
    <section className="sa-step">
      <h4>
        {number && (
          <span className="sa-step-number" aria-hidden="true">
            {number}
          </span>
        )}
        {title}
      </h4>
      {hint && <p className="sa-muted sa-step-hint">{hint}</p>}
      {children}
    </section>
  )
}

function AccessSummary({ person, courses, batches }) {
  if (person.role === 'admin') return <p className="sa-access-line sa-muted">Full access to every course, batch and tool.</p>
  if (person.role === 'creator') {
    return person.exams?.length ? (
      <div className="sa-chips" aria-label="Assigned programs">
        {person.examNames.map(name => (
          <span className="sa-chip" key={name}>
            {name}
          </span>
        ))}
      </div>
    ) : (
      <p className="sa-access-line sa-warn-text">
        <AlertTriangle size={15} aria-hidden="true" /> No program assigned yet
      </p>
    )
  }
  const groups = person.courses
    .map(id => ({ course: courses.find(c => c.id === id), batches: batches.filter(b => b.course_id === id && person.batches.includes(b.id)) }))
    .filter(group => group.course)
  if (!person.batches.length && !groups.length)
    return (
      <p className="sa-access-line sa-warn-text">
        <AlertTriangle size={15} aria-hidden="true" /> Not teaching any batch yet
      </p>
    )
  return (
    <div className="sa-chips" aria-label="Teaches">
      {groups.map(({ course, batches: own }) => (
        <span className="sa-chip" key={course.id}>
          <strong>{course.name}</strong>
          {own.length ? ' › ' + own.map(b => b.name).join(', ') : ' · course only'}
        </span>
      ))}
    </div>
  )
}

export default function AdminAccountsPage() {
  const [accountType, setAccountType] = useState('teacher'),
    [exams, setExams] = useState([]),
    [selectedExams, setSelectedExams] = useState([]),
    [creatorSetupError, setCreatorSetupError] = useState('')
  const [people, setPeople] = useState([]),
    [courses, setCourses] = useState([]),
    [batches, setBatches] = useState([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all')
  const [institutes, setInstitutes] = useState([]),
    [links, setLinks] = useState([]),
    [programs, setPrograms] = useState([])
  const [form, setForm] = useState(null),
    [name, setName] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [selectedCourses, setCoursesSelected] = useState([]),
    [selectedBatches, setBatchesSelected] = useState([])
  const [busy, setBusy] = useState(false),
    [credential, setCredential] = useState(null),
    [showPassword, setShowPassword] = useState(false),
    [formError, setFormError] = useState(''),
    [copied, setCopied] = useState(false)
  const lock = useRef(false),
    request = useRef(''),
    createRequests = useRef(new Map()),
    credentialCard = useRef(null)
  const [fieldErrors, setFieldErrors] = useState({})
  function clearField(field) {
    setFieldErrors(previous => ({ ...previous, [field]: '' }))
    setFormError('')
  }

  async function loadCourses() {
    const c = await learningService.courses()
    const bs = (await Promise.all(c.map(course => learningService.batches(course.id)))).flat()
    setCourses(c)
    setBatches(bs)
    return { courses: c, batches: bs }
  }
  async function load() {
    setLoading(true)
    setError('')
    try {
      const [p] = await Promise.all([service.list(), loadCourses()])
      setPeople(p)
      try {
        setExams(await service.creatorSetup())
        setCreatorSetupError('')
      } catch (e) {
        setExams([])
        setCreatorSetupError(e.code === 'STAFF_SETUP_REQUIRED' ? 'Test Creator accounts need the creator permission update. Teacher accounts are available.' : e.message)
      }
      // Extras for creating courses inline and labelling them; the page works without them.
      const [inst, tracks, catalogue] = await Promise.allSettled([learningService.institutes(), programService.courseTracks(), studentProgramService.catalogue()])
      setInstitutes(inst.status === 'fulfilled' ? inst.value || [] : [])
      setLinks(tracks.status === 'fulfilled' ? tracks.value || [] : [])
      setPrograms(catalogue.status === 'fulfilled' ? catalogue.value?.programs || [] : [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    load()
  }, [])
  useEffect(() => {
    if (credential) credentialCard.current?.scrollIntoView({ block: 'nearest' })
  }, [credential])

  function start(kind, person, type = 'teacher') {
    setAccountType(person?.role || type)
    setSelectedExams(person?.exams || [])
    createRequests.current = new Map()
    setForm({ kind, person, before: { courses: person?.courses || [], batches: person?.batches || [], exams: person?.exams || [] } })
    setFormError('')
    setFieldErrors({})
    setError('')
    setNotice('')
    setName(person?.name || '')
    setEmail(person?.email || '')
    setPassword(['create', 'password'].includes(kind) ? temporaryPassword() : '')
    setShowPassword(false)
    setCoursesSelected(person?.courses || [])
    setBatchesSelected(person?.batches || [])
    request.current = crypto.randomUUID()
    setCredential(null)
  }
  function close() {
    if (busy) return
    setForm(null)
    setPassword('')
    setFormError('')
  }
  async function work(fn, message) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setFormError('')
    setNotice('')
    try {
      const outcome = await fn()
      setNotice(outcome || message)
      await load()
    } catch (e) {
      if (form) {
        setFormError(e.message)
        setFieldErrors(e.fieldErrors || {})
      } else setError(e.message)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  async function submit(e) {
    e.preventDefault()
    const validation =
      form.kind === 'create'
        ? staffAccountErrors({ request_id: request.current, name, email, password, role: accountType, exams: selectedExams, courses: selectedCourses, batches: selectedBatches })
        : form.kind === 'password' && passwordError(password)
          ? { password: passwordError(password) }
          : form.kind === 'existing' && accountType === 'creator' && !selectedExams.length
            ? { assignments: 'Select at least one exam for this Test Creator.' }
            : {}
    setFieldErrors(validation)
    setFormError('')
    if (Object.keys(validation).length) {
      setFormError('Please correct the highlighted details.')
      return
    }
    await work(
      async () => {
        if (form.kind === 'create') {
          // Bind retries to the actual account intent, never to the password or checkbox order.
          // Keep earlier keys so reverting an edit can resume an unfinished operation safely.
          const details = { name: name.trim(), email: email.trim().toLowerCase(), role: accountType, exams: [...selectedExams].sort(), courses: [...selectedCourses].sort(), batches: [...selectedBatches].sort() }
          const intent = JSON.stringify(details)
          if (!createRequests.current.has(intent)) createRequests.current.set(intent, crypto.randomUUID())
          request.current = createRequests.current.get(intent)
          const result = await service.action({ action: 'create', request_id: request.current, ...details, password })
          if (!result.repeated) setCredential({ email, password, role: accountType, name: details.name })
          setPassword('')
          setShowPassword(false)
          setForm(null)
          if (result.repeated) return 'This staff account was already created. If you no longer have the original password, issue a new temporary password below.'
        } else if (form.kind === 'password') {
          await service.action({ action: 'temporary_password', user_id: form.person.id, version: form.person.version, password })
          setCredential({ email, password, role: accountType, name: form.person.name })
          setPassword('')
          setShowPassword(false)
          setForm(null)
        } else if (form.kind === 'existing') {
          await service.grantExisting(email, name, selectedCourses, selectedBatches, accountType, selectedExams)
          setForm(null)
        } else {
          await (accountType === 'creator' ? service.creatorAssignments(form.person, selectedExams) : service.assignments(form.person, selectedCourses, selectedBatches))
          setForm(null)
        }
      },
      form.kind === 'assign'
        ? 'Assignments saved.'
        : form.kind === 'password'
          ? 'New temporary password issued.'
          : form.kind === 'existing'
            ? 'Staff access granted. Existing password and student records are preserved.'
            : accountType === 'creator'
              ? 'Test Creator account created.'
              : 'Teacher account created.',
    )
  }

  async function createCourse(courseName, levelId) {
    const institute = institutes[0]?.id
    if (!institute) throw new Error('Course creation needs institute staff membership. Complete staff setup first.')
    const id = await learningService.createCourse(institute, courseName, '')
    let linkFailed = false
    if (levelId) {
      try {
        await programService.linkCourse(id, levelId)
        setLinks(list => [...list, { course_id: id, level_id: levelId }])
      } catch {
        linkFailed = true
      }
    }
    await loadCourses()
    setNotice(`Course “${courseName}” created.` + (linkFailed ? ' Linking it to the program did not finish; link it in Programs & tests.' : ''))
    return id
  }
  async function createBatch(courseId, batchName) {
    const id = await learningService.createBatch(courseId, batchName)
    const { batches: fresh } = await loadCourses()
    setNotice(`Batch “${batchName}” added.`)
    return id || fresh.find(b => b.course_id === courseId && b.name === batchName)?.id
  }

  const trackOptions = programs.flatMap(program =>
    (program.tracks || []).map(track => ({ id: track.id, label: program.tracks.length > 1 ? `${program.name} · ${track.name}` : program.name })),
  )
  const programLabel = courseId => {
    const link = links.find(l => l.course_id === courseId)
    return link && trackOptions.find(option => option.id === link.level_id)?.label
  }

  const examName = id => exams.find(exam => exam.id === id)?.name
  const enriched = people.map(person => ({ ...person, courses: person.courses || [], batches: person.batches || [], examNames: (person.exams || []).map(examName).filter(Boolean) }))
  const staff = enriched.filter(p => p.role !== 'admin')
  const coveredBatches = new Set(enriched.filter(p => p.role === 'teacher' && p.state === 'active').flatMap(p => p.batches))
  const uncovered = batches.filter(b => !coveredBatches.has(b.id)).length
  const counts = {
    all: enriched.length,
    teacher: enriched.filter(p => p.role === 'teacher').length,
    creator: enriched.filter(p => p.role === 'creator').length,
    attention: enriched.filter(needsAttention).length,
  }
  const visible = enriched
    .filter(p => filter === 'all' || (filter === 'attention' ? needsAttention(p) : p.role === filter))
    .filter(p => (p.name + ' ' + p.email).toLowerCase().includes(search.toLowerCase()))

  const isTeacherForm = form && form.kind !== 'password' && accountType === 'teacher'
  const isCreatorForm = form && form.kind !== 'password' && accountType === 'creator'
  const changes =
    form?.kind === 'assign' && accountType === 'teacher' ? accessChanges(form.before, { courses: selectedCourses, batches: selectedBatches }, courses, batches) : null
  const creatorChanged = form?.kind === 'assign' && accountType === 'creator' && JSON.stringify([...selectedExams].sort()) !== JSON.stringify([...form.before.exams].sort())
  const unchanged = form?.kind === 'assign' && (changes ? !changes.added.length && !changes.removed.length : !creatorChanged)
  const loginUrl = role => window.location.origin + (role === 'creator' ? '/testcreator/login' : '/teacher/login')

  const drawerTitle = !form
    ? ''
    : form.kind === 'create'
      ? accountType === 'creator'
        ? 'Add a Test Creator'
        : 'Add a teacher'
      : form.kind === 'existing'
        ? 'Grant access to an existing account'
        : form.kind === 'password'
          ? 'Issue a new temporary password'
          : accountType === 'creator'
            ? 'Edit creator exam access'
            : 'Edit teacher assignments'
  const drawerSubtitle = !form
    ? ''
    : ['assign', 'password'].includes(form.kind)
      ? `${form.person.name} · ${form.person.email}`
      : accountType === 'creator'
        ? 'Test Creators prepare papers for assigned exams. They cannot publish tests or use teacher tools.'
        : 'Teachers publish tests to assigned courses and batches.'

  const passwordFields = (
    <>
      <label className="sa-field">
        Temporary password
        <span className="sa-password">
          <input
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            maxLength={128}
            required
            value={password}
            disabled={busy}
            aria-invalid={!!fieldErrors.password}
            aria-describedby="teacher-password-help"
            onChange={e => {
              setPassword(e.target.value)
              clearField('password')
            }}
          />
          <button type="button" className="sa-icon-button" disabled={busy} aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(x => !x)}>
            {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </button>
        </span>
      </label>
      {fieldErrors.password && <p className="sa-field-error">{fieldErrors.password}</p>}
      <div className="sa-row">
        <button
          type="button"
          disabled={busy}
          className="sa-text-button"
          onClick={() => {
            setPassword(temporaryPassword())
            clearField('password')
          }}
        >
          <RefreshCw size={15} aria-hidden="true" /> Generate password
        </button>
      </div>
      <div id="teacher-password-help">
        <ul aria-label="Password requirements" className="sa-checks">
          {passwordChecks(password).map(check => (
            <li key={check.id} className={check.valid ? 'is-met' : ''}>
              <span aria-hidden="true">{check.valid ? '✓' : '○'}</span> {check.label}
              <span className="sa-visually-hidden"> — {check.valid ? 'met' : 'not met'}</span>
            </li>
          ))}
        </ul>
        <p className="sa-muted">They choose their own password the first time they sign in. Only use an email address verified by your institute.</p>
      </div>
    </>
  )

  return (
    <StaffWorkspace role="admin">
      <div className="staff-access">
        <header className="sa-header">
          <div>
            <p className="sa-eyebrow">YOUR TEAM. CLEAR RESPONSIBILITIES.</p>
            <h2>Staff & access</h2>
            <p className="sa-lead">Add teachers and Test Creators, then choose exactly which courses, batches or programs each one works with.</p>
          </div>
          <div className="sa-header-actions">
            <button className="sa-button sa-button-yellow" disabled={busy} onClick={() => start('create')}>
              <UserPlus size={18} aria-hidden="true" /> Add teacher
            </button>
            <button className="sa-button sa-button-outline" disabled={busy || loading || !!creatorSetupError} onClick={() => start('create', null, 'creator')}>
              <PenLine size={18} aria-hidden="true" /> Add Test Creator
            </button>
          </div>
        </header>
        <button type="button" className="sa-text-button sa-existing" disabled={busy} onClick={() => start('existing')}>
          Already has an account? Grant existing account access
        </button>

        {creatorSetupError && (
          <p role="status" className="sa-banner">
            {creatorSetupError}{' '}
            <button className="sa-text-button" disabled={busy} onClick={load}>
              Check setup again
            </button>
          </p>
        )}
        {error && (
          <div role="alert" className="sa-alert">
            {error}{' '}
            <button className="sa-text-button" onClick={load}>
              Retry
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="sa-notice">
            <Check size={18} aria-hidden="true" /> {notice}
          </p>
        )}

        {credential && (
          <section ref={credentialCard} className="sa-credential" aria-labelledby="sa-credential-title">
            <span className="sa-credential-icon" aria-hidden="true">
              <KeyRound size={22} />
            </span>
            <div>
              <h3 id="sa-credential-title">Share these details privately with the staff member</h3>
              <p className="sa-cred-line">Login: {loginUrl(credential.role)}</p>
              <p className="sa-cred-line">Email: {credential.email}</p>
              <label className="sa-field">
                Temporary password
                <span className="sa-password">
                  <input type={showPassword ? 'text' : 'password'} readOnly value={credential.password} autoComplete="off" />
                  <button type="button" className="sa-icon-button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(x => !x)}>
                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                </span>
              </label>
              <div className="sa-row">
                <button
                  type="button"
                  className="sa-button sa-button-light"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(`${brand.name} staff sign-in\n${loginUrl(credential.role)}\nEmail: ${credential.email}\nTemporary password: ${credential.password}`)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2500)
                    } catch {}
                  }}
                >
                  <Copy size={16} aria-hidden="true" /> {copied ? 'Copied' : 'Copy all details'}
                </button>
                <button
                  className="sa-button sa-button-navy"
                  onClick={() => {
                    setCredential(null)
                    setShowPassword(false)
                  }}
                >
                  Done — clear password
                </button>
              </div>
              <p className="sa-muted">Expires in 24 hours. This password cannot be retrieved after you clear this screen. No message has been sent.</p>
            </div>
          </section>
        )}

        {!loading && (
          <div className="sa-stats">
            <div className="sa-stat">
              <span className="sa-stat-icon" aria-hidden="true">
                <GraduationCap size={20} />
              </span>
              <div>
                <strong>{counts.teacher}</strong>
                <span>Teachers</span>
              </div>
            </div>
            <div className="sa-stat">
              <span className="sa-stat-icon" aria-hidden="true">
                <PenLine size={20} />
              </span>
              <div>
                <strong>{counts.creator}</strong>
                <span>Test Creators</span>
              </div>
            </div>
            <div className="sa-stat">
              <span className="sa-stat-icon" aria-hidden="true">
                <BookOpen size={20} />
              </span>
              <div>
                <strong>
                  {courses.length} <small>/ {batches.length}</small>
                </strong>
                <span>Courses / batches</span>
              </div>
            </div>
            <div className={'sa-stat' + (uncovered ? ' is-warn' : '')}>
              <span className="sa-stat-icon" aria-hidden="true">
                {uncovered ? <AlertTriangle size={20} /> : <ShieldCheck size={20} />}
              </span>
              <div>
                <strong>{uncovered}</strong>
                <span>{uncovered === 1 ? 'Batch without a teacher' : 'Batches without a teacher'}</span>
              </div>
            </div>
          </div>
        )}

        <section className="sa-team" aria-label="Team members">
          <div className="sa-toolbar">
            <div className="sa-filters" role="group" aria-label="Filter team">
              {[
                ['all', 'Everyone'],
                ['teacher', 'Teachers'],
                ['creator', 'Test Creators'],
                ['attention', 'Needs attention'],
              ].map(([key, label]) => (
                <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {label} <span>{counts[key]}</span>
                </button>
              ))}
            </div>
            <label className="sa-search">
              <Search size={18} aria-hidden="true" />
              <span className="sa-visually-hidden">Find a team member</span>
              <input placeholder="Search name or email" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
          </div>
          {loading ? (
            <div className="sa-skeleton" role="status" aria-label="Loading team">
              <span />
              <span />
              <span />
            </div>
          ) : visible.length ? (
            <ul className="sa-people">
              {visible.map(person => {
                const status = statusOf(person)
                const manageable = ['teacher', 'creator'].includes(person.role)
                const missing = (person.role === 'teacher' && !person.batches.length) || (person.role === 'creator' && !person.exams?.length)
                return (
                  <li className={'sa-person' + (person.state === 'suspended' ? ' is-off' : '')} key={person.id}>
                    <span className={'sa-avatar is-' + person.role} aria-hidden="true">
                      {initials(person.name)}
                    </span>
                    <div className="sa-person-main">
                      <h3>
                        {person.name} <span className={'sa-role is-' + person.role}>{ROLE[person.role] || 'Staff'}</span>
                        <span className={'sa-status is-' + status.tone}>{status.label}</span>
                      </h3>
                      <p className="sa-email">{person.email}</p>
                      <AccessSummary person={person} courses={courses} batches={batches} />
                    </div>
                    {manageable && (
                      <div className="sa-person-actions">
                        <button
                          disabled={busy}
                          className={'sa-button ' + (missing && person.state !== 'suspended' ? 'sa-button-yellow' : 'sa-button-outline')}
                          aria-label={`Edit access for ${person.name}`}
                          onClick={() => start('assign', person)}
                        >
                          {missing ? (person.role === 'creator' ? 'Assign programs' : 'Assign course & batch') : 'Edit access'}
                        </button>
                        <RowMenu
                          prefix="sa"
                          label={`More actions for ${person.name}`}
                          disabled={busy}
                          items={[
                            person.state === 'active' && { label: 'New temporary password', onSelect: () => start('password', person) },
                            {
                              label: person.state === 'active' ? 'Suspend access' : person.state === 'pending' ? 'Activate' : 'Restore access',
                              danger: person.state === 'active',
                              onSelect: () => {
                                setForm(null)
                                work(
                                  () => service.state(person, person.state === 'active' ? 'suspended' : 'active'),
                                  person.state === 'active' ? 'Staff access suspended.' : 'Staff access activated.',
                                )
                              },
                            },
                          ].filter(Boolean)}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : staff.length || search || filter !== 'all' ? (
            <p className="sa-empty-line">No team members match this view.</p>
          ) : (
            <div className="sa-empty">
              <span className="sa-empty-icon" aria-hidden="true">
                <Users size={26} />
              </span>
              <h3>Add your first teacher</h3>
              <p>Create their account, choose the courses and batches they teach, and share the sign-in details privately.</p>
              <button className="sa-button sa-button-yellow" disabled={busy} onClick={() => start('create')}>
                <UserPlus size={18} aria-hidden="true" /> Add your first teacher
              </button>
            </div>
          )}
        </section>
        <p className="sa-muted sa-footnote">Admin, teacher and student can stay signed in independently in separate browser tabs. Each portal displays its own signed-in account.</p>

        {form && (
          <Drawer title={drawerTitle} subtitle={drawerSubtitle} busy={busy} onClose={close}>
            <form className="sa-form" onSubmit={submit}>
              <div className="sa-drawer-body">
                {form.kind === 'existing' && (
                  <label className="sa-field">
                    Staff role
                    <select
                      disabled={busy}
                      value={accountType}
                      onChange={e => {
                        setAccountType(e.target.value)
                        setCoursesSelected([])
                        setBatchesSelected([])
                        setSelectedExams([])
                        setFormError('')
                      }}
                    >
                      <option value="teacher">Teacher</option>
                      <option value="creator" disabled={!!creatorSetupError}>
                        Test Creator
                      </option>
                    </select>
                  </label>
                )}
                {['create', 'existing'].includes(form.kind) && (
                  <Step number="1" title="Who are they?">
                    <label className="sa-field">
                      Full name
                      <input
                        required
                        maxLength={120}
                        value={name}
                        disabled={busy}
                        aria-invalid={!!fieldErrors.name}
                        aria-describedby={fieldErrors.name ? 'teacher-name-error' : undefined}
                        onChange={e => {
                          setName(e.target.value)
                          clearField('name')
                        }}
                      />
                    </label>
                    {fieldErrors.name && (
                      <p id="teacher-name-error" className="sa-field-error">
                        {fieldErrors.name}
                      </p>
                    )}
                    <label className="sa-field">
                      Email address
                      <input
                        type="email"
                        required
                        maxLength={254}
                        value={email}
                        disabled={busy}
                        aria-invalid={!!fieldErrors.email}
                        aria-describedby={fieldErrors.email ? 'teacher-email-error' : undefined}
                        onChange={e => {
                          setEmail(e.target.value)
                          clearField('email')
                        }}
                      />
                    </label>
                    {fieldErrors.email && (
                      <p id="teacher-email-error" className="sa-field-error">
                        {fieldErrors.email}
                      </p>
                    )}
                  </Step>
                )}
                {form.kind === 'create' && (
                  <Step number="2" title="Sign-in" hint="A strong temporary password is ready. Keep it or type your own.">
                    {passwordFields}
                  </Step>
                )}
                {form.kind === 'password' && passwordFields}

                {isCreatorForm && (
                  <Step
                    number={form.kind === 'create' ? '3' : form.kind === 'existing' ? '2' : null}
                    title="Programs they prepare papers for"
                    hint={form.kind === 'assign' ? 'Remove all exams to revoke exam access.' : 'Select at least one exam.'}
                  >
                    <fieldset disabled={busy} className="sa-plain">
                      <legend className="sa-visually-hidden">Assigned exams</legend>
                      <div className="sa-exams">
                        {exams.map(exam => (
                          <label key={exam.id} className={'sa-batch' + (selectedExams.includes(exam.id) ? ' is-on' : '')}>
                            <input
                              type="checkbox"
                              checked={selectedExams.includes(exam.id)}
                              onChange={() => {
                                setSelectedExams(toggle(selectedExams, exam.id))
                                clearField('assignments')
                              }}
                            />
                            {selectedExams.includes(exam.id) && <Check size={14} aria-hidden="true" />}
                            {exam.name}
                          </label>
                        ))}
                        {!exams.length && <p className="sa-muted">Add an exam in Programs & tests before creating a Test Creator.</p>}
                      </div>
                    </fieldset>
                  </Step>
                )}
                {fieldErrors.assignments && <p className="sa-field-error">{fieldErrors.assignments}</p>}

                {isTeacherForm && (
                  <Step
                    number={form.kind === 'create' ? '3' : form.kind === 'existing' ? '2' : null}
                    title="Courses & batches they teach"
                    hint={
                      form.kind === 'create'
                        ? 'Optional now: you can assign courses and batches later.'
                        : 'Tick the batches this teacher teaches. They see those students, their results, and the course lessons.'
                    }
                  >
                    <AccessEditor
                      courses={courses}
                      batches={batches}
                      selectedCourses={selectedCourses}
                      selectedBatches={selectedBatches}
                      onChange={(c, b) => {
                        setCoursesSelected(c)
                        setBatchesSelected(b)
                        clearField('assignments')
                      }}
                      disabled={busy}
                      programLabel={programLabel}
                      trackOptions={trackOptions}
                      canCreateCourse={institutes.length > 0}
                      onCreateCourse={createCourse}
                      onCreateBatch={createBatch}
                    />
                  </Step>
                )}
                {formError && (
                  <p role="alert" className="sa-alert">
                    {formError}
                  </p>
                )}
              </div>
              <footer className="sa-drawer-foot">
                {changes && (changes.added.length > 0 || changes.removed.length > 0) && (
                  <div className="sa-changes" aria-label="Changes to save">
                    {changes.added.map(item => (
                      <span key={'+' + item} className="sa-change is-add">
                        + {item}
                      </span>
                    ))}
                    {changes.removed.map(item => (
                      <span key={'-' + item} className="sa-change is-remove">
                        − {item}
                      </span>
                    ))}
                  </div>
                )}
                <div className="sa-row sa-foot-actions">
                  <button type="button" disabled={busy} className="sa-button sa-button-light" onClick={close}>
                    Cancel
                  </button>
                  <button disabled={busy || unchanged} className="sa-button sa-button-navy">
                    {busy
                      ? 'Saving…'
                      : form.kind === 'assign'
                        ? unchanged
                          ? 'No changes yet'
                          : 'Save assignments'
                        : form.kind === 'password'
                          ? 'Issue temporary password'
                          : form.kind === 'existing'
                            ? accountType === 'creator'
                              ? 'Grant Test Creator access'
                              : 'Grant teacher access'
                            : accountType === 'creator'
                              ? 'Create Test Creator account'
                              : 'Create teacher account'}
                  </button>
                </div>
              </footer>
            </form>
          </Drawer>
        )}
      </div>
    </StaffWorkspace>
  )
}
