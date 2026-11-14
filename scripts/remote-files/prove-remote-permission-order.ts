#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { enterWorld, localTransportUnavailable, remoteWorld, underScratchHome } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-permission-order-')))
const project = join(scratch, 'project')
const store = join(scratch, 'store')
for (const folder of [project, store, join(store, 'runtime', 'current')]) mkdirSync(folder, { recursive: true })
process.env.MERCURY_CONFIG_DIR = store
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
process.env.NODE_ENV = 'test'
for (const name of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS']) delete process.env[name]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
const { setCwdState, setOriginalCwd, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
const { closeRemoteConnections } = await import('../../src/services/remoteFiles/connection.ts')
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(project)
setCwdState(project)

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const tools = [FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool]
const family = (name: string): string => name === 'Write' || name === 'Edit' ? 'Edit' : 'Read'
const inputOf = (name: string, path: string): Record<string, unknown> => {
  if (name === 'Write') return { file_path: path, content: 'written\n' }
  if (name === 'Edit') return { file_path: path, append: 'appended\n' }
  if (name === 'Glob') return { path, pattern: '*' }
  if (name === 'Grep') return { path, pattern: 'needle' }
  return { file_path: path }
}
const contextOf = (mode = 'default', deny: string[] = [], allow: string[] = []) => ({
  messages: [],
  options: { engineModel: 'claude-opus-4-8', tools: [] },
  readFileState: createFileStateCacheWithSizeLimit(100),
  nestedMemoryAttachmentTriggers: new Set<string>(),
  dynamicSkillDirTriggers: new Set<string>(),
  abortController: new AbortController(),
  updateFileHistoryState: () => {},
  getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysDenyRules: { userSettings: deny }, alwaysAllowRules: { userSettings: allow } } }),
}) as never
const parent = { uuid: '00000000-0000-4000-8000-000000000001', message: { id: 'remote-permission-order' } } as never
const execute = async (tool: typeof tools[number], input: Record<string, unknown>, context: ReturnType<typeof contextOf>): Promise<string> => {
  try {
    const result = await tool.call(input as never, context, undefined as never, parent)
    return JSON.stringify(result.data)
  } catch (error) {
    return `THROWN ${error instanceof Error ? error.message : String(error)}`
  }
}

