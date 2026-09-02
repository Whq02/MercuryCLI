#!/usr/bin/env bun
// ============================================================================
//  scripts/settings/prove-field-findings-home-trust.ts — the home root never
// persists a trust grant (TASK-017 supplement S1,
//  `home-trust-grant-persisted-by-caller`).
//
//  The disease: TrustDialog's home arm stores trust in session memory only
//  ("never written to disk"), but its caller wrapped the dialog with an
//  unconditional setPathTrusted(getCwd()) — a durable home grant the
//  ancestor walk then spread over every folder under the profile, so the
//  trust card never appeared again anywhere under $HOME (on Windows a fresh
//  terminal opens in %USERPROFILE%, so one accidental home boot silenced it
//  for good). The fix seats the refusal at the ONE write door: a home-root
//  grant becomes the session latch it was promised as.
//
//   L1  setPathTrusted(homedir()) writes NO project record for the home key
//       and raises the session latch instead (red on the pre-fix tree)
//   L2  a folder UNDER home still persists (descendant grants unchanged)
//   L3  the read side honors the latch for the boot flow (session-only)
//
//  Each scenario runs in a fresh bun subprocess with a scratch
//  MERCURY_CONFIG_DIR (the global config memoizes per process).
//
//  Run: ~/.bun/bin/bun run scripts/settings/prove-field-findings-home-trust.ts
// ============================================================================
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
// PROVE_SRC names another checkout's src (the A/B poison: against the
// pre-fix tree L1 and L3 read red).
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
  check('no hasTrustDialogAccepted record keyed on the home root', out.homeRecord === null || out.homeRecord === undefined, JSON.stringify(out))
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
  check('the descendant grant is durable', out.subRecord === true, JSON.stringify(out))
}

console.log('L3 · the boot flow reads the latch (the promise: session only, re-asks next boot)')
{
  const home = mkdtempSync(join(tmpdir(), 'ff-trust-l3-'))
  const out = runIn(home, `
    trust.setPathTrusted(os.homedir())
    console.log(JSON.stringify({ accepted: trust.checkHasTrustDialogAccepted() }))
  `)
  check('checkHasTrustDialogAccepted is satisfied in-process by the latch', out.accepted === true, JSON.stringify(out))
}
// NEEDS-REAL-BOX (the finder's drill): fresh %USERPROFILE%\.mercury, boot
// from %USERPROFILE% in Windows Terminal, accept the trust card; the global
// config holds NO projects entry keyed on the home path; cd into a brand-new
// folder under the profile, boot again: the trust card APPEARS.

process.exit(failures === 0 ? 0 : 1)
