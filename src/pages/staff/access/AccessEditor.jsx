import { useState } from 'react'
import { Check, GraduationCap, Plus, Search } from 'lucide-react'

const SEARCH_FROM = 7

// Teacher access, course by course: tick the batches they teach. A batch brings its course with it;
// a course on its own gives lesson/material access without batch students.
// New courses and batches are created on the server immediately, so the admin is never sent elsewhere.
export default function AccessEditor({
  courses,
  batches,
  selectedCourses,
  selectedBatches,
  onChange,
  disabled,
  programLabel,
  trackOptions = [],
  canCreateCourse,
  onCreateCourse,
  onCreateBatch,
}) {
  const [search, setSearch] = useState('')
  const [newCourse, setNewCourse] = useState(null)
  const [newBatch, setNewBatch] = useState({ course: '', name: '' })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')

  const query = courses.length >= SEARCH_FROM ? search.trim().toLowerCase() : ''
  const shown = courses.filter(course => course.name.toLowerCase().includes(query))
  const batchesOf = id => batches.filter(batch => batch.course_id === id)

  function setCourse(course, on) {
    if (on) onChange([...new Set([...selectedCourses, course.id])], selectedBatches)
    else
      onChange(
        selectedCourses.filter(id => id !== course.id),
        selectedBatches.filter(id => !batchesOf(course.id).some(batch => batch.id === id)),
      )
  }
  function setBatch(batch, on) {
    const nextBatches = on ? [...new Set([...selectedBatches, batch.id])] : selectedBatches.filter(id => id !== batch.id)
    onChange(on ? [...new Set([...selectedCourses, batch.course_id])] : selectedCourses, nextBatches)
  }
  function setAllBatches(course, on) {
    const ids = batchesOf(course.id).map(batch => batch.id)
    onChange(
      on ? [...new Set([...selectedCourses, course.id])] : selectedCourses,
      on ? [...new Set([...selectedBatches, ...ids])] : selectedBatches.filter(id => !ids.includes(id)),
    )
  }

  async function create(work) {
    if (creating) return
    setCreating(true)
    setCreateError('')
    try {
      await work()
    } catch (error) {
      setCreateError(error?.message || 'That could not be created. Please retry.')
    } finally {
      setCreating(false)
    }
  }

  function submitCourse(event) {
    event.preventDefault()
    event.stopPropagation()
    const name = newCourse.name.trim()
    if (!name) return
    create(async () => {
      const course = await onCreateCourse(name, newCourse.track)
      setNewCourse(null)
      if (course) onChange([...new Set([...selectedCourses, course])], selectedBatches)
    })
  }

  function submitBatch(event, course) {
    event.preventDefault()
    event.stopPropagation()
    const name = newBatch.name.trim()
    if (!name) return
    create(async () => {
      const batch = await onCreateBatch(course.id, name)
      setNewBatch({ course: '', name: '' })
      if (batch) onChange([...new Set([...selectedCourses, course.id])], [...new Set([...selectedBatches, batch])])
    })
  }

  const courseForm = newCourse && (
    <div className="sa-create" role="group" aria-label="New course" onKeyDown={event => event.key === 'Enter' && event.target.tagName === 'INPUT' && submitCourse(event)}>
      <label>
        Course name
        <input
          autoFocus
          required
          maxLength={120}
          value={newCourse.name}
          disabled={creating}
          placeholder="For example: Group-II Foundation 2026"
          onChange={event => setNewCourse({ ...newCourse, name: event.target.value })}
        />
      </label>
      {trackOptions.length > 0 && (
        <label>
          Program (optional)
          <select value={newCourse.track} disabled={creating} onChange={event => setNewCourse({ ...newCourse, track: event.target.value })}>
            <option value="">Not linked to a program yet</option>
            {trackOptions.map(option => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="sa-create-actions">
        <button type="button" className="sa-button sa-button-navy" disabled={creating || !newCourse.name.trim()} onClick={submitCourse}>
          {creating ? 'Creating…' : 'Create course'}
        </button>
        <button type="button" className="sa-button sa-button-light" disabled={creating} onClick={() => setNewCourse(null)}>
          Cancel
        </button>
      </div>
    </div>
  )

  return (
    <div className="sa-access">
      {createError && (
        <p className="sa-alert" role="alert">
          {createError}
        </p>
      )}
      {!courses.length ? (
        <div className="sa-access-empty">
          <span className="sa-empty-icon" aria-hidden="true">
            <GraduationCap size={24} />
          </span>
          <strong>No courses yet</strong>
          <p>Create the first course here. You can add its batches right after, then tick the ones this teacher teaches.</p>
          {canCreateCourse ? (
            courseForm || (
              <button type="button" className="sa-button sa-button-yellow" disabled={disabled} onClick={() => setNewCourse({ name: '', track: '' })}>
                <Plus size={16} aria-hidden="true" /> Create a course
              </button>
            )
          ) : (
            <p className="sa-muted">You can still create the account now and assign courses later.</p>
          )}
        </div>
      ) : (
        <>
          {courses.length >= SEARCH_FROM && (
            <label className="sa-search sa-search-small">
              <Search size={16} aria-hidden="true" />
              <span className="sa-visually-hidden">Search courses</span>
              <input type="search" placeholder="Search courses" value={search} onChange={event => setSearch(event.target.value)} />
            </label>
          )}
          <ul className="sa-courses">
            {shown.map(course => {
              const own = batchesOf(course.id)
              const on = selectedCourses.includes(course.id)
              const picked = own.filter(batch => selectedBatches.includes(batch.id))
              const program = programLabel?.(course.id)
              return (
                <li key={course.id} className={'sa-course' + (on ? ' is-on' : '')}>
                  <div className="sa-course-head">
                    <label className="sa-check">
                      <input type="checkbox" checked={on} disabled={disabled} onChange={event => setCourse(course, event.target.checked)} />
                      <span className="sa-check-box" aria-hidden="true">
                        <Check size={14} />
                      </span>
                      <span className="sa-course-name">{course.name}</span>
                    </label>
                    {program && <span className="sa-tag">{program}</span>}
                    {own.length > 1 && (
                      <button
                        type="button"
                        className="sa-text-button"
                        disabled={disabled}
                        onClick={() => setAllBatches(course, picked.length < own.length)}
                      >
                        {picked.length < own.length ? 'Select all batches' : 'Clear batches'}
                      </button>
                    )}
                  </div>
                  <div className="sa-batches" role="group" aria-label={`${course.name} batches`}>
                    {own.map(batch => {
                      const checked = selectedBatches.includes(batch.id)
                      return (
                        <label key={batch.id} className={'sa-batch' + (checked ? ' is-on' : '')}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            aria-label={`${course.name} · ${batch.name}`}
                            onChange={event => setBatch(batch, event.target.checked)}
                          />
                          {checked && <Check size={14} aria-hidden="true" />}
                          {batch.name}
                        </label>
                      )
                    })}
                    {newBatch.course === course.id ? (
                      <div className="sa-batch-form" onKeyDown={event => event.key === 'Enter' && event.target.tagName === 'INPUT' && submitBatch(event, course)}>
                        <input
                          autoFocus
                          required
                          maxLength={120}
                          aria-label={`New batch name for ${course.name}`}
                          placeholder="Batch name, e.g. Morning"
                          value={newBatch.name}
                          disabled={creating}
                          onChange={event => setNewBatch({ course: course.id, name: event.target.value })}
                        />
                        <button type="button" className="sa-button sa-button-navy sa-button-small" disabled={creating || !newBatch.name.trim()} onClick={event => submitBatch(event, course)}>
                          {creating ? 'Adding…' : 'Add'}
                        </button>
                        <button type="button" className="sa-text-button" disabled={creating} onClick={() => setNewBatch({ course: '', name: '' })}>
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="sa-batch sa-batch-add"
                        disabled={disabled}
                        aria-label={`Add a batch to ${course.name}`}
                        onClick={() => setNewBatch({ course: course.id, name: '' })}
                      >
                        <Plus size={14} aria-hidden="true" /> Add batch
                      </button>
                    )}
                  </div>
                  {on && !picked.length && (
                    <p className="sa-hint">
                      {own.length
                        ? 'Course only: lessons and materials, but no batch students or their results. Tick a batch to add them.'
                        : 'This course has no batches yet. Add one to give this teacher students.'}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          {query && !shown.length && <p className="sa-muted">No courses match “{search.trim()}”.</p>}
          {canCreateCourse &&
            (courseForm || (
              <button type="button" className="sa-button sa-button-light sa-add-course" disabled={disabled} onClick={() => setNewCourse({ name: '', track: '' })}>
                <Plus size={16} aria-hidden="true" /> New course
              </button>
            ))}
        </>
      )}
    </div>
  )
}

// What will change when the admin saves, in words: "Adds Group-II › Morning".
export function accessChanges(before, after, courses, batches) {
  const name = id => courses.find(c => c.id === id)?.name || 'Course'
  const batchName = id => {
    const batch = batches.find(b => b.id === id)
    return batch ? `${name(batch.course_id)} › ${batch.name}` : 'Batch'
  }
  const added = after.batches.filter(id => !before.batches.includes(id)).map(batchName)
  const removed = before.batches.filter(id => !after.batches.includes(id)).map(batchName)
  const courseOnly = list => list.courses.filter(id => !list.batches.some(b => batches.find(x => x.id === b)?.course_id === id))
  added.push(...courseOnly(after).filter(id => !before.courses.includes(id)).map(id => `${name(id)} (course only)`))
  removed.push(...before.courses.filter(id => !after.courses.includes(id) && !before.batches.some(b => batches.find(x => x.id === b)?.course_id === id)).map(name))
  return { added, removed }
}
