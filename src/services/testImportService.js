import { supabase } from '../lib/supabaseClient.js'

export const testImportService = {
  async uploadSourceDocument(file, metadata) {
    // 1. Upload to storage
    const fileExt = file.name.split('.').pop()
    const { data: { user } } = await supabase.auth.getUser()
    const filename = `${crypto.randomUUID()}.${fileExt}`
    const storagePath = `imports/${user.id}/${filename}`
    
    const { error: uploadError } = await supabase.storage
      .from('ksc-source-documents')
      .upload(storagePath, file)
      
    if (uploadError) throw uploadError

    // 2. Create the import record
    const { data, error } = await supabase
      .from('test_imports')
      .insert({
        exam_id: metadata.exam_id,
        level_id: metadata.level_id || null,
        test_kind: metadata.test_kind,
        test_name: metadata.test_name,
        duration_minutes: metadata.duration_minutes || null,
        storage_path: storagePath,
        filename: file.name,
        file_size_bytes: file.size,
        status: 'UPLOADED'
      })
      .select()
      .single()
      
    if (error) throw error
    return data
  },
  
  async getImportRecord(id) {
    const { data, error } = await supabase
      .from('test_imports')
      .select('*, exams(name), exam_levels(name)')
      .eq('id', id)
      .single()
      
    if (error) throw error
    return data
  },

  async getRecentImports() {
    const { data, error } = await supabase
      .from('test_imports')
      .select('*, exams(name), exam_levels(name)')
      .order('created_at', { ascending: false })
      .limit(10)
      
    if (error) throw error
    return data
  },

  async getCandidateCount(importId) {
    const { count, error } = await supabase
      .from('test_import_candidates')
      .select('id', { count: 'exact', head: true })
      .eq('import_id', importId)
      
    if (error) throw error
    return count || 0
  },

  async getCandidates(importId) {
    const { data, error } = await supabase
      .from('test_import_candidates')
      .select('*')
      .eq('import_id', importId)
      
    if (error) throw error
    
    // Sort in memory by source_page then numerically by question_number
    // (since question_number is TEXT in the schema and we can't do a clean numeric sort natively without casting in a view)
    return data.sort((a, b) => {
      const pDiff = (a.source_page || 0) - (b.source_page || 0)
      if (pDiff !== 0) return pDiff
      
      const numA = parseInt(a.question_number, 10)
      const numB = parseInt(b.question_number, 10)
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB
      }
      return (a.question_number || '').localeCompare(b.question_number || '')
    })
  }
}
