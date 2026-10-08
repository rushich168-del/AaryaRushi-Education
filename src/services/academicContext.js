export const academicFields = ['exam_id', 'level_id', 'subject_id', 'syllabus_id', 'chapter_id', 'topic_id']

export function academicChoices(data, value, activeOnly = false) {
  const active = rows => activeOnly ? rows.filter(row => row.is_active !== false) : rows
  return [
    ['exam_id', 'Program', active(data.exams)],
    ['level_id', 'Track / class', active(data.levels).filter(row => row.exam_id === value.exam_id)],
    ['subject_id', 'Academic subject', active(data.subjects).filter(row => row.exam_id === value.exam_id)],
    ['syllabus_id', 'Syllabus', data.syllabi.filter(row => row.exam_id === value.exam_id && row.level_id === value.level_id && row.subject_id === value.subject_id && (!activeOnly || row.status === 'ACTIVE'))],
    ['chapter_id', 'Chapter', active(data.chapters).filter(row => row.syllabus_id === value.syllabus_id)],
    ['topic_id', 'Topic', active(data.topics).filter(row => row.chapter_id === value.chapter_id)],
  ]
}

export function reconcileAcademicContext(data, value) {
  const next = { ...value }
  for (const [index, key] of academicFields.entries()) {
    const options = academicChoices(data, next, true)[index][2]
    if ((index > 0 && !next[academicFields[index - 1]]) || (next[key] && !options.some(row => row.id === next[key]))) next[key] = ''
    if (key === 'syllabus_id' && next.subject_id && next.level_id && !next[key] && options.length === 1) next[key] = options[0].id
  }
  return next
}
