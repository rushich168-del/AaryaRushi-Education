import { supabase } from '../lib/supabaseClient.js'

export const examConfigService = {
  async getExamCategories() {
    const { data, error } = await supabase.from('exams').select('*').order('created_at', { ascending: true })
    if (error) throw error
    return data || []
  },

  async createExamCategory(name, target_class = null) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const { data, error } = await supabase.from('exams').insert([
      { name, slug, target_class }
    ]).select().single()
    if (error) throw error
    return data
  },

  async getSubjectsForExam(examId) {
    const { data, error } = await supabase.from('exam_subjects').select('*').eq('exam_id', examId).order('created_at', { ascending: true })
    if (error) throw error
    return data || []
  },

  async createSubject(examId, name) {
    const { data, error } = await supabase.from('exam_subjects').insert([
      { exam_id: examId, name }
    ]).select().single()
    if (error) throw error
    return data
  }
}
