import { supabase } from '../lib/supabaseClient.js'

export const resultValue = value => value == null ? 'Unavailable' : value
export const resultPercent = (value, total) => value == null || total == null || total <= 0
  ? 'Unavailable' : `${((value / total) * 100).toFixed(1)}%`
export const attemptedCount = attempt => attempt.correct_count == null || attempt.incorrect_count == null
  ? null : Number(attempt.correct_count) + Number(attempt.incorrect_count)

export const resultService = {
  // Trigger cleanup of any expired attempts securely.
  async triggerExpiredFinalization() {
    try {
      await supabase.rpc('finalize_expired_attempts')
    } catch (e) {
      console.warn("Failed to run expired finalization sweep", e)
    }
  },

  async getStudentAttempt(attemptId) {
    const { data, error } = await supabase
      .from('test_attempts')
      .select('*, tests(name, duration_minutes, review_policy, snapshot_contract_version, exam_name)')
      .eq('id', attemptId)
      .single()
      
    if (error) throw error
    return { ...data, tests: data.tests && { ...data.tests, exams: { name: data.tests.exam_name ?? 'Historical label unavailable' } } }
  },

  async getSectionPerformance(attemptId) {
    const { data, error } = await supabase.rpc('get_attempt_section_performance', { p_attempt_id: attemptId })
    if (error) throw error
    return data
  },

  async getAttemptReview(attemptId) {
    const { data, error } = await supabase.rpc('get_attempt_review', { p_attempt_id: attemptId })
    if (error) throw error
    
    // In order to show option text, we need the option snapshots
    // Since get_attempt_review only returns option IDs, we fetch the options mapping
    // But since this runs only if allowed, we can securely query test_option_snapshots.
    // However, we need testId first.
    return data
  },

  async getTestOptionSnapshots(testId) {
    const { data, error } = await supabase
      .from('test_option_snapshots')
      .select('*')
      .eq('test_id', testId)
      
    if (error) throw error
    return data
  },

  async getTeacherResults(testId = null, context = {}) {
    const { data: isTeacher, error: roleError } = await supabase.rpc('is_teacher')
    if (roleError) throw roleError
    if (isTeacher !== true) throw new Error('Unauthorized to view teacher results')
    let query = supabase
      .from('test_attempts')
      .select('*, student_profiles(full_name), tests(name, exam_name, review_policy, snapshot_contract_version)')
      .neq('status', 'IN_PROGRESS') // Only finalized
      .order('submitted_at', { ascending: false })

    if (testId) {
      query = query.eq('test_id', testId)
    }

    const { data, error } = await query
    if (error) throw error
    let allowed = null
    if(context.exam_id || context.level_id){
      let tests = supabase.from('tests').select('id')
      if(context.exam_id)tests=tests.eq('exam_id',context.exam_id)
      if(context.level_id)tests=tests.eq('level_id',context.level_id)
      const result=await tests
      if(result.error)throw result.error
      allowed=new Set(result.data.map(t=>t.id))
    }
    return data.filter(a=>!allowed||allowed.has(a.test_id)).map(attempt => ({ ...attempt, tests: attempt.tests && { ...attempt.tests, exams: { name: attempt.tests.exam_name ?? 'Historical label unavailable' } } }))
  },

  // These are display gates only; RLS and the review RPC remain authoritative.
  async getResultDetails(attempt, { teacher = false } = {}) {
    if (!['SUBMITTED', 'EXPIRED'].includes(attempt.status)) throw new Error('Attempt is not finalized yet')
    const verified = attempt.tests?.snapshot_contract_version === 1
    const released = attempt.tests?.review_policy === 'AFTER_SUBMISSION'
    const sections = verified && (teacher || released) ? await this.getSectionPerformance(attempt.id) : []
    const review = teacher || released ? await this.getAttemptReview(attempt.id) : []
    const options = review.length ? await this.getTestOptionSnapshots(attempt.test_id) : []
    return { sections, review, options }
  }
}
