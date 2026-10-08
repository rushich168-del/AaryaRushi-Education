// Test-only preload (node --import): every network, DNS and subprocess entry point is replaced by a
// recorder that throws. Calls are written to $NO_NET_LOG. Used to prove the live-test guard refuses
// BEFORE any network/auth/database/CLI operation — and so that a guard bug cannot reach anything.
import fs from 'fs'
import net from 'net'
import tls from 'tls'
import dns from 'dns'
import http from 'http'
import https from 'https'
import cp from 'child_process'
import { syncBuiltinESMExports } from 'module'

const log = process.env.NO_NET_LOG
const calls = []
const write = () => { if (log) fs.writeFileSync(log, JSON.stringify(calls)) }
const record = (kind, target) => {
  calls.push({ kind, target: String(target?.href || target?.url || target?.host || target || '').slice(0, 200) })
  write()
  throw new Error(`NETWORK BLOCKED BY TEST PRELOAD (${kind})`)
}
globalThis.fetch = async (input) => record('fetch', input)
const patch = (mod, names) => { for (const n of names) if (typeof mod[n] === 'function') mod[n] = (...a) => record(n, a[0]) }
patch(net, ['connect', 'createConnection'])
patch(tls, ['connect'])
patch(http, ['request', 'get'])
patch(https, ['request', 'get'])
patch(dns, ['lookup', 'resolve', 'resolve4', 'resolve6'])
patch(dns.promises, ['lookup', 'resolve'])
patch(cp, ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'])
syncBuiltinESMExports()
write()
