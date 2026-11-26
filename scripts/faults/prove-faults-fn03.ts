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
    const { setOriginalCwd, setCwdState } = await import(${JSON.stringify(join(SRC, 'boot/process-state/processState.ts'))})
    setOriginalCwd(process.cwd())
    setCwdState(process.cwd())
    const { crewmateMetadataFile } = await import(${JSON.stringify(join(SRC, 'screen/tasks/useCrewmateModel.ts'))})
    const { runCrewmateCommand, crewmatePickerSeat } = await import(${JSON.stringify(join(SRC, 'screen/composer/crewmateCommands.tsx'))})
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
    const { openDialogCommand } = await import(${JSON.stringify(join(SRC, 'screen/chat/submit/dialogCommand.ts'))})
    const state = { tasks: { [crewmate.taskId]: { ...crewmate.local, description: crewmate.name, startTime: 1 } }, crewLedger: {}, viewingCrewmateTaskId: crewmate.taskId }
    async function command(name, args) {
      const { call } = await import(name === 'model' ? ${JSON.stringify(join(SRC, 'commands/model/mercuryModel.tsx'))} : ${JSON.stringify(join(SRC, 'commands/effort/effort.tsx'))})
      const { context, onDone, failDialog } = openDialogCommand({
        getToolUseContext: () => ({ options: { engineModel: crewmate.local.model }, crewmateSeat: door => crewmatePickerSeat(state, door) }),
        dialogInFlightRef: { current: null }, drainQueuedDialogCommand: () => {}, setToolJSX: () => {}, addNotification: notice => receipts.push(notice),
      }, { input: '/' + name, focusedNow: { records: () => [], modelFacts: () => ({ effective: crewmate.local.model }) } }, { name }, name, { args })
      await call(onDone, context, args).catch(failDialog)
    }
    const compactCmd = { name: 'compact', userFacingName: () => 'compact' }
  `

  const corrupt = runScenario(`
    ${setup}
    const torn = '{"agentType":"Explore","description":"keep me","worktreePath":"/keep/path"'
    fs.writeFileSync(file, torn, 'utf8')
    await command('effort', 'high')
    out.afterEffort = fs.readFileSync(file, 'utf8')
    out.sameAfterEffort = out.afterEffort === torn
    out.effortReceipts = receipts.splice(0)
    await runCrewmateCommand(compactCmd, '/compact', crewmate, io)
    out.sameAfterCompact = fs.readFileSync(file, 'utf8') === torn
    out.compactReceipts = receipts.splice(0)
    await command('model', '')
    out.pickerReceipts = receipts.splice(0)
  `)
  const effortReceipts = corrupt.effortReceipts as Array<{ text: string; color?: string }>
  const compactReceipts = corrupt.compactReceipts as Array<{ text: string; color?: string }>
  const pickerReceipts = corrupt.pickerReceipts as Array<{ text: string; color?: string }>
  check(
    'crewmate-corrupt-effort-no-overwrite',
    corrupt.sameAfterEffort === true &&
      effortReceipts.some(r => r.color === 'error' && r.text.includes('could not be read')),
    `same=${String(corrupt.sameAfterEffort)} receipts=${JSON.stringify(effortReceipts)}` + ' — change runCrewmateCommand in src/screen/composer/crewmateCommands.tsx so an unreadable or corrupt metadata file is left untouched and a warning receipt says it could not be read',
  )
  check(
    'crewmate-corrupt-compact-no-overwrite',
    corrupt.sameAfterCompact === true &&
      compactReceipts.some(r => r.color === 'warning' && r.text.includes('could not be read')),
    `same=${String(corrupt.sameAfterCompact)} receipts=${JSON.stringify(compactReceipts)}` + ' — change the compact path of runCrewmateCommand in src/screen/composer/crewmateCommands.tsx so an unreadable or corrupt metadata file is left untouched and a warning receipt says it could not be read',
  )
  check(
    'crewmate-corrupt-picker-warns',
    pickerReceipts.some(r => r.color === 'error' && r.text.includes('could not be read')),
    `receipts=${JSON.stringify(pickerReceipts)}` + ' — change crewmatePickerSeat in src/screen/composer/crewmateCommands.tsx so it gives a warning receipt saying the metadata could not be read',
  )

  if (!POSIX_MODES) {
    skip('crewmate-eacces-no-overwrite', 'a mode-0200 file needs a POSIX process that is not root')
  } else {
    const eacces = runScenario(`
      ${setup}
      const saved = JSON.stringify({ agentType: 'Explore', description: 'precious', model: 'claude-sonnet-4-6' })
      fs.writeFileSync(file, saved, { mode: 0o600 })
      fs.chmodSync(file, 0o200)
      await command('effort', 'high')
      fs.chmodSync(file, 0o600)
      out.same = fs.readFileSync(file, 'utf8') === saved
      out.receipts = receipts
    `)
    const receipts = eacces.receipts as Array<{ text: string; color?: string }>
    check(
      'crewmate-eacces-no-overwrite',
      eacces.same === true &&
        receipts.some(r => r.color === 'error' && r.text.includes('could not be read')),
      `same=${String(eacces.same)} receipts=${JSON.stringify(receipts)}` + ' — change runCrewmateCommand in src/screen/composer/crewmateCommands.tsx so a metadata file it cannot read (EACCES) is left untouched and a warning receipt says it could not be read',
    )
  }

  const absent = runScenario(`
    ${setup}
    await command('effort', 'high')
    out.exists = fs.existsSync(file)
    out.parsed = out.exists ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    out.receipts = receipts
  `)
  const parsed = absent.parsed as { agentType?: string; effortOverride?: string } | null
  check(
    'crewmate-absent-control-writes',
    absent.exists === true && parsed?.agentType === 'Explore' && parsed?.effortOverride === 'high',
    `parsed=${JSON.stringify(parsed)} receipts=${JSON.stringify(absent.receipts)}` + ' — change runCrewmateCommand in src/screen/composer/crewmateCommands.tsx so an absent metadata file is created with the agent type and the effort override',
  )
}

console.log('\nbootLogins/runs.ts:40,43 — postLoginSettleOf keeps bypass permissions on and says so when the policy check throws')
{
  const rejected = runScenario(`
    const { mock } = await import('bun:test')
    const killswitchPath = ${JSON.stringify(join(SRC, 'permissions/rules/sovereignKillswitch.ts'))}
    mock.module(killswitchPath, () => ({
      resetSovereignCheck: () => {},
      checkAndDisableSovereignIfNeeded: async () => { throw new Error('killswitch probe failed') },
    }))
    const { postLoginSettleOf } = await import(${JSON.stringify(join(SRC, 'screen/boot-face/logins/runs.ts'))})
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
    'bootlogins-killswitch-reject-stays-on-and-says-so',
    rejected.mode === 'sovereign' &&
      rejected.available === true &&
      rejected.authVersion === 1 &&
      rejectedNotice?.key === 'bypass-killswitch' &&
      rejectedNotice?.color === 'warning' &&
      rejectedNotice?.text === "bypass permissions stays on: your organization's security policy could not be checked (killswitch probe failed)",
    `mode=${String(rejected.mode)} available=${String(rejected.available)} notice=${JSON.stringify(rejectedNotice)}` + ' — change postLoginSettleOf in src/screen/boot-face/logins/runs.ts so a throwing policy check keeps bypass permissions on and posts the bypass-killswitch warning with the exact text this check expects',
  )

  const outerThrow = runScenario(`
    const { mock } = await import('bun:test')
    const userPath = ${JSON.stringify(join(SRC, 'platform/environment/user.ts'))}
    mock.module(userPath, () => ({
      resetUserCache: () => { throw new Error('user cache reset failed') },
    }))
    const { postLoginSettleOf } = await import(${JSON.stringify(join(SRC, 'screen/boot-face/logins/runs.ts'))})
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
    'bootlogins-settle-throw-changes-nothing',
    outerThrow.mode === 'sovereign' && outerThrow.available === true && outerNotice === null,
    `mode=${String(outerThrow.mode)} available=${String(outerThrow.available)} notice=${JSON.stringify(outerNotice)}` + ' — change postLoginSettleOf in src/screen/boot-face/logins/runs.ts so a throw in its settle step changes no mode and posts no notice',
  )
  const control = runScenario(`
    const { mock } = await import('bun:test')
    const killswitchPath = ${JSON.stringify(join(SRC, 'permissions/rules/sovereignKillswitch.ts'))}
    mock.module(killswitchPath, () => ({
      resetSovereignCheck: () => {},
      checkAndDisableSovereignIfNeeded: async () => {},
    }))
    const { postLoginSettleOf } = await import(${JSON.stringify(join(SRC, 'screen/boot-face/logins/runs.ts'))})
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
    `mode=${String(control.mode)} available=${String(control.available)} authVersion=${String(control.authVersion)}` + ' — change postLoginSettleOf in src/screen/boot-face/logins/runs.ts so a passing policy check keeps the mode and bumps authVersion once',
  )
}

