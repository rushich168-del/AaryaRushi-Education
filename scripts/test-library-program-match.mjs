import {test} from 'node:test'
import assert from 'node:assert/strict'
import {matchingShareProgram} from '../src/services/librarySharing.js'
test('saved program and exact legacy exam labels choose the correct assigned program',()=>{
 const programs=[{id:'group',name:'Group-II'},{id:'dsc',name:'DSC'}]
 assert.equal(matchingShareProgram({exam:'Group II'},programs),'group')
 assert.equal(matchingShareProgram({exam:'DSC-SGT'},programs),'dsc')
 assert.equal(matchingShareProgram({exam:'Other',returnedReceipt:{program:'group'}},programs),'group')
})
test('unknown or ambiguous program matches need a choice rather than an incorrect default',()=>{
 assert.equal(matchingShareProgram({exam:'Group II'},[{id:'dsc',name:'DSC'}]),'')
 assert.equal(matchingShareProgram({exam:'Group II'},[{id:'one',name:'Group-II'},{id:'two',name:'Group II'}]),'')
})
