import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// Argument arrays and binary stdin avoid Windows PowerShell CRLF/quoting errors.
const [host, key, knownHosts, script] = process.argv.slice(2)
if (!host || !key || !knownHosts || !script) throw new Error('Usage: node scripts/xgift-vps.mjs USER@HOST PRIVATE_KEY KNOWN_HOSTS BASH_SCRIPT')
if (!/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+$/.test(host)) throw new Error('Invalid SSH destination')
const result = spawnSync('ssh', ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + knownHosts, host, 'bash -s'], { input: readFileSync(script, 'utf8').replaceAll('\r', ''), stdio:['pipe','inherit','inherit'] })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
