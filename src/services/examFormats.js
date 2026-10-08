// Practice-test formats for each exam collection that has them. These are example institute practice
// formats for the demo. Syllabi and patterns are references for subject choices and
// starting splits, never a claim about current recruitment rules.
const dscSubjects=['General Knowledge & Current Affairs','Perspectives in Education','Educational Psychology','Telugu / Language I','English / Language II','Mathematics','Science & EVS','Social Studies','Teaching Methodology','Biology','Physical Science','History','Geography']
const groupTwoSubjects=['Indian History','Geography','Indian Society','Current Affairs','Mental Ability']
const policeSubjects=['Arithmetic','Reasoning & Mental Ability','General Science','Indian History & National Movement','Geography','Indian Polity','Indian Economy','Current Affairs','English']
const single=(subject,count)=>[{subject,count}]
// Headings that spell a subject's own name, with "&" or "and".
const ownNames=subjects=>Object.fromEntries(subjects.flatMap(s=>[[s.toLowerCase(),s],[s.toLowerCase().replace(' & ',' and '),s]]))
// A format with custom:true lets the creator set the question count and marks; the others are fixed.
// defaults are applied with the format and stay editable. note sits with the sections, label under the format.
// max limits a custom count (1000 unless set).
export const examFormats={
 'DSC-SGT':{
  title:'DSC-SGT test format',tag:'Andhra Pradesh · SGT',groupLabel:'DSC test format',
  intro:'Practice series · choose the format before importing your paper.',
  subjects:dscSubjects,subjectOptions:['Mixed subjects',...dscSubjects],
  formats:[
   {id:'subject',name:'Subject wise',hint:'Custom questions & marks',count:20,marks:1,custom:true},
   {id:'dt',name:'DT-series',hint:'100 questions · 100 marks',count:100,marks:1},
   {id:'wt',name:'WT-series',hint:'100 questions · 100 marks',count:100,marks:1},
   {id:'grand',name:'Grand test',hint:'160 questions · 80 marks',count:160,marks:0.5,note:'Editable starting split, informed by the AP 2024 SGT reference. Check it against your paper; science and social studies can be split into smaller subjects.'}],
  settings:{syllabusReference:'ap'},
  defaultSections:f=>f.id==='grand'?[[0,16],[1,8],[2,16],[3,24],[4,24],[5,24],[6,24],[7,24]].map(([i,count])=>({subject:dscSubjects[i],count})):single(f.custom?dscSubjects[0]:'Mixed subjects',f.count),
  chooseFormat:'Choose a DSC-SGT test format.',
  stale:{when:p=>!!p.syllabusReference&&p.syllabusReference!=='ap',issue:'This saved draft uses an older syllabus setup. Choose an AP test format to reset its section plan; questions are preserved.',prompt:'This saved draft uses an older syllabus setup. Choose an AP format above to reset the section plan. Your questions are kept.'},
  reference:{summary:'About the AP syllabus reference',text:'Subject choices use the historical AP government SGT syllabus. Series settings are institute practice formats; recruitment rules can change.',label:'AP SGT · 2024 syllabus reference',url:'https://apdsc.apcfss.in/Documents/DSC_SYLLABUS_FEB_2024.pdf'}
 },
 // The local exam collection is named "Group II"; the institute program is "Group-II". Both find this entry.
 'Group-II':{
  title:'Group-II Prelims test format',tag:'Group-II · Prelims',groupLabel:'Group-II test format',
  intro:'Choose the format before importing your paper.',
  subjects:groupTwoSubjects,subjectOptions:[...groupTwoSubjects,'Mixed subjects'],
  // Standalone source headings that name a section, besides the shared ones in sourceSubjectHeadings.js.
  headings:{'indian history':'Indian History','indian society':'Indian Society','current affairs':'Current Affairs','mental ability':'Mental Ability'},
  formats:[
   {id:'subject',name:'Subject test',hint:'Custom questions & marks',count:20,marks:1,custom:true},
   {id:'final',name:'Final test',hint:'150 questions · 150 marks',count:150,marks:1,defaults:{duration:150,negative:0.33},label:'Based on the APPSC Group-II Screening Test pattern. Check against the current notification; the institute can change sections and negative marks.'}],
  defaultSections:f=>f.id==='final'?groupTwoSubjects.map(subject=>({subject,count:30})):single(groupTwoSubjects[0],f.count),
  chooseFormat:'Choose a Group-II format to set the section plan. Your questions are kept.',
  // Group-II papers were prepared before formats existed: drafts are asked to choose one;
  // finished versions, and a ready save that was interrupted, stay valid without one.
  earlierPapers:true
 },
 // The local exam collection and the institute program are both named "SI & Constable".
 'SI & Constable':{
  title:'SI & Constable test format',tag:'Andhra Pradesh · Police (SI & Constable)',groupLabel:'SI & Constable test format',
  intro:'Choose the format before importing your paper.',
  subjects:policeSubjects,subjectOptions:[...policeSubjects,'Mixed subjects'],
  headings:ownNames(policeSubjects),
  formats:[
   // The shared library takes at most 500 questions in one paper.
   {id:'subject',name:'Subject test',hint:'Custom questions & marks',count:20,marks:1,custom:true,max:500},
   {id:'final',name:'Final test',hint:'200 questions · 200 marks',count:200,marks:1,defaults:{duration:180,negative:0},label:'Starting split, informed by the AP police (APSLPRB) preliminary test pattern. Check against the current notification; the institute can change sections, time and negative marks.'}],
  defaultSections:f=>f.id==='final'?[50,50,20,20,15,15,10,20].map((count,i)=>({subject:policeSubjects[i],count})):single(policeSubjects[0],f.count),
  chooseFormat:'Choose an SI & Constable format to set the section plan. Your questions are kept.',
  // Papers were prepared before formats existed, as for Group-II.
  earlierPapers:true
 }
}
const key=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'')
export function examFormat(exam) {
 const name=key(exam)
 return Object.entries(examFormats).find(([id])=>key(id)===name)?.[1]||null
}
const chosenFormat=(e,p)=>e?.formats.find(f=>f.id===p.testFormat)
// Paper settings for a format of an exam; the first format is the default. Empty for exams without formats.
export function formatSettings(exam,id) {
 const e=examFormat(exam);if(!e)return {}
 const f=e.formats.find(x=>x.id===id)||e.formats[0]
 return {testFormat:f.id,...e.settings,targetCount:f.count,marks:f.marks,...f.defaults,sections:e.defaultSections(f)}
}
// Marks per question are fixed by every format except a custom one.
export function marksLocked(p) {
 const e=examFormat(p.exam);if(!e)return false
 const f=chosenFormat(e,p)
 return f?!f.custom:!e.earlierPapers
}
export function sectionGroups(p) {
 const groups=new Map();let start=0
 const ranges=(p.sections||[]).map(s=>{const row={...s,start,end:start+Number(s.count)};start=row.end;return row})
 for(const [index,q] of (p.questions||[]).entries()) {
  const subject=q.subject||ranges.find(s=>index>=s.start&&index<s.end)?.subject||'Unassigned questions'
  if(!groups.has(subject))groups.set(subject,[])
  groups.get(subject).push({q,index})
 }
 return [...groups].map(([subject,items])=>({subject,items}))
}
export function formatIssues(p) {
 const e=examFormat(p.exam);if(!e)return []
 const f=chosenFormat(e,p)
 if(!f)return e.earlierPapers&&!p.testFormat&&(p.state==='ready'||p.readyOperation)?[]:[e.chooseFormat]
 const target=f.custom?Number(p.targetCount):f.count,max=f.max||1000
 const errors=[]
 if(e.stale?.when(p))errors.push(e.stale.issue)
 if(!Number.isInteger(target)||target<1||target>max)errors.push(`Set a whole question count from 1 to ${max}.`)
 if(p.questions.length!==target)errors.push(`This format needs ${target} questions; imported ${p.questions.length}.`)
 if(!f.custom&&Number(p.marks)!==f.marks)errors.push(`${f.name} uses ${f.marks} mark per question.`)
 if(!p.sections?.length||p.sections.some(s=>!s.subject?.trim()||!Number.isInteger(Number(s.count))||Number(s.count)<1)||p.sections.reduce((n,s)=>n+Number(s.count),0)!==target)errors.push(`Subject sections must total ${target} questions, with at least one per section.`)
 if(p.questions.length===target&&p.sections?.length) {
  const planned=new Map();for(const s of p.sections)planned.set(s.subject,(planned.get(s.subject)||0)+Number(s.count))
  const actual=new Map(sectionGroups(p).map(g=>[g.subject,g.items.length]))
  if([...new Set([...planned.keys(),...actual.keys()])].some(subject=>planned.get(subject)!==actual.get(subject)))errors.push('Question subjects differ from your section counts. Adjust the sections or question subjects before saving.')
 }
 return errors
}
