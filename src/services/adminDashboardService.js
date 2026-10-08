import {learningService} from './learningService.js'
import {examLibraryService} from './examLibraryService.js'
import {staffAccountService} from './staffAccountService.js'

export const adminDashboardService={
 async load(){
  const courses=learningService.courses()
  const jobs={
   courses:async()=>Promise.all((await courses).map(async c=>({...c,batches:await learningService.batches(c.id)}))),
   materials:async()=>(await Promise.all((await courses).map(async c=>(await learningService.lessons(c.id)).map(l=>({...l,course:c.name}))))).flat(),
   papers:()=>examLibraryService.list(),
   published:()=>examLibraryService.allDeliveries(),
   people:()=>staffAccountService.list(),
  }
  const entries=Object.entries(jobs),results=await Promise.allSettled(entries.map(([,job])=>job()))
  return Object.fromEntries(entries.map(([key],i)=>[key,results[i].status==='fulfilled'?{data:results[i].value}:{error:results[i].reason?.message||'This section could not load. Please retry.'}]))
 }
}
