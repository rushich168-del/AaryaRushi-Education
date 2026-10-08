import { useEffect, useState } from 'react'
import { learningService } from '../../services/learningService.js'

export function useStudentLearning(userId,levelId) {
  const [state, setState] = useState({ loading: true, courses: [], error: '' })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setState({ loading: true, courses: [], error: '' })
    if (!userId) return () => { active = false }
    async function load() {
      try {
        const [courses, completions] = await Promise.all([
          levelId ? learningService.programCourses(levelId) : learningService.courses(), learningService.completions(userId),
        ])
        const completed = new Set(completions.map(row => row.lesson_id))
        const rows = await Promise.all(courses.map(async course => {
          try {
            const lessons = (await learningService.lessons(course.id)).filter(lesson => lesson.is_published)
            return { ...course, total: lessons.length, done: lessons.filter(lesson => completed.has(lesson.id)).length,
              next: lessons.find(lesson => !completed.has(lesson.id)), lessons, failed: false }
          } catch { return { ...course, failed: true } }
        }))
        if (active) setState({ loading: false, courses: rows, error: '' })
      } catch {
        if (active) setState({ loading: false, courses: [], error: 'Course progress could not be loaded.' })
      }
    }
    load()
    return () => { active = false }
  }, [userId, levelId, revision])
  return {...state, refresh:()=>setRevision(value=>value+1)}
}

export default function StudentLearningOverview({ userId }) {
  const state=useStudentLearning(userId)
  return <section aria-labelledby="student-learning-title" className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id="student-learning-title" className="text-xl font-bold text-blue-900">My learning</h3>
      <a href="/dashboard/student/courses" className="font-semibold text-blue-700 underline">All my courses</a>
    </div>
    {state.loading ? <p role="status">Loading course progress…</p> : state.error ? <p role="alert">{state.error}</p> : <>
      {!state.courses.length && <p className="rounded-xl border bg-white p-5 text-slate-600">No courses assigned yet. Your institute will enroll you into a batch.</p>}
      <div className="grid gap-4 lg:grid-cols-2">{state.courses.map(course => {
        const href = `/dashboard/student/courses?course=${encodeURIComponent(course.id)}`
        return <article key={course.id} className="min-w-0 space-y-3 rounded-xl border border-slate-200 bg-white p-5">
          <h4 className="break-words text-lg font-bold">{course.name}</h4>
          {course.failed ? <p role="alert">Progress unavailable for this course.</p> : course.total ? <>
            <p>{course.done} of {course.total} published lessons completed</p>
            <progress className="w-full" aria-label={`${course.name} lesson completion`} value={course.done} max={course.total} />
          </> : <p className="text-slate-600">Your teacher has not published lessons yet.</p>}
          <a className="inline-block rounded-lg bg-blue-700 px-4 py-2 font-semibold text-white" href={course.next ? `${href}&lesson=${encodeURIComponent(course.next.id)}` : href}>
            {course.next ? `Continue learning: ${course.next.title}` : course.total && !course.failed ? 'Review course' : 'Open course'}
          </a>
        </article>
      })}</div>
      {!!state.courses.length && <p className="text-sm text-slate-500">Progress reflects lessons you marked complete, not test performance.</p>}
    </>}
    {!state.loading && <button type="button" onClick={state.refresh} className="font-semibold text-blue-700 underline">Refresh course progress</button>}
  </section>
}