console.log('\nWorktreeExitDialog.tsx:43,48 — failed directory restore reports the failure sentence instead of silent exit')
{
  const res = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'commands/exit/WorktreeExitDialog.tsx'))})
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
    JSON.stringify(res) + ' — change restoreWorktreeDirectories in src/commands/exit/WorktreeExitDialog.tsx so a failed chdir returns the Could not return to sentence and still calls setCwd',
  )
  check(
    'worktree-exit-setcwd-fail-reports-sentence',
    res.missing !== true &&
      res.setCwdFail === 'Could not return to /repo/main (EACCES: permission denied) — switch back to that folder before continuing.',
    JSON.stringify(res) + ' — change restoreWorktreeDirectories in src/commands/exit/WorktreeExitDialog.tsx so a failed setCwd returns the Could not return to sentence',
  )
  check(
    'worktree-exit-restore-ok-silent',
    res.missing !== true && res.ok === null,
    JSON.stringify(res) + ' — change restoreWorktreeDirectories in src/commands/exit/WorktreeExitDialog.tsx so a clean restore returns null',
  )
}

console.log('\nstudioEditorModel.ts:291 — buildReviewFacts reports unreadable existing agent file with advice visible at panel width')
{
  const res = runScenario(`
    const React = await import('react')
    const { decodeAgentDocument } = await import(${JSON.stringify(join(SRC, 'crew/agents/codec.ts'))})
    const { buildReviewFacts } = await import(${JSON.stringify(join(SRC, 'screen/agents/studio/studioEditorModel.ts'))})
    const { studioReviewView } = await import(${JSON.stringify(join(SRC, 'screen/agents/studio/studioEditorView.tsx'))})
    const { ThemeProvider } = await import(${JSON.stringify(join(SRC, 'screen/theme/ThemeProvider.tsx'))})
    const { mountOffscreen, settle } = await import(${JSON.stringify(join(HERE, '../lib/settingsPopupHarness.ts'))})
    const raw = '---\\nname: scout\\ndescription: Checks code carefully\\n---\\nInspect files thoroughly.\\n'
    const doc = decodeAgentDocument(raw, '/repo/.mercury/agents/scout.md')
    const base = { identity: { filePath: '/repo/.mercury/agents/scout.md', revision: 'rev-1' }, agent: {} }
    out.unread = buildReviewFacts(doc, base, () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    out.readable = buildReviewFacts(doc, base, () => raw)
    const posix = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
    out.posix = posix
    if (posix) {
      const lockedDir = path.join(process.cwd(), 'some-long-project-folder', 'nested-subpath', '.mercury', 'agents')
      fs.mkdirSync(lockedDir, { recursive: true })
      const lockedFile = path.join(lockedDir, 'potluck-checker.md')
      fs.writeFileSync(lockedFile, raw, 'utf8')
      fs.chmodSync(lockedFile, 0o000)
      try {
        const lockedBase = { identity: { filePath: lockedFile, revision: 'rev-1' }, agent: {} }
        const view = studioReviewView({
          doc,
          base: lockedBase,
          header: null,
          destinationPath: lockedFile,
          effective: { model: 'claude-sonnet-5-5', effort: { label: 'high', supportsEffort: true }, tools: { readOnly: false, hasWildcard: true, validTools: [], invalidTools: [] } },
          validation: { errors: [], warnings: [], canSave: true },
        })
        const m = await mountOffscreen(React.createElement(ThemeProvider, {}, view), 80, 18)
        await settle(80)
        out.painted = m.screen()
        m.unmount()
      } finally {
        fs.chmodSync(lockedFile, 0o644)
      }
    }
  `)
  const unread = res.unread as { changed: string[]; diffLines: string[] }
  const readable = res.readable as { changed: string[]; diffLines: string[] }
  check(
    'studio-review-unreadable-base-sentence',
    unread.diffLines.length === 1 &&
      unread.diffLines[0] === 'Could not read existing agent file — check permissions before saving (EACCES: permission denied).' &&
      !unread.diffLines.some(l => l.startsWith('+')) &&
      unread.changed.join(',') === '(existing file unreadable)',
    JSON.stringify(unread) + ' — change buildReviewFacts in src/screen/agents/studio/studioEditorModel.ts so an unreadable existing file gives the single advice line and the (existing file unreadable) change entry',
  )
  if (res.posix === true) {
    const painted = String(res.painted ?? '')
    check(
      'studio-review-unreadable-base-advice-visible-at-panel-width',
      painted.includes('Could not read existing agent file — check permissions before saving'),
      painted.slice(0, 500) + ' — change studioReviewView in src/screen/agents/studio/studioEditorView.tsx so the unreadable-file advice shows in full at 80 columns',
    )
  }
  check(
    'studio-review-readable-base-control',
    readable.changed.length === 0 && readable.diffLines.length === 0,
    JSON.stringify(readable) + ' — change buildReviewFacts in src/screen/agents/studio/studioEditorModel.ts so a readable existing file gives no advice line and no change entry',
  )
}

