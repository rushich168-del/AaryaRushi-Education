import { supabase } from '../lib/supabaseClient.js'

export const examPatternService = {
  async getPatterns(examId) {
    let query = supabase
      .from('exam_patterns')
      .select('*, exams(name), exam_pattern_sections(*, exam_subjects(name))')
      .order('created_at', { ascending: false })
      
    if (examId) query = query.eq('exam_id', examId)

    const { data, error } = await query
    if (error) throw error
    return data
  },

  async getPatternById(id) {
    const { data, error } = await supabase
      .from('exam_patterns')
      .select('*, exams(name), exam_pattern_sections(*, exam_subjects(name))')
      .eq('id', id)
      .single()

    if (error) throw error
    return data
  },

  async createPattern(patternData, sectionsData) {
    const { data, error } = await supabase.rpc('ksc_create_pattern', { p_pattern: patternData, p_sections: sectionsData })
    if (error) throw error
    return data
  },

  async activatePattern(id) {
    const { error } = await supabase.from('exam_patterns').update({ status: 'ACTIVE' }).eq('id', id)
    if (error) throw error
    return true
  },

  async archivePattern(id) {
    const { error } = await supabase.from('exam_patterns').update({ status: 'ARCHIVED' }).eq('id', id)
    if (error) throw error
    return true
  }
}
