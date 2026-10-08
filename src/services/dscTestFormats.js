// DSC-SGT view of the exam-format registry, kept for existing imports. New code uses examFormats.js.
import {examFormats,formatSettings as examFormatSettings,formatIssues,sectionGroups} from './examFormats.js'
export const dscSubjects=examFormats['DSC-SGT'].subjects
export const dscFormats=examFormats['DSC-SGT'].formats
export const formatSettings=id=>examFormatSettings('DSC-SGT',id)
export const dscFormatIssues=p=>p.exam==='DSC-SGT'?formatIssues(p):[]
export {sectionGroups}