console.log('\nstudioEditorModel.ts:457 — opening an unreadable agent file surfaces the advice note instead of opening silent')
{
  const res = runScenario(`
    const { createStudioEditorMachine } = await import(${JSON.stringify(join(SRC, 'screen/agents/studio/studioEditorModel.ts'))})
    const raw = '---\\nname: scout\\ndescription: Checks code carefully\\n---\\nInspect files thoroughly.\\n'
    const base = { identity: { filePath: '/repo/.mercury/agents/scout.md', revision: 'rev-1' }, agent: { agentType: 'scout' } }
    const unreadMachine = createStudioEditorMachine(
      {
        mode: 'edit',
        base,
        cwd: process.cwd(),
        getExistingAgents: () => [],
        getParentModel: () => 'claude-sonnet-5-5',
        onSaved: () => {},
        onCancel: () => {},
      },
      () => {},
      {
        readFile: () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        },
        listDrafts: () => [],
      },
    )
    out.unreadNote = unreadMachine.snapshot().note
    unreadMachine.dispose()
    const okMachine = createStudioEditorMachine(
      {
        mode: 'edit',
        base,
        cwd: process.cwd(),
        getExistingAgents: () => [],
        getParentModel: () => 'claude-sonnet-5-5',
        onSaved: () => {},
        onCancel: () => {},
      },
      () => {},
      {
        readFile: () => raw,
        listDrafts: () => [],
      },
    )
    out.okNote = okMachine.snapshot().note
    out.okName = okMachine.snapshot().doc.fields.name
    okMachine.dispose()
  `)
  const unreadNote = res.unreadNote as { text?: string; tone?: string } | null
  check(
    'studio-open-unreadable-base-sets-note',
    unreadNote !== null &&
      unreadNote.text === 'Could not read existing agent file — check permissions before saving (EACCES: permission denied).',
    JSON.stringify(unreadNote) + ' — change createStudioEditorMachine in src/screen/agents/studio/studioEditorModel.ts so an unreadable existing file sets the advice note on the first snapshot',
  )
  check(
    'studio-open-readable-base-control',
    res.okNote === null && res.okName === 'scout',
    JSON.stringify({ okNote: res.okNote, okName: res.okName }) + ' — change createStudioEditorMachine in src/screen/agents/studio/studioEditorModel.ts so a readable existing file sets no note and loads the agent name',
  )
}

