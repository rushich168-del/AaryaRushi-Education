import {supabase} from '../lib/supabaseClient.js'
async function count(table,filter){
 let query=supabase.from(table).select('id',{count:'exact',head:true})
 if(filter)query=query.eq(...filter)
 const {count,error}=await query;if(error)throw error;if(count==null)throw Error('Count unavailable');return count
}
async function learnerCount(){
 const ids=new Set();let start=0
 while(true){const {data,error}=await supabase.from('ksc_enrollments').select('student_id,batch_id').order('batch_id').order('student_id').range(start,start+499);if(error)throw error;for(const row of data)ids.add(row.student_id);if(data.length<500)return ids.size;start+=500}
}
async function drafts(table,columns,filter,order){const {data,error}=await supabase.from(table).select(columns).eq(...filter).order(order,{ascending:false}).order('id').limit(5);if(error)throw error;return data}
export const teacherOverviewService={
 async load(){
  const jobs={courses:()=>count('ksc_courses'),batches:()=>count('ksc_batches'),learners:learnerCount,questions:()=>count('questions',['status','DRAFT']),tests:()=>count('tests',['is_published',true]),
   lessons:()=>drafts('ksc_lessons','id,course_id,title,updated_at',['is_published',false],'updated_at'),
   draftTests:()=>drafts('tests','id,name,updated_at',['status','DRAFT'],'updated_at'),
   draftQuestions:()=>drafts('questions','id,content,updated_at',['status','DRAFT'],'updated_at')}
  const entries=Object.entries(jobs),results=await Promise.allSettled(entries.map(([,job])=>job()))
  return Object.fromEntries(entries.map(([key],i)=>[key,results[i].status==='fulfilled'?{data:results[i].value}:{error:true}]))
 }
}
