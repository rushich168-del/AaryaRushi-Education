import { build } from 'vite'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'

const root = fileURLToPath(new URL('../', import.meta.url))
// Never load copied/local backend settings into the public early preview.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('VITE_')) delete process.env[key]
}
process.env.VITE_PUBLIC_PREVIEW = 'true'
const outDir = path.join(root, 'scratch', 'cloudflare-preview')
await build({ root, envDir: false, build: { outDir, emptyOutDir: true, sourcemap: false } })
await writeFile(path.join(outDir, '_headers'), `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'
  X-Robots-Tag: noindex, nofollow
`)
const zip = new JSZip()
async function addDirectory(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name
    const location = path.join(directory, entry.name)
    if (entry.isDirectory()) await addDirectory(location, relative + '/')
    else {
      if (/\.(?:map|sql|pem|key)$/.test(relative) || entry.name.startsWith('.env')) throw new Error('Unexpected private/source file in deployment')
      const bytes = await readFile(location)
      if (/\.(?:js|html|json)$/.test(relative)) {
        const text = bytes.toString('utf8')
        if (/https:\/\/(?!placeholder\.)[a-z0-9-]+\.supabase\.co|sb_secret_|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) throw new Error('Unexpected backend configuration or secret in preview')
      }
      zip.file(relative, bytes)
    }
  }
}
await addDirectory(outDir)
await mkdir(path.join(root, 'scratch'), { recursive: true })
await writeFile(path.join(root, 'scratch', 'ksc-cloudflare-preview.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
console.log('Preview ready: scratch/cloudflare-preview and scratch/ksc-cloudflare-preview.zip. No local backend environment loaded.')
