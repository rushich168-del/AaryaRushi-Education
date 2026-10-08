// Demo exam families shown on the public site. Official rules are not modelled here.
export const exams = [
  { slug: 'foundation', name: 'Competitive Exams Foundation', fullName: 'Competitive Exams Foundation (Classes 8–10)', audience: 'School students', demoTestId: 'foundation-practice-test-1' },
  { slug: 'class-10-maths', name: 'Class 10 Maths', fullName: 'Class 10 Mathematics — board exam preparation', audience: 'Class 10 students' },
  { slug: 'iit-neet-foundation', name: 'IIT / NEET Foundation', fullName: 'IIT-JEE and NEET Foundation', audience: 'Classes 8–10' },
  { slug: 'sainik-school', name: 'Sainik School', fullName: 'All India Sainik Schools Entrance Examination (AISSEE)', audience: 'Class 6 and 9 entrance' },
  { slug: 'police-recruitment', name: 'Police Recruitment Prep', fullName: 'Police Constable & SI Recruitment Preparation', audience: 'Graduates & aspirants' },
]
export function findExam(slug) {
  return exams.find((exam) => exam.slug === slug)
}
