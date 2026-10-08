import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const source='supabase/migrations/202609200013_test_portal.sql'
const sql=await readFile(source,'utf8')
const hash=createHash('sha256').update(sql).digest('hex')
const header=`-- KSC Test Portal V1: apply only after KSC-INSTALL and KSC-LMS-UPGRADE.\n-- Confirm isolated KSC project identity and back up before owner execution.\n-- Source: ${source}\n-- Source SHA256: ${hash}\n`
await writeFile('docs/ksc/setup/KSC-TEST-PORTAL-UPGRADE.sql',header+'BEGIN;\n'+sql+'\nCOMMIT;\n')
console.log('Generated transactional Test Portal upgrade; source SHA256:',hash)
