import { build, loadEnv } from 'vite'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { BACKEND_URL, stagingEnvironment, stagingHeaders } from './staging-config.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const selected = stagingEnvironment(loadEnv('production', root, 'VITE_'))
for (const key of Object.keys(process.env)) if (key.startsWith('VITE_')) delete process.env[key]
Object.assign(process.env, selected)
const outDir = path.join(root, 'scratch', 'cloudflare-staging')
await build({ root, envDir: false, build: { outDir, emptyOutDir: true, sourcemap: false } })
await writeFile(path.join(outDir, '_headers'), stagingHeaders)
const zip = new JSZip()
async function pack(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name
    const location = path.join(directory, entry.name)
    if (entry.isDirectory()) { await pack(location, relative + '/'); continue }
    if (/\.(?:map|sql|pem|key)$/.test(relative) || entry.name.startsWith('.env')) throw new Error('Private/source file in staging output.')
    const bytes = await readFile(location)
    if (/\.(?:js|html|json)$/.test(relative)) {
      const text = bytes.toString('utf8')
      if (/sb_secret_|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error('Private credential in staging output.')
      const hosts = text.match(/https:\/\/[a-z0-9-]+\.supabase\.co/g) || []
      if (hosts.some(host => host !== BACKEND_URL && host !== 'https://placeholder.supabase.co')) throw new Error('Unexpected backend in staging output.')
    }
    zip.file(relative, bytes)
  }
}
await pack(outDir)
await writeFile(path.join(root, 'scratch', 'ksc-cloudflare-staging.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
console.log('KSC staging package prepared in scratch/ksc-cloudflare-staging.zip. Live deployment and account acceptance are separate steps.')
