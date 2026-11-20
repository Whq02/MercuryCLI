#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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

function runSubprocess(
  body: string,
  opts?: { allowNonZero?: boolean },
): { status: number | null; stdout: string; stderr: string; out: Record<string, unknown> } {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn01-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n__OUT__' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (!opts?.allowNonZero && res.status !== 0) {
      throw new Error(`scenario exited ${res.status}: ${res.stderr.slice(-1200)}`)
    }
    const marker = res.stdout.lastIndexOf('__OUT__')
    const out = marker >= 0 ? (JSON.parse(res.stdout.slice(marker + 7).trim()) as Record<string, unknown>) : {}
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, out }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\nsessionsVerb.ts — unreadable projects dir or project store rejects instead of saying absent')
if (!POSIX_MODES) skip('sessionsVerb unreadable dirs', 'chmod 0000 needs non-root POSIX')
else {
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const paths = await import(path.join(SRC, 'utils/sessionStorage/paths.ts'))
    const verb = await import(path.join(SRC, 'cli/sessionsVerb.ts'))
    const sid = '11111111-1111-4111-8111-111111111111'
    const absentSid = '99999999-9999-4999-8999-999999999999'
    const projectsDir = paths.getProjectsDir()
    const store = paths.getProjectDir(PROJECT)
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(path.join(store, sid + '.jsonl'), '{"type":"user"}\\n')
    const runDelete = async id => {
      const errLines = []
      try {
        const rc = await verb.sessionsDeleteCli(id, { yes: true }, {
          out: () => {},
          err: line => errLines.push(line),
          interactive: false,
          ask: async () => false,
        })
        return { threw: null, rc, errLines }
      } catch (e) {
        return { threw: { code: e?.code ?? null, message: String(e?.message ?? e) }, rc: null, errLines }
      }
    }
    out.absentControl = await runDelete(absentSid)
    fs.chmodSync(projectsDir, 0o000)
    try {
      out.unreadableProjects = await runDelete(sid)
    } finally {
      fs.chmodSync(projectsDir, 0o700)
    }
    fs.chmodSync(store, 0o000)
    try {
      out.unreadableStore = await runDelete(sid)
    } finally {
      fs.chmodSync(store, 0o700)
    }
  `)
  const absent = r.out.absentControl as { threw: unknown; rc: number | null; errLines: string[] }
  const proj = r.out.unreadableProjects as { threw: { code: string | null } | null; rc: number | null; errLines: string[] }
  const store = r.out.unreadableStore as { threw: { code: string | null } | null; rc: number | null; errLines: string[] }
  check('sessionsVerb: absent session on readable store still returns rc 1', absent.threw === null && absent.rc === 1, JSON.stringify(absent))
  check('sessionsVerb: unreadable projects dir rejects with EACCES instead of saying absent', proj.threw?.code === 'EACCES' && proj.errLines.length === 0, JSON.stringify(proj))
  check('sessionsVerb: unreadable project store rejects with EACCES instead of saying absent', store.threw?.code === 'EACCES' && store.errLines.length === 0, JSON.stringify(store))
}

console.log('\nrestartCarry.ts — unreadable transcript and unstatable agent folder reject instead of faking empty/gone')
if (!POSIX_MODES) skip('restartCarry unreadable paths', 'chmod 0200/0000 needs non-root POSIX')
else {
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const state = await import(path.join(SRC, 'bootstrap/state.ts'))
    const paths = await import(path.join(SRC, 'utils/sessionStorage/paths.ts'))
    const carry = await import(path.join(SRC, 'cli/headless/restartCarry.ts'))
    const absentPath = path.join(HOME, 'missing-transcript.jsonl')
    const basePorts = (transcriptPath, messages = []) => ({
      reason: 'crash',
      messages,
      getAppState: () => ({ tasks: {} }),
      setAppState: () => {},
      canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
      relaunchContext: async () => { throw new Error('should not relaunch') },
      transcriptPath,
    })
    out.absentTranscript = await carry.carryRunnerAcrossRestart(basePorts(absentPath))
    const unreadableTranscript = path.join(HOME, 'unreadable-transcript.jsonl')
    fs.writeFileSync(unreadableTranscript, '{"type":"queue-operation"}\\n', { mode: 0o600 })
    fs.chmodSync(unreadableTranscript, 0o200)
    try {
      const res = await carry.carryRunnerAcrossRestart(basePorts(unreadableTranscript))
      out.unreadableTranscript = { threw: null, res }
    } catch (e) {
      out.unreadableTranscript = { threw: { code: e?.code ?? null, message: String(e?.message ?? e) }, res: null }
    } finally {
      fs.chmodSync(unreadableTranscript, 0o600)
    }
    const { AGENT_TOOL_NAME } = await import(path.join(SRC, 'tools/AgentTool/constants.ts'))
    const { BACKGROUND_LAUNCH_LINE } = await import(path.join(SRC, 'tasks/LocalAgentTask/launchReceipts.ts'))
    const agentId = 'a12345678'
    const launchMessages = [
      {
        type: 'assistant',
        uuid: 'u-launch',
        timestamp: '2026-11-20T00:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: AGENT_TOOL_NAME, input: { description: 'worker', prompt: 'go' } }] },
      },
      {
        type: 'user',
        uuid: 'u-receipt',
        timestamp: '2026-11-20T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: BACKGROUND_LAUNCH_LINE + '\\nagentId: ' + agentId }] },
      },
    ]
    const parentDir = path.join(HOME, 'locked-parent')
    const childDir = path.join(parentDir, 'worktree')
    fs.mkdirSync(childDir, { recursive: true })
    await paths.writeAgentMetadata(agentId, { agentType: 'general', worktreePath: childDir })
    fs.chmodSync(parentDir, 0o000)
    try {
      const res = await carry.carryRunnerAcrossRestart(basePorts(absentPath, launchMessages))
      out.unstatableFolder = { threw: null, res }
    } catch (e) {
      out.unstatableFolder = { threw: { code: e?.code ?? null, message: String(e?.message ?? e) }, res: null }
    } finally {
      fs.chmodSync(parentDir, 0o700)
    }
    await paths.writeAgentMetadata(agentId, { agentType: 'general', worktreePath: path.join(HOME, 'no-such-folder') })
    out.absentFolder = await carry.carryRunnerAcrossRestart(basePorts(absentPath, launchMessages))
  `)
  const absentT = r.out.absentTranscript as { requeued: number; stopped: number }
  const unreadT = r.out.unreadableTranscript as { threw: { code: string | null } | null }
  const unstatF = r.out.unstatableFolder as { threw: { code: string | null } | null; res: unknown }
  const absentF = r.out.absentFolder as { stopped: number; relaunched: number }
  check('restartCarry: absent transcript still answers zero requeued', absentT.requeued === 0 && absentT.stopped === 0, JSON.stringify(absentT))
  check('restartCarry: unreadable transcript rejects with EACCES', unreadT.threw?.code === 'EACCES', JSON.stringify(unreadT))
  check('restartCarry: unstatable agent folder rejects with EACCES instead of counting stopped', unstatF.threw?.code === 'EACCES', JSON.stringify(unstatF))
  check('restartCarry: genuinely absent agent folder still counts stopped', absentF.stopped === 1 && absentF.relaunched === 0, JSON.stringify(absentF))
}