console.log('\nConcourseRoute.tsx:181 — failed project ground switch notifies strip:composer instead of silent drop')
{
  const res = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/concourse/ConcourseRoute.tsx'))})
    if (typeof mod.applySeedProjectGround !== 'function') {
      out.missing = true
    } else {
      const notes = []
      const noteControl = (control, state) => notes.push({ control, state })
      await mod.applySeedProjectGround('/repo/next', noteControl, async () => {
        throw new Error('EACCES: permission denied')
      })
      out.rejectNote = notes.splice(0)
      await mod.applySeedProjectGround('/repo/next', noteControl, async () => '/repo/old')
      out.stayedNote = notes.splice(0)
      await mod.applySeedProjectGround('/repo/next', noteControl, async dir => dir)
      out.okNote = notes.splice(0)
    }
  `)
  const rejectNote = res.rejectNote as Array<{ control: string; state: { state?: string; reason?: string } }> | undefined
  const stayedNote = res.stayedNote as Array<{ control: string; state: { state?: string; reason?: string } }> | undefined
  const okNote = res.okNote as Array<unknown> | undefined
  check(
    'concourse-route-ground-reject-sentence',
    res.missing !== true &&
      rejectNote?.length === 1 &&
      rejectNote[0]?.control === 'strip:composer' &&
      rejectNote[0]?.state.state === 'failed' &&
      rejectNote[0]?.state.reason === 'Could not switch to /repo/next (EACCES: permission denied) — pick the repo again.',
    JSON.stringify(res) + ' — change applySeedProjectGround in src/screen/concourse/ConcourseRoute.tsx so a rejected ground switch notes strip:composer as failed with the Could not switch to sentence',
  )
  check(
    'concourse-route-ground-stayed-sentence',
    res.missing !== true &&
      stayedNote?.length === 1 &&
      stayedNote[0]?.control === 'strip:composer' &&
      stayedNote[0]?.state.state === 'failed' &&
      stayedNote[0]?.state.reason === 'Could not switch to /repo/next — stayed in /repo/old; pick the repo again.',
    JSON.stringify(res) + ' — change applySeedProjectGround in src/screen/concourse/ConcourseRoute.tsx so a switch that stays in the old folder notes strip:composer as failed with the stayed in sentence',
  )
  check(
    'concourse-route-ground-ok-silent',
    res.missing !== true && okNote?.length === 0,
    JSON.stringify(res) + ' — change applySeedProjectGround in src/screen/concourse/ConcourseRoute.tsx so a successful switch notes nothing',
  )
}

console.log('\nobligationControls.ts:134 — failed claimObligation reports failure note to strip:composer')
{
  const res = runScenario(`
    const { mock } = await import('bun:test')
    const oblPath = ${JSON.stringify(join(SRC, 'crew/crewmates/obligations.ts'))}
    mock.module(oblPath, () => ({
      resolveObligation: async () => ({ settled: true, status: 'withdrawn' }),
      redirectObligation: async () => { throw new Error('EACCES: permission denied') },
    }))
    const { claimObligation } = await import(${JSON.stringify(join(SRC, 'screen/concourse/route/obligationControls.ts'))})
    const notes = []
    let refreshed = 0
    claimObligation(
      {
        noteControl: (control, state) => notes.push({ control, state }),
        refresh: () => { refreshed += 1 },
      },
      'obl-1',
    )
    await new Promise(resolve => setTimeout(resolve, 60))
    out.notes = notes
    out.refreshed = refreshed
  `)
  const notes = res.notes as Array<{ control: string; state: { state?: string; reason?: string; next?: string } }>
  check(
    'obligation-claim-fail-reports-note',
    notes.length === 1 &&
      notes[0]?.control === 'strip:composer' &&
      notes[0]?.state.state === 'failed' &&
      notes[0]?.state.reason === 'the claim failed (EACCES: permission denied)' &&
      notes[0]?.state.next === 'try claiming again' &&
      res.refreshed === 1,
    JSON.stringify(res) + ' — change claimObligation in src/screen/concourse/route/obligationControls.ts so a failed claim notes strip:composer as failed with the reason and next text this check expects, then refreshes once',
  )
}

console.log('\nworkerTranscriptFold.ts:147 — unreadable worker transcript surfaces readError instead of silent empty fold')
{
  if (!POSIX_MODES) {
    skip('worker-transcript-eacces-surfaces-error', 'a mode-0200 file needs a POSIX process that is not root')
  } else {
    const res = runScenario(`
      const mod = await import(${JSON.stringify(join(SRC, 'screen/concourse/workerTranscriptFold.ts'))})
      const wt = await import(${JSON.stringify(join(SRC, 'screen/concourse-model/workerTranscript.ts'))})
      if (typeof mod.openInitialWorkerTranscript !== 'function') {
        out.missing = true
      } else {
        const unreadable = path.join(process.cwd(), 'seat.jsonl')
        fs.writeFileSync(unreadable, '{"schemaVersion":1,"payload":{}}\\n', { mode: 0o600 })
        fs.chmodSync(unreadable, 0o200)
        out.eacces = mod.openInitialWorkerTranscript(unreadable, wt.openWorkerTranscript)
        fs.chmodSync(unreadable, 0o600)
        out.absent = mod.openInitialWorkerTranscript(path.join(process.cwd(), 'missing.jsonl'), wt.openWorkerTranscript)
      }
    `)
    const eacces = res.eacces as { ok: boolean; error?: string } | undefined
    const absent = res.absent as { ok: boolean; result?: { records: unknown[] } } | undefined
    check(
      'worker-transcript-eacces-surfaces-error',
      res.missing !== true &&
        eacces?.ok === false &&
        typeof eacces.error === 'string' &&
        /EACCES|permission denied/i.test(eacces.error),
      JSON.stringify(res) + ' — change openInitialWorkerTranscript in src/screen/concourse/workerTranscriptFold.ts so an unreadable transcript returns ok false with the read error',
    )
    check(
      'worker-transcript-absent-control-ok',
      res.missing !== true && absent?.ok === true && absent.result?.records.length === 0,
      JSON.stringify(res) + ' — change openInitialWorkerTranscript in src/screen/concourse/workerTranscriptFold.ts so an absent transcript returns ok true with no records',
    )
  }
}

console.log('\nSessionMirror.tsx:63 — unreadable receipts and transcript errors surface mirror failure notes')
{
  const res = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/concourse/SessionMirror.tsx'))})
    if (typeof mod.readMirrorReceipts !== 'function' || typeof mod.mirrorStatusNote !== 'function') {
      out.missing = true
    } else {
      const { getProjectDir } = await import(${JSON.stringify(join(SRC, 'sessions/transcripts/paths.ts'))})
      const dir = getProjectDir(process.cwd())
      fs.mkdirSync(dir, { recursive: true })
      const receiptsPath = path.join(dir, 'sess-eacces.receipts.jsonl')
      fs.writeFileSync(receiptsPath, '{"at":"2026-01-01T00:00:00Z","by":"operator","kind":"contract-close","summary":"done"}\\n', { mode: 0o600 })
      const posix = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
      if (posix) {
        fs.chmodSync(receiptsPath, 0o200)
        out.eaccesReceipts = mod.readMirrorReceipts(process.cwd(), 'sess-eacces')
        fs.chmodSync(receiptsPath, 0o600)
      } else {
        out.eaccesReceipts = mod.readMirrorReceipts(process.cwd(), 'sess-eacces', () => {
          throw new Error('EACCES: permission denied')
        })
      }
      out.absentReceipts = mod.readMirrorReceipts(process.cwd(), 'sess-absent')
      out.receiptsNote = mod.mirrorStatusNote(undefined, null, out.eaccesReceipts.error)
      out.transcriptNote = mod.mirrorStatusNote(undefined, 'EACCES: permission denied', null)
      out.cleanNote = mod.mirrorStatusNote(undefined, null, null)
    }
  `)
  const eaccesReceipts = res.eaccesReceipts as { entries: unknown[]; error: string | null } | undefined
  const absentReceipts = res.absentReceipts as { entries: unknown[]; error: string | null } | undefined
  const receiptsNote = res.receiptsNote as { state?: string; reason?: string } | undefined
  const transcriptNote = res.transcriptNote as { state?: string; reason?: string } | undefined
  check(
    'session-mirror-unreadable-receipts-note',
    res.missing !== true &&
      eaccesReceipts?.entries.length === 0 &&
      typeof eaccesReceipts.error === 'string' &&
      receiptsNote?.state === 'failed' &&
      receiptsNote.reason === `Could not read receipts (${eaccesReceipts.error}) — check permissions.`,
    JSON.stringify(res) + ' — change readMirrorReceipts and mirrorStatusNote in src/screen/concourse/SessionMirror.tsx so unreadable receipts return an error and a failed note naming it',
  )
  check(
    'session-mirror-unreadable-transcript-note',
    res.missing !== true &&
      transcriptNote?.state === 'failed' &&
      transcriptNote.reason === 'Could not read transcript (EACCES: permission denied) — check permissions.',
    JSON.stringify(res) + ' — change mirrorStatusNote in src/screen/concourse/SessionMirror.tsx so a transcript error gives a failed note with the Could not read transcript sentence',
  )
  check(
    'session-mirror-absent-receipts-control',
    res.missing !== true &&
      absentReceipts?.entries.length === 0 &&
      absentReceipts.error === null &&
      res.cleanNote === undefined,
    JSON.stringify(res) + ' — change readMirrorReceipts and mirrorStatusNote in src/screen/concourse/SessionMirror.tsx so absent receipts give no error and no note',
  )
}

