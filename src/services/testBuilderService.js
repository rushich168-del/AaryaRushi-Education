import { supabase } from '../lib/supabaseClient.js'

export const testBuilderService = {
  async getTests() {
    const { data, error } = await supabase
      .from('tests')
      .select('*, exams(name), exam_patterns(name)')
      .order('created_at', { ascending: false })
      
    if (error) throw error
    return data
  },

  async getTestById(id) {
    const { data, error } = await supabase
      .from('tests')
      .select('*, exams(name), exam_patterns(*, exam_pattern_sections(*, exam_subjects(name)))')
      .eq('id', id)
      .single()
      
    if (error) throw error
    return data
  },

  async createTest(testData) {
    const { data, error } = await supabase.rpc('ksc_create_test', { p_test: testData })
    if (error) throw error
    return data
  },

  async getEligibleQuestions(sectionId, subjectId, examId, levelId) {
    let query = supabase
      .from('questions')
      .select('*, exam_subjects(name)')
      .eq('status', 'APPROVED')
      .eq('exam_id', examId)
      .eq('subject_id', subjectId)
    if (levelId) query = query.eq('level_id',levelId)
    const { data, error } = await query
    if (error) throw error
    return data
  },

  async getTestQuestions(testId) {
    const { data, error } = await supabase
      .from('test_questions')
      .select('*, questions(*)')
      .eq('test_id', testId)
      .order('sort_order', { ascending: true })
      
    if (error) throw error
    return data
  },

  async getPublishedPreview(testId) {
    const { data: test, error: testError } = await supabase.from('tests').select('*').eq('id',testId).single()
    if(testError) throw testError
    const { data: questions, error } = await supabase.from('test_question_snapshots').select('*').eq('test_id',testId).order('section_order').order('sort_order')
    if(error) throw error
    const sections=new Map()
    for(const q of questions){
      const section=sections.get(q.section_id)||{id:q.section_id,section_name:q.section_name||'Historical section unavailable',question_count:0,marks_per_question:q.marks,negative_marks:q.negative_marks}
      section.question_count++;sections.set(q.section_id,section)
    }
    return {test:{...test,exam_patterns:{name:test.pattern_name,exam_pattern_sections:[...sections.values()]}},questions:questions.map(q=>({section_id:q.section_id,questions:{...q,id:q.question_id}}))}
  },

  async addQuestionToTest(testId, questionId, sectionId, sortOrder = 0) {
    const { error } = await supabase
      .from('test_questions')
      .insert({
        test_id: testId,
        question_id: questionId,
        section_id: sectionId,
        sort_order: sortOrder
      })
      
    if (error) throw error
    return true
  },

  async removeQuestionFromTest(testId, questionId) {
    const { error } = await supabase
      .from('test_questions')
      .delete()
      .eq('test_id', testId)
      .eq('question_id', questionId)
      
    if (error) throw error
    return true
  },

  async publishTest(testId) {
    // Uses the atomic RPC we created in the migration
    const { data, error } = await supabase.rpc('publish_test', { p_test_id: testId })
    if (error) throw error
    return data
  }
}
