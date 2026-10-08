import { supabase } from '../lib/supabaseClient.js'

// Keep the existing screen data shape while reading historical labels from publication.
const frozenTest = test => test && ({ ...test, exams: { name: test.exam_name ?? 'Historical label unavailable' } })

export const studentExamService = {
  async getAvailableTests() {
    const { data, error } = await supabase
      .from('tests')
      .select('*')
      .eq('is_published', true)
      .eq('snapshot_contract_version', 1)
      .order('created_at', { ascending: false })
      
    if (error) throw error
    return data.map(frozenTest)
  },

  // Question totals for the available-test cards. A failed count only hides that label.
  async getQuestionCounts(testIds) {
    const counts = await Promise.all(testIds.map(async id => {
      try {
        const { count, error } = await supabase.from('test_question_snapshots').select('question_id', { count: 'exact', head: true }).eq('test_id', id)
        return [id, error ? null : count]
      } catch { return [id, null] }
    }))
    return Object.fromEntries(counts.filter(([, count]) => Number.isInteger(count)))
  },

  async getMyAttempts() {
    const { data, error } = await supabase
      .from('test_attempts')
      .select('*, tests(*)')
      .order('started_at', { ascending: false })
      
    if (error) throw error
    return data.map(attempt => ({ ...attempt, tests: frozenTest(attempt.tests) }))
  },

  async getTestDetails(testId) {
    const { data, error } = await supabase
      .from('tests')
      .select('*')
      .eq('id', testId)
      .single()
      
    if (error) throw error
    const questions = await this.getAttemptQuestions(testId)
    const sections = new Map()
    for (const q of questions) {
      const section = sections.get(q.section_id) || {
        id: q.section_id, section_name: q.section_name ?? 'Historical label unavailable',
        display_order: q.section_order, marks_per_question: q.marks,
        negative_marks: q.negative_marks, question_count: 0
      }
      section.question_count += 1
      sections.set(q.section_id, section)
    }
    return { ...frozenTest(data), exam_patterns: {
      name: data.pattern_name, exam_pattern_sections: [...sections.values()]
    } }
  },

  async startAttempt(testId) {
    const { data, error } = await supabase.rpc('start_test_attempt', { p_test_id: testId })
    if (error) throw error
    return data // returns the attempt UUID
  },

  async getAttempt(attemptId) {
    const { data, error } = await supabase
      .from('test_attempts')
      .select('*, tests(*)')
      .eq('id', attemptId)
      .single()
      
    if (error) throw error
    return { ...data, tests: frozenTest(data.tests) }
  },

  async getAttemptQuestions(testId) {
    // Section labels and ordering come from the frozen snapshot, not live pattern rows.
    const { data, error } = await supabase
      .from('test_question_snapshots')
      .select('*')
      .eq('test_id', testId)
      .order('section_order', { ascending: true })
      .order('sort_order', { ascending: true })
      .order('question_id', { ascending: true })
      
    if (error) throw error
    return data.map(q => ({ ...q, exam_pattern_sections: { section_name: q.section_name ?? 'Historical label unavailable' } }))
  },

  async getAttemptOptions(testId) {
    const { data, error } = await supabase
      .from('test_option_snapshots')
      .select('*')
      .eq('test_id', testId)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      
    if (error) throw error
    return data
  },

  async getMyAnswers(attemptId) {
    const { data, error } = await supabase
      .from('attempt_answers')
      .select('*')
      .eq('attempt_id', attemptId)
      
    if (error) throw error
    return data
  },

  async saveAnswer(attemptId, questionId, optionId, isMarkedForReview = false, clear = false) {
    const { data, error } = await supabase.rpc('save_attempt_answer', {
      p_attempt_id: attemptId,
      p_question_id: questionId,
      p_option_id: optionId || null,
      p_is_marked: isMarkedForReview,
      p_clear: clear
    })
    if (error) throw error
    return data
  },

  async submitAttempt(attemptId) {
    const { data, error } = await supabase.rpc('submit_test_attempt', { p_attempt_id: attemptId })
    if (error) throw error
    return data
  }
}