console.log('\nextensions/bindings.ts:48 — corrupt or unreadable keybindings.json adds a declined note instead of silent default keys')
{
  const res = runScenario(`
    const { getKeybindingsPath } = await import(${JSON.stringify(join(SRC, 'screen/keys/loadUserBindings.ts'))})
    const { resolveExtensionsBindings } = await import(${JSON.stringify(join(SRC, 'screen/extensions/bindings.ts'))})
    const kbPath = getKeybindingsPath()
    const kbDir = path.dirname(kbPath)
    out.absent = resolveExtensionsBindings().declined
    fs.mkdirSync(kbDir, { recursive: true })
    fs.writeFileSync(kbPath, '{ broken json', 'utf8')
    const corrupt = resolveExtensionsBindings()
    out.corruptDeclined = corrupt.declined
    out.corruptHasDefault = corrupt.chars.get('extensions:install') === 'i'
    const posix = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)
    if (posix) {
      fs.writeFileSync(kbPath, '{"bindings":[]}', { mode: 0o600 })
      fs.chmodSync(kbPath, 0o200)
      out.eaccesDeclined = resolveExtensionsBindings().declined
      fs.chmodSync(kbPath, 0o600)
    }
    out.kbDir = kbDir
    out.posix = posix
  `)
  const corruptDeclined = res.corruptDeclined as string[]
  const eaccesDeclined = res.eaccesDeclined as string[] | undefined
  const kbDir = String(res.kbDir)
  check(
    'extensions-bindings-corrupt-declined-note',
    res.corruptHasDefault === true &&
      corruptDeclined.length === 1 &&
      corruptDeclined[0] === `keybindings.json could not be read (not valid JSON) — fix it in ${kbDir} to restore your keys`,
    JSON.stringify(corruptDeclined) + ' — change resolveExtensionsBindings in src/screen/extensions/bindings.ts so a corrupt keybindings.json adds one declined note naming the folder and keeps the default keys',
  )
  if (res.posix === true) {
    check(
      'extensions-bindings-eacces-declined-note',
      Array.isArray(eaccesDeclined) &&
        eaccesDeclined.length === 1 &&
        eaccesDeclined[0]!.startsWith('keybindings.json could not be read (') &&
        eaccesDeclined[0]!.endsWith(`) — fix it in ${kbDir} to restore your keys`),
      JSON.stringify(eaccesDeclined) + ' — change resolveExtensionsBindings in src/screen/extensions/bindings.ts so an unreadable keybindings.json adds one declined note naming the folder',
    )
  }
  check(
    'extensions-bindings-absent-control-empty',
    Array.isArray(res.absent) && (res.absent as string[]).length === 0,
    JSON.stringify(res.absent) + ' — change resolveExtensionsBindings in src/screen/extensions/bindings.ts so an absent keybindings.json adds no declined note',
  )
}