try {
  const unavailable = localTransportUnavailable()
  if (unavailable !== null) console.log(`  [SKIP] the local transport: ${unavailable}`)
  else {
    const world = await remoteWorld('local', 0, { clientHome: HOME })
    const leave = enterWorld(world)
    try {
      const data = join(world.data, 'tree')
      mkdirSync(data)
      writeFileSync(join(data, 'a.txt'), 'needle\n')
      writeFileSync(join(store, '.credentials.json'), '{"secret":"not-read"}')
      for (const tool of tools) {
        const name = tool.name
        for (const suffix of ['notes.txt', 'archive.zip:entry', 'database.db:table']) {
          const password = 'synthetic-password-value'
          const input = inputOf(name, `ssh://reader:${password}@box/${suffix}`)
          const start = world.argvLines().length
          const valid = await tool.validateInput!(input as never, contextOf())
          const decision = await decideToolPermission(tool as never, input, contextOf())
          const written = JSON.stringify({ valid, decision })
          check(`${name}: a password before ${suffix} is refused without echoing it or starting ssh`, valid.result === false && decision.decision.behavior === 'deny' && !written.includes(password) && world.argvLines().length === start, written)
        }
        const pathFor = (host: string, suffix: string): string => `ssh://${host}${name === 'Glob' || name === 'Grep' ? data : name === 'Read' ? join(data, 'a.txt') : join(data, suffix)}`
        for (const mode of ['default', 'sovereign']) {
          const deniedHost = `box-denied-${name}-${mode}`
          const deniedInput = inputOf(name, pathFor(deniedHost, 'unused.txt'))
          const deniedContext = contextOf(mode, [`${family(name)}(ssh://${deniedHost}/**)`])
          const before = world.argvLines().length
          const valid = await tool.validateInput!(deniedInput as never, deniedContext)
          const decision = await decideToolPermission(tool as never, deniedInput, deniedContext)
          check(`${name}, ${mode}: a denied path starts no ssh, including -G`, valid.result === false && decision.decision.behavior === 'deny' && world.argvLines().length === before, world.argvLines().slice(before).join(' | '))
          const floorPath = family(name) === 'Read' ? join(store, '.credentials.json') : join(store, 'runtime', 'current', 'x.txt')
          const floorInput = inputOf(name, `ssh://localhost${floorPath}`)
          const floorStart = world.argvLines().length
          await tool.validateInput!(floorInput as never, contextOf(mode))
          const floor = await decideToolPermission(tool as never, floorInput, contextOf(mode))
          check(`${name}, ${mode}: a written local floor starts no ssh`, floor.decision.behavior === 'deny' && world.argvLines().length === floorStart, JSON.stringify(floor.decision))
          const host = `box-approved-${name}-${mode}`
          const input = inputOf(name, pathFor(host, `${name}-${mode}.txt`))
          const context = contextOf(mode)
          const start = world.argvLines().length
          const validBefore = await tool.validateInput!(input as never, context)
          const judged = await decideToolPermission(tool as never, input, context)
          check(`${name}, ${mode}: validation and the decision start no ssh`, validBefore.result === true && judged.decision.behavior === (mode === 'default' ? 'ask' : 'allow') && world.argvLines().length === start, `${judged.decision.behavior} ${world.argvLines().slice(start).join(' | ')}`)
          const approvedAt = world.argvLines().length
          const answer = await execute(tool, input, context)
          const starts = world.argvLines().slice(approvedAt)
          check(`${name}, ${mode}: after approval one -G precedes one connection`, !answer.startsWith('THROWN') && starts.length === 2 && starts[0] === `-G -- ${host}` && !starts[1]!.startsWith('-G'), `${starts.join(' | ')} ${answer.slice(0, 200)}`)
          closeRemoteConnections()
        }
        for (const mode of ['default', 'sovereign']) {
          const host = `box-address-${name}-${mode}`
          const input = inputOf(name, pathFor(host, 'address.txt'))
          const context = contextOf(mode, [`${family(name)}(ssh://127.0.0.1/**)`])
          const before = world.argvLines().length
          const judged = await decideToolPermission(tool as never, input, context)
          check(`${name}, ${mode}: a rule for the resolved address runs no ssh before approval`, judged.decision.behavior === (mode === 'default' ? 'ask' : 'allow') && world.argvLines().length === before, world.argvLines().slice(before).join(' | '))
          const connected = world.connectLines().length
          const answer = await execute(tool, input, context)
          check(`${name}, ${mode}: the resolved deny refuses before connecting`, answer.startsWith('THROWN') && answer.includes('is denied by the rule') && world.connectLines().length === connected, answer)
          const homeAlias = `box-floor-${name}-${mode}`
          const floorPath = family(name) === 'Read' ? join(store, '.credentials.json') : join(store, 'runtime', 'current', 'x.txt')
          const homeInput = inputOf(name, `ssh://${homeAlias}${floorPath}`)
          const floorStart = world.argvLines().length
          const homeJudged = await decideToolPermission(tool as never, homeInput, contextOf(mode))
          check(`${name}, ${mode}: an unresolved home alias runs no ssh before approval`, homeJudged.decision.behavior === (mode === 'default' ? 'ask' : 'allow') && world.argvLines().length === floorStart)
          const homeAnswer = await execute(tool, homeInput, contextOf(mode))
          check(`${name}, ${mode}: the resolved local floor refuses before connecting`, homeAnswer.startsWith('THROWN') && /is refused:/.test(homeAnswer) && world.connectLines().length === connected, homeAnswer)
        }
      }
    } finally {
      closeRemoteConnections()
      leave()
      await world.stop()
    }
  }
} finally {
  process.chdir(tmpdir())
  removeScratch(scratch)
}
console.log(`\nremote permission order: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
