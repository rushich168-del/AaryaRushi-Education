// Staff-facing wording for shared-library failures, and the client checks that keep
// values the library would reject from ever being sent. Pure modules; no browser or network.
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {libraryError} from '../src/services/libraryErrors.js'
import {paperIssues} from '../src/services/localExamLibrary.js'

const technical=/RPC|PGRST|SQL|syntax|constraint|TypeError|AbortError|fetch|JWT|\b\d{5}\b/

test('system and network failures become plain guidance and keep the original for developers',()=>{
 const cases=[
  [{message:'TypeError: Failed to fetch'},/Could not reach the institute library/],
  [{message:'AbortError: signal is aborted without reason'},/taking longer than expected.*nothing is duplicated/],
  [{message:'canceling statement due to statement timeout',code:'57014'},/taking longer than expected/],
  [{message:'JWT expired',code:'PGRST301'},/sign-in has expired/],
  [{message:'permission denied for table library_versions',code:'42501'},/does not have permission/],
  [{message:'invalid input syntax for type integer: "60.5"',code:'22P02'},/could not be completed\. Please retry/],
  [{message:'insert or update on table "tests" violates foreign key constraint "tests_exam_id_fkey"',code:'23503'},/could not be completed/],
  [{message:'duplicate key value violates unique constraint',code:'23505'},/could not be completed/],
 ]
 for(const [raw,expected] of cases){
  const friendly=libraryError(raw,'Publishing this test')
  assert.match(friendly.message,expected);assert.doesNotMatch(friendly.message,technical,friendly.message);assert.equal(friendly.cause,raw)
 }
 assert.equal(libraryError({code:'PGRST202',message:'Could not find the function'}).code,'LIBRARY_SETUP_REQUIRED')
 assert.match(libraryError(Object.assign(new Error('The operation was aborted'),{name:'AbortError'})).message,/taking longer than expected/)
})

test('library rules explain what the creator or publisher should do next',()=>{
 const rule=message=>libraryError({message,code:'P0001'}).message
 assert.equal(rule('Question 17 needs correction, answer or creator check'),'Question 17 needs a correction, an answer or your confirmation before the paper can be saved.')
 assert.match(rule('Assigned creator exam or administrator access required'),/not assigned to this institute program.*kept on this device/)
 assert.match(rule('Ready version changed. Use a new version'),/already in the shared library/)
 assert.match(rule('Check AP DSC format counts and marks'),/does not match its selected test format/)
 assert.match(rule('Assigned course access required'),/not assigned to this course/)
 assert.match(rule('Choose a program linked to your assigned course'),/not linked to the paper’s program/)
 assert.match(rule('Assigned batch access required'),/no longer have access to one of the selected batches/)
 assert.match(rule('Ready version unavailable'),/no longer available in your library/)
 // Messages already written for staff pass through unchanged.
 assert.equal(rule('Select at least one assigned batch'),'Select at least one assigned batch')
 assert.equal(rule('Closing time must follow opening time and be in the future'),'Closing time must follow opening time and be in the future')
})

test('ready checks stop values the shared library rejects before they are sent',()=>{
 const q=n=>({number:n,content:`Question ${n}\nA. a\nB. b\nC. c\nD. d`,options:['A','B','C','D'],correct:0})
 const paper={title:'Weekly practice',exam:'Group II',testFormat:'subject',targetCount:2,sections:[{subject:'Mixed subjects',count:2}],duration:60,marks:1,negative:0,confirmed:true,questions:[q(1),q(2)]}
 assert.deepEqual(paperIssues(paper),[])
 assert.deepEqual(paperIssues({...paper,duration:'60',marks:'0.5',negative:'0.25'}),[])
 const blocked=patch=>paperIssues({...paper,...patch}).join(' ')
 assert.match(blocked({duration:'60.5'}),/whole minutes/)
 assert.match(blocked({duration:''}),/whole minutes/)
 assert.match(blocked({duration:601}),/whole minutes/)
 assert.match(blocked({negative:''}),/negative marks of 0 or more/)
 assert.match(blocked({negative:-1}),/negative marks of 0 or more/)
 assert.match(blocked({negative:2}),/cannot be more than the marks per question/)
 assert.match(blocked({marks:0.001}),/from 0\.01 to 100/)
 assert.match(blocked({marks:101}),/from 0\.01 to 100/)
 assert.match(blocked({title:'x'.repeat(201)}),/200 characters/)
})
