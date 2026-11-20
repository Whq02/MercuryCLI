#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'prove-faults-fn10-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn()
    return null
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

try {
  console.log('1. src/services/concourse/projectActivity.ts')
  {
    const { runningByProjectKey } = await import('../../src/services/concourse/projectActivity.ts')
    const absentDir = join(SCRATCH, 'pa-absent')
    mkdirSync(absentDir, { recursive: true })
    const absentMap = await runningByProjectKey(absentDir)
    check('projectActivity.runningByProjectKey absent records file returns empty map', absentMap.size === 0)

    const corruptDir = join(SCRATCH, 'pa-corrupt')
    mkdirSync(corruptDir, { recursive: true })
    writeFileSync(join(corruptDir, 'concourse-workers.json'), '{not-json')
    const corruptErr = await rejects(() => runningByProjectKey(corruptDir))
    check('projectActivity.runningByProjectKey rejects on corrupt records file', corruptErr !== null, 'returned empty map instead of rejecting')

    if (POSIX_MODES) {
      const unreadableDir = join(SCRATCH, 'pa-unreadable')
      mkdirSync(unreadableDir, { recursive: true })
      const file = join(unreadableDir, 'concourse-workers.json')
      writeFileSync(file, JSON.stringify({ version: 1, workers: {} }))
      chmodSync(file, 0o200)
      const permErr = await rejects(() => runningByProjectKey(unreadableDir))
      chmodSync(file, 0o600)
      check('projectActivity.runningByProjectKey rejects on unreadable records file', permErr !== null, 'returned empty map instead of rejecting')
    }
  }

  console.log('2. src/services/concourse/sessionTitleMint.ts')
  {
    const { transcriptHeadFacts } = await import('../../src/services/concourse/sessionTitleMint.ts')
    const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
    const workspaceId = join(SCRATCH, 'ws-title')
    mkdirSync(workspaceId, { recursive: true })
    const absent = transcriptHeadFacts({ sessionId: 'absent-session', workspaceId })
    check('sessionTitleMint.transcriptHeadFacts absent transcript returns zero turns', absent.assistantTurns === 0 && absent.description === '')

    if (POSIX_MODES) {
      const rec = { sessionId: 'unreadable-session', workspaceId }
      const file = workerTranscriptPath(rec)
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, '{}\n')
      chmodSync(file, 0o200)
      let threw: unknown = null
      try {
        transcriptHeadFacts(rec)
      } catch (error) {
        threw = error
      } finally {
        chmodSync(file, 0o600)
      }
      check('sessionTitleMint.transcriptHeadFacts throws on unreadable transcript', threw !== null, 'returned zero turns on EACCES')
    }
  }

  console.log('3. src/services/concourse/workerModels.ts')
  {
    const { validateWorkerModelChoice } = await import('../../src/services/concourse/workerModels.ts')
    const prevCompatUrl = process.env.MERCURY_COMPAT_BASE_URL
    process.env.MERCURY_COMPAT_BASE_URL = 'not-a-url'
    try {
      const verdict = await validateWorkerModelChoice('openai-compat', 'session', { modelOptions: () => [] })
      check(
        'workerModels.compatReaderFor refuses with compat error instead of false no-credential',
        !verdict.ok && verdict.reason === 'not-runnable:compat-error' && (verdict.detail ?? '').includes('compatProvider'),
        JSON.stringify(verdict),
      )
    } finally {
      if (prevCompatUrl === undefined) delete process.env.MERCURY_COMPAT_BASE_URL
      else process.env.MERCURY_COMPAT_BASE_URL = prevCompatUrl
    }
  }

  console.log('4. src/services/crew/dispatch.ts')
  {
    const { spawnSync } = await import('node:child_process')
    const dir = join(SCRATCH, 'crew-dispatch')
    mkdirSync(dir, { recursive: true })
    const script = `
      import { mock } from 'bun:test'
      process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(HOME)}
      process.env.NODE_ENV = 'test'
      delete process.env.MERCURY_HOME
      globalThis.MACRO = { VERSION: '1.0.0' }
      mock.module(${JSON.stringify(join(import.meta.dir, '../../src/services/crew/conversations.ts'))}, () => ({
        appendConversationEvent: async () => { throw new Error('injected conversation store failure') },
        resolveEventByRef: async () => { throw new Error('injected conversation store failure') },
        upsertUnresolvedEvent: async () => { throw new Error('injected conversation store failure') },
      }))
      const { dispatchToAgent } = await import(${JSON.stringify(join(import.meta.dir, '../../src/services/crew/dispatch.ts'))})
      const { openObligations } = await import(${JSON.stringify(join(import.meta.dir, '../../src/services/crew/obligations.ts'))})
      const dir = ${JSON.stringify(dir)}
      const receipt = await dispatchToAgent({
        clientMessageId: 'dispatch-iso-1',
        sourceConversationId: 'cv-iso-1',
        requestedAddress: { agentId: 'cw-absent' },
        requestedDisposition: 'hold-next',
        instruction: 'check isolation',
        attachments: [],
      }, { dir })
      const open = await openObligations({ scope: 'switchboard', dir })
      process.stdout.write('\\n' + JSON.stringify({ state: receipt.state, recorded: open.some(o => o.ref === 'receipt:dispatch-iso-1') }))
    `
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    const out = res.status === 0 ? JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') : { error: res.stderr.slice(-400) }
    check(
      'dispatch.runDispatchTransaction records retry-or-withdraw obligation even when conversation store fails',
      out.state === 'not-delivered' && out.recorded === true,
      JSON.stringify(out),
    )
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
