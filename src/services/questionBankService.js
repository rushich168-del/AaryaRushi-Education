import { supabase } from '../lib/supabaseClient.js'

export const questionBankService = {
  // Fetch questions with relationships (Exam, Subject, Topic are useful)
  async getQuestions(filters = {}) {
    let query = supabase
      .from('questions')
      .select(`
        *,
        exams (id, name),
        exam_subjects (id, name)
      `)
      .order('created_at', { ascending: false })

    if (filters.exam_id) query = query.eq('exam_id', filters.exam_id)
    if (filters.subject_id) query = query.eq('subject_id', filters.subject_id)
    for (const key of ['level_id','syllabus_id','chapter_id','topic_id']) if (filters[key]) query = query.eq(key,filters[key])
    if (filters.status) query = query.eq('status', filters.status)
    if (filters.difficulty) query = query.eq('difficulty', filters.difficulty)

    const { data, error } = await query
    if (error) throw error
    return data
  },

  // Fetch single question with options and answer key
  async getQuestionById(id) {
    const { data: qData, error: qErr } = await supabase
      .from('questions')
      .select(`
        *,
        exams (id, name),
        exam_subjects (id, name)
      `)
      .eq('id', id)
      .single()

    if (qErr) throw qErr

    const { data: optData, error: optErr } = await supabase
      .from('question_options')
      .select('*')
      .eq('question_id', id)
      .order('sort_order', { ascending: true })

    if (optErr) throw optErr

    const { data: keyData, error: keyErr } = await supabase
      .from('question_answer_keys')
      .select('correct_option_id')
      .eq('question_id', id)
      .maybeSingle()

    if (keyErr) throw keyErr

    return {
      ...qData,
      options: optData || [],
      correct_option_id: keyData ? keyData.correct_option_id : null
    }
  },

  // Create a new question (DRAFT)
  async createQuestion(questionData, options, correctAnswerIndex) {
    const { data, error } = await supabase.rpc('ksc_save_question', {
      p_id: null, p_question: questionData, p_options: options, p_correct_index: correctAnswerIndex
    })
    if (error) throw error
    return data
  },

  async updateQuestionStatus(id, newStatus) {
    const { error } = await supabase
      .from('questions')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) throw error
    return true
  },

  // Atomic edit preserves hierarchy and returns the question to draft for fresh review.
  async updateQuestion(id, questionData, options, correctAnswerIndex) {
    const { data, error } = await supabase.rpc('ksc_save_question', {
      p_id: id, p_question: questionData, p_options: options, p_correct_index: correctAnswerIndex
    })
    if (error) throw error
    return data
  }
}
