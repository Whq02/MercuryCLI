#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { resolveProofHome } from '../lib/proofHome.ts'

const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
const CONFIG_HOME = resolveProofHome([process.cwd()])
const argv = [
  dist, '-p',
  '--verbose',
  '--input-format=stream-json', '--output-format=stream-json',
  '--model', 'claude-opus-4-8[1m]',
  '--append-system-prompt', '',
  '--team-name', 'scribe', '--agent-name', 'implementer', '--agent-id', 'implementer@scribe',
]
const env = {
  ...process.env,
  MERCURY_CONFIG_DIR: CONFIG_HOME,
  ANTHROPIC_MODEL: 'claude-opus-4-8[1m]',
  MERCURY_EFFORT_LEVEL: 'xhigh',
  MERCURY_SWARMS: '1',
  MERCURY_IMPLEMENTER: '1',
}
console.log('spawning real binary with the Implementer invocation…')
const child = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'], env })
let stderr = ''
let stdout = ''
child.stderr?.setEncoding('utf8')
child.stderr?.on('data', d => { stderr += d })
child.stdout?.setEncoding('utf8')
child.stdout?.on('data', d => { stdout += d })
let exited: number | null | undefined
child.on('exit', c => { exited = c })

await new Promise(r => setTimeout(r, 3500))

const argParseError = /unknown option|must all be provided together|error: required|invalid|not allowed/i.test(stderr)
const aliveOrCleanStart = exited === undefined || exited === 0 || stdout.length > 0
console.log(`  pid=${child.pid} exitedAfter3.5s=${exited === undefined ? 'still-alive' : exited}`)
console.log(`  stdout(${stdout.length}b) stderr(${stderr.length}b)`)
if (stderr.trim()) console.log('  --- stderr head ---\n' + stderr.split('\n').slice(0, 8).map(l => '  | ' + l).join('\n'))
try { child.kill('SIGKILL') } catch {  }

const pass = !argParseError && aliveOrCleanStart
console.log(pass
  ? '\n✅ real binary ACCEPTED the Implementer invocation (no arg-parse crash)'
  : '\n❌ real binary rejected the invocation (see stderr)')
process.exit(pass ? 0 : 1)
