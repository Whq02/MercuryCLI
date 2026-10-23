#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('Run with a scratch MERCURY_CONFIG_DIR')
delete process.env.MERCURY_HOME
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'dap-terminal-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
process.chdir(scratch)
process.env.HOME = scratch
process.env.USERPROFILE = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ fixture: { command: process.execPath, args: [join(import.meta.dir, 'mock-dap-terminal.mjs')] } })
const { DebugTool } = await import(join(SRC, 'tools/DebugTool/DebugTool.ts'))
const { getDapSession, removeDapSession } = await import(join(SRC, 'services/dap/dapClient.ts'))
const { processMainOwner } = await import(join(SRC, 'services/run/resolveOwner.ts'))
const { BashTool } = await import(join(SRC, 'tools/BashTool/BashTool.tsx'))
const { getEmptyToolPermissionContext } = await import(join(SRC, 'Tool.ts'))
const { engageToolGuard, clearGuards } = await import(join(SRC, 'guards/guards.ts'))
const owner = processMainOwner()
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ' ' + detail : ''}`) }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (test: () => boolean) => { const end = Date.now() + 5000; while (!test() && Date.now() < end) await Bun.sleep(10); return test() }
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} } }
const context = { owner, agentId: 'dap-terminal-fixture', abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], toolDecisions: new Map(), readFileState: new Map(), options: { tools: [BashTool], mcpClients: [], isNonInteractiveSession: true } }
const assistant = { uuid: 'dap-terminal-fixture', requestId: 'dap-terminal-fixture', message: { id: 'dap-terminal-fixture' } }
let denied = false
let decisions = 0
let seenCommand = ''
const permission = async (tool: any, input: any) => {
  decisions++
  seenCommand = input.command
  check('reverse request uses Bash permission identity', tool.name === BashTool.name)
  return denied ? { behavior: 'deny', message: 'fixture denied this debug command' } : { behavior: 'allow', updatedInput: input }
}
const call = (input: any) => DebugTool.call(input, context as never, permission as never, assistant as never)
const pids: number[] = []
try {
  const started = await call({ op: 'launch', adapter: 'fixture', program: 'fixture', stopOnEntry: true })
  check('fixture session launched', started.data.outcome === 'succeeded', started.data.result)
  const session = getDapSession(owner, 'main')!
  const caps = await session.request('mock/capabilities')
  check('client advertises runInTerminal support', caps.supportsRunInTerminalRequest === true)
  for (const kind of ['integrated', 'external']) {
    const command = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('DEBUGGEE '+process.pid+' CHILD '+c.pid+' '+process.cwd()+' '+process.env.DAP_FIXTURE+' '+String(process.env.DAP_UNSET)); console.error('DEBUGGEE STDERR'); setInterval(()=>{},1000)`
    process.env.DAP_UNSET = 'remove-me'
    const response = (await session.request('mock/terminal', { kind, args: ['node', '-e', command], cwd: scratch, env: { DAP_FIXTURE: 'literal $value', DAP_UNSET: null } })).response as any
    check(`${kind}: reverse request answered with real processId`, response.success === true && Number.isInteger(response.body?.processId), JSON.stringify(response))
    if (response.body?.processId) pids.push(response.body.processId)
    check(`${kind}: command reached the authority intact`, seenCommand.includes(command.replaceAll("'", "'\\''")) && seenCommand.includes(scratch), seenCommand)
    if (response.success) {
      await until(() => session.output.some((line: string) => line.includes('DEBUGGEE ') && line.includes(String(response.body.processId))))
      const line = session.output.find((line: string) => line.includes('DEBUGGEE ' + response.body.processId)) ?? ''
      const child = /CHILD (\d+)/.exec(line)
      if (child) pids.push(Number(child[1]))
      check(`${kind}: stdout carries cwd/env and child PID`, line.includes(scratch + ' literal $value undefined') && !!child, line)
      check(`${kind}: stderr captured and output identified as debuggee`, session.output.some((line: string) => line.includes('[debuggee] DEBUGGEE STDERR')), session.output.join('\n'))
    }
  }
  check('authority was consulted for both launches', decisions === 2, String(decisions))
  denied = true
  const count = typeof session.terminalProcessCount === 'function' ? session.terminalProcessCount() : -1
  const refused = (await session.request('mock/terminal', { kind: 'integrated', args: ['node', '-e', "console.log('MUST NOT RUN');setInterval(()=>{},1000)"], cwd: scratch })).response as any
  check('permission denial is a DAP error carrying the denial text', refused.success === false && /fixture denied/.test(refused.message), JSON.stringify(refused))
  check('denial creates no process', count === 2 && session.terminalProcessCount?.() === count && !session.output.some((s: string) => s.includes('MUST NOT RUN')))
  denied = false
  engageToolGuard(context.agentId, { id: 'fixture-terminal-guard', tools: [BashTool.name], judge: () => ({ allow: false, reason: 'fixture guard refused debug command' }) })
  const guarded = (await session.request('mock/terminal', { args: ['node', '-e', 'setInterval(()=>{},1000)'], cwd: scratch })).response as any
  check('Bash guard denial prevents spawn before permission callback', guarded.success === false && /fixture guard refused/.test(guarded.message) && decisions === 3, JSON.stringify(guarded))
  clearGuards(context.agentId)
  state.toolPermissionContext = { ...state.toolPermissionContext, alwaysAllowRules: { userSettings: ['Bash(node *)'] } }
  const saved = await BashTool.checkPermissions({ command: seenCommand || 'node -e '+ "'console.log(1)'" }, context as never)
  check('saved Bash(node *) rule matches the actual reverse-request command', seenCommand !== '' && saved.behavior === 'allow', JSON.stringify(saved))
  await call({ op: 'disconnect' })
  check('disconnect kills debuggee and descendants', await until(() => pids.every(pid => !alive(pid))), pids.filter(alive).join(','))
  check('cleanup counts terminal processes', session.terminalCleanup?.ended >= pids.length, JSON.stringify(session.terminalCleanup))
  check('terminal process registry emptied', session.terminalProcessCount?.() === 0)
} finally {
  clearGuards(context.agentId)
  await removeDapSession(owner, 'main')
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${failures} failures`)
process.exit(failures ? 1 : 0)