console.log('\nclaimSession.ts — loadConversationForResume error reports resume failure instead of no conversation found')
{
  const r = runSubprocess(`
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { mock } = await import('bun:test')
    const loading = await import(path.join(SRC, 'utils/sessionStorage/loading.ts'))
    const sid = '33333333-3333-4333-8333-333333333333'
    const file = loading.sessionFilePath(sid)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{"type":"user"}\\n')
    const shutdownCodes = []
    const emitted = []
    mock.module(path.join(SRC, 'utils/conversationRecovery.js'), () => ({
      loadConversationForResume: async () => { throw new Error('disk read fault') },
    }))
    mock.module(path.join(SRC, 'utils/gracefulShutdown.js'), () => ({
      gracefulShutdownSync: code => { shutdownCodes.push(code) },
    }))
    mock.module(path.join(SRC, 'cli/headless/resume.js'), () => ({
      emitLoadError: message => { emitted.push(message) },
    }))
    const { claimSession } = await import(path.join(SRC, 'cli/headless/claimSession.ts'))
    const live = { awaitingSessionClaim: true, claimSettling: null, runnerRestartReason: null }
    const ports = {
      armSessionRunnerWiring: async () => {},
      driver: { kick: () => {} },
      enqueueRow: () => {},
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
      heldNoticeWaits: () => false,
      hydrateResumedRun: async () => {},
      live,
      liveMcp: { refresh: async () => {} },
      liveScope: () => ({ session_id: sid }),
      messages: [],
      options: { outputFormat: 'text' },
      peer: null,
      persistBootModelRefusal: async () => {},
      releaseQueueUntilClaimed: null,
      setAppState: () => {},
      settleClearBirth: () => {},
      settleSessionBriefs: () => {},
      wire: false,
    }
    await claimSession({ session_id: sid, resume: true }, ports)
    await live.claimSettling
    out.emitted = emitted
    out.shutdownCodes = shutdownCodes
  `)
  const emitted = r.out.emitted as string[]
  const codes = r.out.shutdownCodes as number[]
  check('claimSession: resume load throw reports Failed to resume session with the error message', emitted.length === 1 && emitted[0] === 'Failed to resume session: disk read fault' && codes[0] === 1, JSON.stringify({ emitted, codes }))
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
