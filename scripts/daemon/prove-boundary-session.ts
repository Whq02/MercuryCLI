import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { ConcourseDispatchRequest } from '../../src/daemon/concourseDispatch.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const childAt = process.argv.indexOf('--child')
if (childAt !== -1) {
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { makeConcourseDispatchHandler, readConcourseDispatches, replayGitBlockedDispatches, flushDeferredDispatchPublishes, envelopeDigestOf, concourseDispatchesPath } = await import('../../src/daemon/concourseDispatch.ts')
  const dir = join(process.env.MERCURY_CONFIG_DIR!, 'daemon')
  const workspace = join(process.env.MERCURY_CONFIG_DIR!, 'workspace')
  const admissions: unknown[] = []
  const deliveries: unknown[] = []
  const seeding = process.argv[childAt + 1] === 'seed'
  const dispatch = makeConcourseDispatchHandler({
    dir,
    admit: async request => {
      if (seeding) return { ok: false, code: 'git-unavailable', error: 'fixture git not ready' }
      admissions.push(request)
      return { ok: true, runnerId: 'boundary-runner-' + admissions.length, sessionId: 'boundary-session-' + admissions.length, workspaceId: workspace }
    },
    deliver: async (_runner, row) => { deliveries.push(row); return true },
  })
  if (seeding) {
    const requests = JSON.parse(readFileSync(0, 'utf8')) as ConcourseDispatchRequest[]
    const results = []
    for (const request of requests) results.push(await dispatch(request))
    const records = readConcourseDispatches(dir)
    const legacyRequest = requests.find(row => row.clientMessageId === 'legacy')!
    const legacy = records.legacy!
    legacy.envelopeDigest = envelopeDigestOf(legacyRequest, 1)
    delete legacy.envelopeVersion
    writeFileSync(concourseDispatchesPath(dir), JSON.stringify({ version: 1, dispatches: records }))
    console.log(JSON.stringify({ results, records }))
  } else {
    const pending = readConcourseDispatches(dir).plain!.heldOp!
    const edited = await dispatch({ ...pending, isolation: pending.isolation as ConcourseDispatchRequest['isolation'], permissionMode: pending.permissionMode as ConcourseDispatchRequest['permissionMode'], clientMessageId: 'plain', kitPreset: 'unasked-preset' })
    const results = await replayGitBlockedDispatches(workspace, dispatch, dir)
    await flushDeferredDispatchPublishes()
    const again = await replayGitBlockedDispatches(workspace, dispatch, dir)
    console.log(JSON.stringify({ edited, results, admissions, deliveries, again, records: readConcourseDispatches(dir) }))
  }
} else {
  const outerHome = process.env.MERCURY_CONFIG_DIR
  mkdirSync(outerHome, { recursive: true })
  const home = mkdtempSync(join(outerHome, 'session-boundary-'))
  const workspace = join(home, 'workspace')
  mkdirSync(workspace)
  mkdirSync(join(home, 'daemon'))
  process.env.MERCURY_CONFIG_DIR = home
  process.env.HOME = home
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  delete process.env.MERCURY_HOME
  const { envelopeDigestOf } = await import('../../src/daemon/concourseDispatch.ts')
  let checks = 0
  let failures = 0
  const check = (name: string, truth: unknown, detail?: unknown) => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ' — ' + JSON.stringify(detail) : '')) }
  const child = async (mode: string, requests?: unknown) => {
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', mode], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let errors = ''
    worker.stdout.on('data', chunk => { output += chunk })
    worker.stderr.on('data', chunk => { errors += chunk })
    worker.stdin.end(JSON.stringify(requests ?? null))
    const timer = setTimeout(() => worker.kill('SIGTERM'), 15000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => { worker.once('error', reject); worker.once('close', resolve) })
      assert.equal(code, 0, errors)
      return JSON.parse(output.trim().split('\n').at(-1)!)
    } finally { clearTimeout(timer) }
  }
  try {
    const sentAt = '2026-10-22T20:00:00.000Z'
    const origin = { kind: 'saturn' as const, fire: 'wake' as const, firedAt: sentAt, scheduleId: 'boundary-wake', spelling: 'in ~60s', reason: 'preserve queued context' }
    const base = { workspaceDir: workspace, modelKey: 'compat/boundary/Fixture/Reasoner', effort: 'max', isolation: 'shared' as const, permissionMode: 'default' as const, runnerArgv: ['--brief-add', 'fixture session brief'] }
    const kit = { schema: 1 as const, mcp: ['fixture_mcp'], skills: ['fixture-skill'], invocable: ['fixture-manual'], extensions: { fixture: 'off' as const } }
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH2QAAAAASUVORK5CYII=' } }
    const requests: ConcourseDispatchRequest[] = [
      { ...base, clientMessageId: 'plain', prompt: 'plain queued task' },
      { ...base, clientMessageId: 'legacy', prompt: 'older queued task' },
      { ...base, clientMessageId: 'shell', prompt: 'printf boundary', mode: 'bash', priority: 'later', sentAt, origin },
      { ...base, clientMessageId: 'rich', prompt: 'read this image', content: [{ type: 'text', text: 'image context' }, image], priority: 'next', sentAt },
      { ...base, clientMessageId: 'kit', prompt: 'use the selected tools', kit, bypassConsent: true, birthKey: 'boundary-birth', bornBlank: true, vacatingSessionId: 'old-session', restartReason: 'update' },
      { ...base, clientMessageId: 'preset', prompt: 'use the selected preset', kitPreset: 'fixture-preset' },
      { ...base, clientMessageId: 'note', prompt: 'addressed guidance', mode: 'task-notification', agentId: 'fixture-crew' },
    ]
    const seeded = await child('seed', requests)
    check('the first process durably holds every launch without starting it', seeded.results.length === requests.length && seeded.results.every((row: any) => row.state === 'queued' && row.heldReason === 'git-unavailable'))
    const replayed = await child('replay')
    check('the fresh process refuses an unasked preset under an existing message identity', replayed.edited.ok === false && replayed.edited.replay === 'edited-replay')
    check('older queued records keep their original digest grammar and still replay', replayed.results.some((row: any) => row.clientMessageId === 'legacy' && row.ok))
    check('a fresh process replays every saved launch without an edited-envelope refusal', replayed.results.length === requests.length && replayed.results.every((row: any) => row.ok), replayed.results)
    check('the resumed admissions retain the exact model, effort and runner arguments', replayed.admissions.length === requests.length && replayed.admissions.every((row: any) => row.modelKey === base.modelKey && row.effort === 'max' && isDeepStrictEqual(row.runnerArgv, base.runnerArgv)))
    const shell = replayed.deliveries.find((row: any) => row.type === 'shell')
    check('queued shell input remains shell input with its original priority, send time and origin', shell?.command === 'printf boundary' && shell.priority === 'later' && shell.sent_at === sentAt && isDeepStrictEqual(shell.origin, origin))
    const rich = replayed.deliveries.find((row: any) => Array.isArray(row.content))
    check('rich content reaches the far side with its image bytes and send time intact', rich?.sent_at === sentAt && rich.content.some((row: any) => row.type === 'image' && row.data === image.source.data))
    const admittedKit = replayed.admissions.find((row: any) => row.kit)
    check('the carried MCP/skill/extension kit and launch consent survive the wait', isDeepStrictEqual(admittedKit?.kit, kit) && admittedKit?.bypassConsent === true)
    check('birth and restart identity facts are retained, not defaulted by replay', admittedKit?.birthKey === 'boundary-birth' && admittedKit?.bornBlank === true && admittedKit?.restartReason === 'update')
    check('a held launch never reuses a stale seat-vacating hint to bypass admission', admittedKit !== undefined && admittedKit.vacatingSessionId === undefined && seeded.records.kit.heldOp.vacatingSessionId === 'old-session')
    check('the selected preset survives the wait', replayed.admissions.some((row: any) => row.kitPreset === 'fixture-preset'))
    check('addressed guidance remains addressed to its crewmate', replayed.deliveries.some((row: any) => row.type === 'note' && row.to === 'fixture-crew' && row.content === 'addressed guidance'))
    check('a replay consumes pending payloads and never delivers them twice', replayed.again.length === 0 && Object.values(replayed.records).every((row: any) => row.heldOp === undefined && row.heldReason === undefined))
    for (const [name, change] of Object.entries({ kit: { kit }, preset: { kitPreset: 'different' }, consent: { bypassConsent: true }, birth: { birthKey: 'different' }, restart: { restartReason: 'update' } })) {
      check(name + ' changes are material to a replay identity', envelopeDigestOf(requests[0]!) !== envelopeDigestOf({ ...requests[0]!, ...change } as ConcourseDispatchRequest))
    }
    console.log('BOUNDARY SESSION ' + (failures ? 'RED' : 'GREEN') + ' — ' + (checks - failures) + '/' + checks + '; two independent processes and the durable replay handler, no model calls')
  } finally { process.env.MERCURY_CONFIG_DIR = outerHome; rmSync(home, { recursive: true, force: true }) }
  process.exitCode = failures ? 1 : 0
}
