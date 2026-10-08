// Exact standalone source headings only; never classify question prose or
// infer a subject split from the chosen practice-test format.
import {examFormat} from './examFormats.js'
const aliases=new Map([
 ['biology','Biology'],['జీవశాస్త్రం','Biology'],['teaching methodology','Teaching Methodology'],['ట్రై మెథడ్','Teaching Methodology'],['బోధనా పద్ధతులు','Teaching Methodology'],
 ['psychology','Educational Psychology'],['educational psychology','Educational Psychology'],['మనోవిజ్ఞాన శాస్త్రం','Educational Psychology'],
 ['geography','Geography'],['భూగోళ శాస్త్రం','Geography'],['telugu','Telugu / Language I'],['తెలుగు','Telugu / Language I'],
 ['physics','Physical Science'],['ఫిజిక్స్','Physical Science'],['physical science','Physical Science'],['mathematics','Mathematics'],['english','English / Language II'],['history','History'],['social studies','Social Studies'],['science','Science & EVS'],['general knowledge & current affairs','General Knowledge & Current Affairs'],['perspectives in education','Perspectives in Education']
])
// For an exam with formats, a heading counts only when it names one of that exam's subjects.
export function sourceSubjectHeading(text,exam) {
 const name=String(text).trim().replace(/\s+/g,' ').replace(/[:：]$/,'').toLowerCase(),format=examFormat(exam)
 if(!format)return aliases.get(name)||null
 const subject=format.headings?.[name]||aliases.get(name)
 return format.subjects.includes(subject)?subject:null
}
export function importedSubjectSections(questions) {
 if(!questions.length||questions.some(q=>!q.subject))return null
 const sections=[]
 for(const q of questions) {const last=sections.at(-1);if(last?.subject===q.subject)last.count++;else sections.push({subject:q.subject,count:1})}
 return sections
}
