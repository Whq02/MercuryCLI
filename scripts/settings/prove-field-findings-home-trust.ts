#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runIn(home: string, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const os = await import('node:os')
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'utils/config/trust.ts'))})
    const state = await import(${JSON.stringify(join(SRC, 'bootstrap/state.ts'))})
    const pathmod = await import(${JSON.stringify(join(SRC, 'utils/path.ts'))})
    g.enableConfigs()
    ${body}
  `
  const res = spawnSync(BUN, ['-e', src], { encoding: 'utf8', timeout: 60_000 })
  return childAnswer(res)
}

function childAnswer(res: { error?: Error; signal?: string | null; status?: number | null; stdout?: string | null; stderr?: string | null }): Record<string, unknown> {
  if (res.error) return { childFailed: `spawn error: ${res.error.message}`, stderr: res.stderr }
  if (res.signal) return { childFailed: `killed by ${res.signal}`, stderr: res.stderr }
  if (res.status !== 0) return { childFailed: `exit ${res.status}`, stderr: (res.stderr ?? '').slice(-400) }
  const line = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '{}'
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return { parseError: line, stderr: res.stderr }
  }
}

console.log('L1 · a home-root grant never lands on disk; the session latch rises')
{
  const home = mkdtempSync(join(tmpdir(), 'ff-trust-l1-'))
  const out = runIn(home, `
    trust.setPathTrusted(os.homedir())
    const cfg = g.getGlobalConfig()
    const key = pathmod.normalizePathForConfigKey(os.homedir())
    console.log(JSON.stringify({
      homeRecord: cfg.projects?.[key]?.hasTrustDialogAccepted ?? null,
      sessionLatch: state.getSessionTrustAccepted(),
    }))
  `)
  check('the child succeeded (no spawn error, signal or non-zero exit hides behind its output)', out.childFailed === undefined, JSON.stringify(out))
  check('no hasTrustDialogAccepted record keyed on the home root', out.childFailed === undefined && (out.homeRecord === null || out.homeRecord === undefined), JSON.stringify(out))
  check('the session latch carries the grant instead', out.sessionLatch === true, JSON.stringify(out))
}

console.log('L2 · a folder UNDER home still persists (descendants unchanged)')
{
  const home = mkdtempSync(join(tmpdir(), 'ff-trust-l2-'))
  const out = runIn(home, `
    const path = await import('node:path')
    const sub = path.join(os.homedir(), 'ff-sub-project')
    trust.setPathTrusted(sub)
    const cfg = g.getGlobalConfig()
    const key = pathmod.normalizePathForConfigKey(sub)
    console.log(JSON.stringify({ subRecord: cfg.projects?.[key]?.hasTrustDialogAccepted ?? null }))
  `)
  check('the child succeeded', out.childFailed === undefined, JSON.stringify(out))
  check('the descendant grant is durable', out.subRecord === true, JSON.stringify(out))
}

console.log('L3 · the boot flow reads the latch (the promise: session only, re-asks next boot)')
{
  const home = mkdtempSync(join(tmpdir(), 'ff-trust-l3-'))
  const out = runIn(home, `
    trust.setPathTrusted(os.homedir())
    console.log(JSON.stringify({ accepted: trust.checkHasTrustDialogAccepted() }))
  `)
  check('the child succeeded', out.childFailed === undefined, JSON.stringify(out))
  check('checkHasTrustDialogAccepted is satisfied in-process by the latch', out.accepted === true, JSON.stringify(out))
}

console.log('L0 · a child that prints the expected object and then FAILS is refused')
{
  const lying = spawnSync(BUN, ['-e', 'console.log(JSON.stringify({ homeRecord: null, sessionLatch: true, accepted: true })); process.exit(1)'], { encoding: 'utf8', timeout: 60_000 })
  const out = childAnswer(lying)
  check('a valid-looking answer followed by exit 1 is reported as a child failure, never as the answer', out.childFailed === 'exit 1' && out.sessionLatch === undefined, JSON.stringify(out))
  const killed = spawnSync(BUN, ['-e', 'console.log(JSON.stringify({ accepted: true })); process.kill(process.pid, "SIGTERM"); await new Promise(r => setTimeout(r, 5000))'], { encoding: 'utf8', timeout: 60_000 })
  const outKilled = childAnswer(killed)
  check('an answer followed by a signal death is refused too', /^killed by SIG/.test(String(outKilled.childFailed)) && outKilled.accepted === undefined, JSON.stringify(outKilled))
  const missing = spawnSync(join(tmpdir(), 'no-such-runtime-' + process.pid), ['-e', '1'], { encoding: 'utf8' })
  check('a spawn error is refused by name', /^spawn error/.test(String(childAnswer(missing).childFailed)), JSON.stringify(childAnswer(missing)))
  const honest = spawnSync(BUN, ['-e', 'console.log(JSON.stringify({ accepted: true }))'], { encoding: 'utf8', timeout: 60_000 })
  check('a successful child still answers its object', childAnswer(honest).accepted === true)
}

process.exit(failures === 0 ? 0 : 1)
