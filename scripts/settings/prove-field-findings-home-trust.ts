#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runIn(
  home: string,
  body: string,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const os = await import('node:os')
    const g = await import(${JSON.stringify(join(SRC, 'platform/config/globalConfig.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'platform/config/trust.ts'))})
    const state = await import(${JSON.stringify(join(SRC, 'boot/process-state/processState.ts'))})
    const pathmod = await import(${JSON.stringify(join(SRC, 'platform/files/path.ts'))})
    g.enableConfigs()
    ${body}
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    timeout: 60_000,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  })
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
  check('the child succeeded (no spawn error, signal or non-zero exit hides behind its output)', out.childFailed === undefined, JSON.stringify(out), 'the bun child could not load or run the config and trust modules: read its stderr in the dump above and check the imports of src/platform/config/trust.ts')
  check('no hasTrustDialogAccepted record keyed on the home root', out.childFailed === undefined && (out.homeRecord === null || out.homeRecord === undefined), JSON.stringify(out), 'setPathTrusted in src/platform/config/trust.ts must not save a record for the home folder: it should only call setSessionTrustAccepted(true)')
  check('the session latch carries the grant instead', out.sessionLatch === true, JSON.stringify(out), 'setPathTrusted in src/platform/config/trust.ts must call setSessionTrustAccepted(true) for the home folder so getSessionTrustAccepted in src/boot/process-state/processState.ts reads true')
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
  check('the child succeeded', out.childFailed === undefined, JSON.stringify(out), 'the bun child could not load or run the config and trust modules: read its stderr in the dump above')
  check('the descendant grant is durable', out.subRecord === true, JSON.stringify(out), 'setPathTrusted in src/platform/config/trust.ts must still save hasTrustDialogAccepted for a folder under home')
}

console.log('L3 · the boot flow reads the latch (the promise: session only, re-asks next boot)')
{
  const home = mkdtempSync(join(tmpdir(), 'ff-trust-l3-'))
  const out = runIn(home, `
    trust.setPathTrusted(os.homedir())
    console.log(JSON.stringify({ accepted: trust.checkHasTrustDialogAccepted() }))
  `)
  check('the child succeeded', out.childFailed === undefined, JSON.stringify(out), 'the bun child could not load or run the config and trust modules: read its stderr in the dump above')
  check('checkHasTrustDialogAccepted is satisfied in-process by the latch', out.accepted === true, JSON.stringify(out), 'computeTrustDialogAccepted in src/platform/config/trust.ts must return true when getSessionTrustAccepted is true')
}
console.log('L4 · a home-folder trust persists for the home folder alone across starts, never for folders under it')
{
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ff-trust-l4-')))
  const configDir = join(scratch, 'config')
  const dialogConfigDir = join(scratch, 'dialog-config')
  const fakeHome = join(scratch, 'home')
  const subUnderHome = join(fakeHome, 'never-trusted-child')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(dialogConfigDir, { recursive: true })
  mkdirSync(subUnderHome, { recursive: true })
  const homeEnv = { HOME: fakeHome, USERPROFILE: fakeHome, MERCURY_CREDENTIAL_STORE: 'file' }
  try {
    const grant = runIn(configDir, `
      trust.setPathTrusted(os.homedir())
      console.log(JSON.stringify({ ok: true }))
    `, { cwd: fakeHome, env: homeEnv })
    check('L4 setPathTrusted child succeeded', grant.childFailed === undefined && grant.ok === true, JSON.stringify(grant))

    const secondStartHome = runIn(configDir, `
      const cfg = g.getGlobalConfig()
      const key = pathmod.normalizePathForConfigKey(os.homedir())
      console.log(JSON.stringify({
        accepted: trust.checkHasTrustDialogAccepted(),
        direct: trust.isPathTrusted(os.homedir()),
        homeProjectRecord: cfg.projects?.[key]?.hasTrustDialogAccepted ?? null,
      }))
    `, { cwd: fakeHome, env: homeEnv })
    check(
      'L4(a) a new start in the home folder reads trusted after setPathTrusted(home)',
      secondStartHome.childFailed === undefined && secondStartHome.accepted === true && secondStartHome.direct === true,
      JSON.stringify(secondStartHome),
      'save home trust in its own top-level GlobalConfig field in src/platform/config/trust.ts and read it only for the home folder',
    )
    check(
      'L4(c) projects[<home>].hasTrustDialogAccepted is not written',
      secondStartHome.childFailed === undefined && secondStartHome.homeProjectRecord === null,
      JSON.stringify(secondStartHome),
      'setPathTrusted must not write projects[<home>].hasTrustDialogAccepted',
    )

    const secondStartChild = runIn(configDir, `
      console.log(JSON.stringify({
        accepted: trust.checkHasTrustDialogAccepted(),
        direct: trust.isPathTrusted(process.cwd()),
      }))
    `, { cwd: subUnderHome, env: homeEnv })
    check(
      'L4(b) a folder under the home folder that was never answered still reads NOT trusted',
      secondStartChild.childFailed === undefined && secondStartChild.accepted === false && secondStartChild.direct === false,
      JSON.stringify(secondStartChild),
      'ancestorKeys / grantedUnder in src/platform/config/trust.ts must never read the home-folder trust field',
    )

    const dialogGrant = runIn(dialogConfigDir, `
      globalThis.MACRO = { VERSION: '1.0.0' }
      const React = await import('react')
      const { App } = await import(${JSON.stringify(join(SRC, 'boot/App.tsx'))})
      const { KeybindingSetup } = await import(${JSON.stringify(join(SRC, 'screen/keys/KeybindingProviderSetup.tsx'))})
      const { getDefaultAppState } = await import(${JSON.stringify(join(SRC, 'screen/app-state/AppStateStore.ts'))})
      const { TrustDialog } = await import(${JSON.stringify(join(SRC, 'screen/trust-dialog/TrustDialog.tsx'))})
      const { KEY, mountOffscreen, waitFor } = await import(${JSON.stringify(join(HERE, '../lib/settingsPopupHarness.ts'))})
      let done = false
      const mounted = await mountOffscreen(
        React.createElement(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined },
          React.createElement(KeybindingSetup, null,
            React.createElement(TrustDialog, { onDone: () => { done = true } }))),
        100,
        30,
      )
      try {
        await waitFor(() => mounted.screen().includes('Yes, I trust this folder'), 10_000)
        mounted.push(KEY.enter)
        await waitFor(() => done, 10_000)
      } finally {
        mounted.unmount()
      }
      console.log('\\n' + JSON.stringify({ done }))
    `, { cwd: fakeHome, env: homeEnv })
    check('L4 TrustDialog answered yes in the home folder', dialogGrant.childFailed === undefined && dialogGrant.done === true, JSON.stringify(dialogGrant))

    const afterDialogHome = runIn(dialogConfigDir, `
      const cfg = g.getGlobalConfig()
      const key = pathmod.normalizePathForConfigKey(os.homedir())
      console.log(JSON.stringify({
        accepted: trust.checkHasTrustDialogAccepted(),
        direct: trust.isPathTrusted(os.homedir()),
        homeProjectRecord: cfg.projects?.[key]?.hasTrustDialogAccepted ?? null,
      }))
    `, { cwd: fakeHome, env: homeEnv })
    check(
      'L4(a) a new start in the home folder reads trusted after TrustDialog answers yes',
      afterDialogHome.childFailed === undefined && afterDialogHome.accepted === true && afterDialogHome.direct === true && afterDialogHome.homeProjectRecord === null,
      JSON.stringify(afterDialogHome),
      'TrustDialog in src/screen/trust-dialog/TrustDialog.tsx must persist home-folder trust through setPathTrusted without writing projects[<home>]',
    )

    const afterDialogChild = runIn(dialogConfigDir, `
      console.log(JSON.stringify({
        accepted: trust.checkHasTrustDialogAccepted(),
        direct: trust.isPathTrusted(process.cwd()),
      }))
    `, { cwd: subUnderHome, env: homeEnv })
    check(
      'L4(b) after TrustDialog in home, a subfolder under home still reads NOT trusted',
      afterDialogChild.childFailed === undefined && afterDialogChild.accepted === false && afterDialogChild.direct === false,
      JSON.stringify(afterDialogChild),
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('L0 · a child that prints the expected object and then FAILS is refused')
{
  const lying = spawnSync(BUN, ['-e', 'console.log(JSON.stringify({ homeRecord: null, sessionLatch: true, accepted: true })); process.exit(1)'], { encoding: 'utf8', timeout: 60_000 })
  const out = childAnswer(lying)
  check('a valid-looking answer followed by exit 1 is reported as a child failure, never as the answer', out.childFailed === 'exit 1' && out.sessionLatch === undefined, JSON.stringify(out), 'childAnswer in this file must return childFailed for a non-zero exit before it parses stdout')
  const killed = spawnSync(BUN, ['-e', 'console.log(JSON.stringify({ accepted: true })); process.kill(process.pid, "SIGTERM"); await new Promise(r => setTimeout(r, 5000))'], { encoding: 'utf8', timeout: 60_000 })
  const outKilled = childAnswer(killed)
  check('an answer followed by a signal death is refused too', /^killed by SIG/.test(String(outKilled.childFailed)) && outKilled.accepted === undefined, JSON.stringify(outKilled), 'childAnswer in this file must return childFailed for a signal death before it parses stdout')
  const missing = spawnSync(join(tmpdir(), 'no-such-runtime-' + process.pid), ['-e', '1'], { encoding: 'utf8' })
  check('a spawn error is refused by name', /^spawn error/.test(String(childAnswer(missing).childFailed)), JSON.stringify(childAnswer(missing)), 'childAnswer in this file must return childFailed starting with spawn error when res.error is set')
  const honest = spawnSync(BUN, ['-e', 'console.log(JSON.stringify({ accepted: true }))'], { encoding: 'utf8', timeout: 60_000 })
  check('a successful child still answers its object', childAnswer(honest).accepted === true, '', 'childAnswer in this file must parse the last stdout line of a child that exits 0')
}

process.exit(failures === 0 ? 0 : 1)