console.log('\nMemoryFileSelector.tsx:191 — failed memory folder creation skips openPath and returns failure sentence')
{
  const res = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/memory/InstructionFileSelector.tsx'))})
    const { toTildePath } = await import(${JSON.stringify(join(SRC, 'platform/files/path.ts'))})
    if (typeof mod.openMemoryFolder !== 'function') {
      out.missing = true
    } else {
      const blocker = path.join(process.cwd(), 'not-a-dir')
      fs.writeFileSync(blocker, 'file', 'utf8')
      const badDir = path.join(blocker, 'memory')
      let openedBad = false
      out.badNote = mod.openMemoryFolder(badDir, {
        mkdirSync: fs.mkdirSync,
        openPath: async () => { openedBad = true; return true },
      })
      out.openedBad = openedBad
      out.badDisplay = toTildePath(badDir)

      const goodDir = path.join(process.cwd(), 'ok-memory')
      let openedGood = null
      out.goodNote = mod.openMemoryFolder(goodDir, {
        mkdirSync: fs.mkdirSync,
        openPath: async p => { openedGood = p; return true },
      })
      out.openedGood = openedGood
      out.goodExists = fs.existsSync(goodDir)
      out.goodDir = goodDir
    }
  `)
  check(
    'memory-selector-mkdir-fail-sentence',
    res.missing !== true &&
      res.openedBad === false &&
      typeof res.badNote === 'string' &&
      res.badNote.startsWith(`Could not open the memory folder at ${String(res.badDisplay)} (`) &&
      res.badNote.endsWith(') — check folder permissions.'),
    JSON.stringify(res) + ' — change openMemoryFolder in src/screen/memory/InstructionFileSelector.tsx so a failed mkdir skips openPath and returns the Could not open the memory folder sentence',
  )
  check(
    'memory-selector-mkdir-ok-control',
    res.missing !== true &&
      res.goodNote === null &&
      res.goodExists === true &&
      res.openedGood === res.goodDir,
    JSON.stringify(res) + ' — change openMemoryFolder in src/screen/memory/InstructionFileSelector.tsx so a good folder is created, opened and returns null',
  )
}

console.log('\nmemory/centre/actions.ts:63 — a pin whose write is refused does not throw out of the key handler')
{
  const res = runScenario(`
    const usage = await import(${JSON.stringify(join(SRC, 'sessions/mneme/mnemeUsage.ts'))})
    const actions = await import(${JSON.stringify(join(SRC, 'screen/memory/centre/actions.ts'))})
    const file = usage.pinsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json')
    const notes = []
    let reloads = 0
    const fl = { busyRef: { current: false }, setNote: note => { notes.push(note) }, reload: () => { reloads++ } }
    out.threw = null
    try {
      actions.togglePinOf({ fl }, 7, true)
    } catch (error) {
      out.threw = String(error)
    }
    out.notes = notes
    out.busy = fl.busyRef.current
    out.reloads = reloads
    out.same = fs.readFileSync(file, 'utf8') === '{ not json'
  `)
  const notes = (res.notes as Array<{ text?: string; kind?: string }> | undefined) ?? []
  check('memory-centre-pin-refused-no-throw', res.threw === null, JSON.stringify(res) + ' — change togglePinOf in src/screen/memory/centre/actions.ts so a refused pin write is caught and does not throw out of the key handler')
  check('memory-centre-pin-refused-note', notes.length === 1 && notes[0]?.kind === 'fail' && String(notes[0]?.text).includes('pin failed:'), JSON.stringify(res) + ' — change togglePinOf in src/screen/memory/centre/actions.ts so a refused pin write sets one fail note whose text contains pin failed:')
  check('memory-centre-pin-refused-not-busy', res.busy === false && res.reloads === 1 && res.same === true, JSON.stringify(res) + ' — change togglePinOf in src/screen/memory/centre/actions.ts so a refused pin write clears busy, reloads once and leaves the pins file as it was')
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
