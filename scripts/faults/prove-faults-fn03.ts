#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runScenario(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn03-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  for (const dir of [home, project]) mkdirSync(dir, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
  })
  if (res.status !== 0) throw new Error(`scenario failed (${res.status}): ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

console.log('\ncrewmateCommands.tsx:86 — corrupt or unreadable crewmate metadata is not overwritten')
{
  const setup = `
    const { setOriginalCwd, setCwdState } = await import(${JSON.stringify(join(SRC, 'bootstrap/state.ts'))})
    setOriginalCwd(process.cwd())
    setCwdState(process.cwd())
    const { crewmateMetadataFile } = await import(${JSON.stringify(join(SRC, 'components/tasks/useCrewmateModel.ts'))})
    const { runCrewmateCommand, openCrewmateModelPickerFor } = await import(${JSON.stringify(join(SRC, 'components/PromptInput/crewmateCommands.tsx'))})
    const crewmate = {
      name: 'scout-a',
      taskId: 'agent-fn03-test',
      local: {
        type: 'local_agent',
        id: 'agent-fn03-test',
        agentId: 'agent-fn03-test',
        agentType: 'Explore',
        status: 'completed',
        model: 'claude-sonnet-4-6',
      },
      facts: {
        transcriptAgentId: 'agent-fn03-test',
        agentType: 'Explore',
        model: 'claude-sonnet-4-6',
        effort: null,
        tokens: null,
        costUSD: null,
        unpricedTurns: 0,
        toolUses: 0,
        startedAt: 1,
        endedAt: null,
      },
    }
    const file = crewmateMetadataFile(crewmate)
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true })
    const receipts = []
    const io = {
      setAppState: () => {},
      receipt: (text, color) => receipts.push({ text, color }),
    }
    const effortCmd = { name: 'effort', userFacingName: () => 'effort' }
    const compactCmd = { name: 'compact', userFacingName: () => 'compact' }
  `

  const corrupt = runScenario(`
    ${setup}
    const torn = '{"agentType":"Explore","description":"keep me","worktreePath":"/keep/path"'
    fs.writeFileSync(file, torn, 'utf8')
    await runCrewmateCommand(effortCmd, '/effort high', crewmate, io)
    out.afterEffort = fs.readFileSync(file, 'utf8')
    out.sameAfterEffort = out.afterEffort === torn
    out.effortReceipts = receipts.splice(0)
    await runCrewmateCommand(compactCmd, '/compact', crewmate, io)
    out.sameAfterCompact = fs.readFileSync(file, 'utf8') === torn
    out.compactReceipts = receipts.splice(0)
    await openCrewmateModelPickerFor(crewmate, io)
    out.pickerReceipts = receipts.splice(0)
  `)
  const effortReceipts = corrupt.effortReceipts as Array<{ text: string; color?: string }>
  const compactReceipts = corrupt.compactReceipts as Array<{ text: string; color?: string }>
  const pickerReceipts = corrupt.pickerReceipts as Array<{ text: string; color?: string }>
  check(
    'crewmate-corrupt-effort-no-overwrite',
    corrupt.sameAfterEffort === true &&
      effortReceipts.some(r => r.color === 'warning' && r.text.includes('could not be read')),
    `same=${String(corrupt.sameAfterEffort)} receipts=${JSON.stringify(effortReceipts)}`,
  )
  check(
    'crewmate-corrupt-compact-no-overwrite',
    corrupt.sameAfterCompact === true &&
      compactReceipts.some(r => r.color === 'warning' && r.text.includes('could not be read')),
    `same=${String(corrupt.sameAfterCompact)} receipts=${JSON.stringify(compactReceipts)}`,
  )
  check(
    'crewmate-corrupt-picker-warns',
    pickerReceipts.some(r => r.color === 'warning' && r.text.includes('could not be read')),
    `receipts=${JSON.stringify(pickerReceipts)}`,
  )

  if (!POSIX_MODES) {
    skip('crewmate-eacces-no-overwrite', 'a mode-0200 file needs a POSIX process that is not root')
  } else {
    const eacces = runScenario(`
      ${setup}
      const saved = JSON.stringify({ agentType: 'Explore', description: 'precious', model: 'claude-sonnet-4-6' })
      fs.writeFileSync(file, saved, { mode: 0o600 })
      fs.chmodSync(file, 0o200)
      await runCrewmateCommand(effortCmd, '/effort high', crewmate, io)
      fs.chmodSync(file, 0o600)
      out.same = fs.readFileSync(file, 'utf8') === saved
      out.receipts = receipts
    `)
    const receipts = eacces.receipts as Array<{ text: string; color?: string }>
    check(
      'crewmate-eacces-no-overwrite',
      eacces.same === true &&
        receipts.some(r => r.color === 'warning' && r.text.includes('could not be read')),
      `same=${String(eacces.same)} receipts=${JSON.stringify(receipts)}`,
    )
  }

  const absent = runScenario(`
    ${setup}
    await runCrewmateCommand(effortCmd, '/effort high', crewmate, io)
    out.exists = fs.existsSync(file)
    out.parsed = out.exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    out.receipts = receipts
  `)
  const parsed = absent.parsed as { agentType?: string; effortOverride?: string } | null
  check(
    'crewmate-absent-control-writes',
    absent.exists === true && parsed?.agentType === 'Explore' && parsed?.effortOverride === 'high',
    `parsed=${JSON.stringify(parsed)} receipts=${JSON.stringify(absent.receipts)}`,
  )
}

console.log('\nbootLogins/runs.ts:40,43 — postLoginSettleOf fails closed when sovereign killswitch check throws')
{
  const rejected = runScenario(`
    const { mock } = await import('bun:test')
    const killswitchPath = ${JSON.stringify(join(SRC, 'utils/permissions/bypassPermissionsKillswitch.ts'))}
    mock.module(killswitchPath, () => ({
      resetSovereignCheck: () => {},
      checkAndDisableSovereignIfNeeded: async () => { throw new Error('killswitch probe failed') },
    }))
    const { postLoginSettleOf } = await import(${JSON.stringify(join(SRC, 'components/bootLogins/runs.ts'))})
    let state = {
      authVersion: 0,
      notifications: { current: null, queue: [] },
      toolPermissionContext: {
        mode: 'sovereign',
        isBypassPermissionsModeAvailable: true,
      },
    }
    postLoginSettleOf({
      given: undefined,
      setAppStateMaybe: updater => { state = updater(state) },
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    out.mode = state.toolPermissionContext.mode
    out.available = state.toolPermissionContext.isBypassPermissionsModeAvailable
    out.authVersion = state.authVersion
    out.notice = state.notifications.current ?? state.notifications.queue[0] ?? null
  `)
  const rejectedNotice = rejected.notice as { key?: string; color?: string; text?: string } | null
  check(
    'bootlogins-killswitch-reject-fails-closed',
    rejected.mode === 'default' &&
      rejected.available === false &&
      rejectedNotice?.key === 'bypass-killswitch' &&
      rejectedNotice?.color === 'warning' &&
      rejectedNotice?.text === "bypass permissions was turned off: your organization's security policy could not be checked (killswitch probe failed)",
    `mode=${String(rejected.mode)} available=${String(rejected.available)} notice=${JSON.stringify(rejectedNotice)}`,
  )

  const outerThrow = runScenario(`
    const { mock } = await import('bun:test')
    const userPath = ${JSON.stringify(join(SRC, 'utils/user.ts'))}
    mock.module(userPath, () => ({
      resetUserCache: () => { throw new Error('user cache reset failed') },
    }))
    const { postLoginSettleOf } = await import(${JSON.stringify(join(SRC, 'components/bootLogins/runs.ts'))})
    let state = {
      authVersion: 0,
      notifications: { current: null, queue: [] },
      toolPermissionContext: {
        mode: 'sovereign',
        isBypassPermissionsModeAvailable: true,
      },
    }
    postLoginSettleOf({
      given: undefined,
      setAppStateMaybe: updater => { state = updater(state) },
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    out.mode = state.toolPermissionContext.mode
    out.available = state.toolPermissionContext.isBypassPermissionsModeAvailable
    out.notice = state.notifications.current ?? state.notifications.queue[0] ?? null
  `)
  const outerNotice = outerThrow.notice as { key?: string; color?: string; text?: string } | null
  check(
    'bootlogins-settle-throw-fails-closed',
    outerThrow.mode === 'default' &&
      outerThrow.available === false &&
      outerNotice?.key === 'bypass-killswitch' &&
      outerNotice?.color === 'warning' &&
      outerNotice?.text === "bypass permissions was turned off: your organization's security policy could not be checked (user cache reset failed)",
    `mode=${String(outerThrow.mode)} available=${String(outerThrow.available)} notice=${JSON.stringify(outerNotice)}`,
  )
  const control = runScenario(`
    const { mock } = await import('bun:test')
    const killswitchPath = ${JSON.stringify(join(SRC, 'utils/permissions/bypassPermissionsKillswitch.ts'))}
    mock.module(killswitchPath, () => ({
      resetSovereignCheck: () => {},
      checkAndDisableSovereignIfNeeded: async () => {},
    }))
    const { postLoginSettleOf } = await import(${JSON.stringify(join(SRC, 'components/bootLogins/runs.ts'))})
    let state = {
      authVersion: 0,
      toolPermissionContext: {
        mode: 'sovereign',
        isBypassPermissionsModeAvailable: true,
      },
    }
    postLoginSettleOf({
      given: undefined,
      setAppStateMaybe: updater => { state = updater(state) },
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    out.mode = state.toolPermissionContext.mode
    out.available = state.toolPermissionContext.isBypassPermissionsModeAvailable
    out.authVersion = state.authVersion
  `)
  check(
    'bootlogins-killswitch-ok-keeps-sovereign',
    control.mode === 'sovereign' && control.available === true && control.authVersion === 1,
    `mode=${String(control.mode)} available=${String(control.available)} authVersion=${String(control.authVersion)}`,
  )
}

console.log('\nWorktreeExitDialog.tsx:43,48 — failed directory restore reports the failure sentence instead of silent exit')
{
  const res = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'components/WorktreeExitDialog.tsx'))})
    if (typeof mod.restoreWorktreeDirectories !== 'function') {
      out.missing = true
    } else {
      let setCwdCalledAfterChdirFail = false
      out.chdirFail = mod.restoreWorktreeDirectories(
        { originalCwd: '/repo/main' },
        {
          chdir: () => { throw new Error('ENOENT: no such directory') },
          setCwd: () => { setCwdCalledAfterChdirFail = true },
        },
      )
      out.setCwdCalledAfterChdirFail = setCwdCalledAfterChdirFail
      out.setCwdFail = mod.restoreWorktreeDirectories(
        { originalCwd: '/repo/main' },
        {
          chdir: () => {},
          setCwd: () => { throw new Error('EACCES: permission denied') },
        },
      )
      out.ok = mod.restoreWorktreeDirectories(
        { originalCwd: '/repo/main' },
        { chdir: () => {}, setCwd: () => {} },
      )
    }
  `)
  check(
    'worktree-exit-chdir-fail-reports-sentence',
    res.missing !== true &&
      res.setCwdCalledAfterChdirFail === true &&
      res.chdirFail === 'Could not return to /repo/main (ENOENT: no such directory) — switch back to that folder before continuing.',
    JSON.stringify(res),
  )
  check(
    'worktree-exit-setcwd-fail-reports-sentence',
    res.missing !== true &&
      res.setCwdFail === 'Could not return to /repo/main (EACCES: permission denied) — switch back to that folder before continuing.',
    JSON.stringify(res),
  )
  check(
    'worktree-exit-restore-ok-silent',
    res.missing !== true && res.ok === null,
    JSON.stringify(res),
  )
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
