import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'remote-path-floor-')))
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.chdir(world)
const { getPlatform } = await import('../../src/utils/platform.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { checkReadPermissionForTool } = await import('../../src/utils/permissions/filesystem.ts')
const { PERMISSION_MODES } = await import('../../src/utils/permissions/PermissionMode.ts')
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const SENTENCE = 'SMB/WebDAV'
const HOST = 'server.invalid'
const spellings = [
  ['backslash', String.raw`\\server.invalid\share\x.txt`],
  ['slash', '//server.invalid/share/x.txt'],
  ['WebDAV', String.raw`\\server.invalid@SSL@443\DavWWWRoot\x.txt`],
  ['IPv4', '//127.0.0.1/share/x.txt'],
  ['file URL', 'file://server.invalid/share/x.txt'],
  ['percent-encoded', 'file:%2f%2fserver.invalid/share/x.txt'],
] as const
const readTool = { name: 'Read', inputSchema: z.object({ file_path: z.string() }), getPath: (input: { file_path: string }) => input.file_path, checkPermissions: (input: { file_path: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => checkReadPermissionForTool({ name: 'Read', getPath: () => input.file_path }, input, context.getAppState().toolPermissionContext as never) } as never
const bashTool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const assistant = { message: { id: 'remote-path-floor' } } as never
function context(mode: string, headless: boolean, rules: { allow?: string[] } = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign', shouldAvoidPermissionPrompts: headless, alwaysAllowRules: { localSettings: rules.allow ?? [] } } }
  return { abortController: new AbortController(), getAppState: () => state, options: { isNonInteractiveSession: headless, hostHoldsAsks: false } } as never
}
const operatorOnlyAsk = (decision: { behavior: string; decisionReason?: { type?: string; operatorOnly?: boolean }; message?: string }): boolean =>
  decision.behavior === 'ask' && decision.decisionReason?.type === 'safetyCheck' && decision.decisionReason.operatorOnly === true && String(decision.message).includes(SENTENCE)
const modes = PERMISSION_MODES.filter(mode => mode !== 'dontAsk')
try {
  getPlatform.cache.set(undefined, 'windows')
  console.log('§1 Windows: the remote-path guard is a floor in every permission mode until a rule names the host')
  for (const mode of modes) {
    for (const [form, path] of spellings) {
      const read = await decideToolPermissionWithModes(readTool, { file_path: path }, context(mode, false), assistant, `read-${mode}-${form}`)
      check(`${mode}: a Read of the ${form} spelling is the operator's ask, never a mode's allow`, operatorOnlyAsk(read.decision as never), JSON.stringify(read.decision))
      const headless = await decideToolPermissionWithModes(readTool, { file_path: path }, context(mode, true), assistant, `read-headless-${mode}-${form}`)
      check(`${mode} headless: the same Read is refused, not run`, headless.decision.behavior === 'deny', JSON.stringify(headless.decision))
    }
    const bash = await decideToolPermissionWithModes(bashTool, { command: String.raw`type \\server.invalid\share\x.txt` }, context(mode, false), assistant, `bash-${mode}`)
    check(`${mode}: a shell command naming the host is the operator's ask, never a mode's allow`, operatorOnlyAsk(bash.decision as never), JSON.stringify(bash.decision))
  }
  const dontAsk = await decideToolPermissionWithModes(readTool, { file_path: spellings[0][1] }, context('dontAsk', false), assistant, 'read-dontask')
  check('dontAsk: the ask becomes a refusal, never an allow', dontAsk.decision.behavior === 'deny', JSON.stringify(dontAsk.decision))
  console.log('§2 a saved rule naming the host still permits, in every mode')
  for (const mode of modes) {
    const granted = await decideToolPermissionWithModes(readTool, { file_path: spellings[1][1] }, context(mode, false, { allow: [`Read(//${HOST}/**)`] }), assistant, `granted-${mode}`)
    check(`${mode}: Read(//${HOST}/**) permits the Read`, granted.decision.behavior === 'allow', JSON.stringify(granted.decision))
    const blanket = await decideToolPermissionWithModes(readTool, { file_path: spellings[1][1] }, context(mode, false, { allow: ['Read(**)'] }), assistant, `blanket-${mode}`)
    check(`${mode}: Read(**) does not name the host, so the floor holds`, blanket.decision.behavior !== 'allow', JSON.stringify(blanket.decision))
  }
  console.log('§3 macOS and Linux: a path open authenticates to no host, so nothing changes there')
  for (const platform of ['macos', 'linux'] as const) {
    getPlatform.cache.set(undefined, platform)
    const read = await decideToolPermissionWithModes(readTool, { file_path: spellings[1][1] }, context('sovereign', false), assistant, `${platform}-sovereign`)
    check(`${platform} sovereign: the slash spelling is a plain path, allowed by the mode as before`, read.decision.behavior === 'allow' && read.decision.decisionReason?.type === 'mode', JSON.stringify(read.decision))
    const plain = await decideToolPermissionWithModes(readTool, { file_path: spellings[1][1] }, context('default', false), assistant, `${platform}-default`)
    check(`${platform} default: no SMB/WebDAV sentence anywhere`, !String(plain.decision.message ?? '').includes(SENTENCE), JSON.stringify(plain.decision))
  }
} finally {
  getPlatform.cache.delete(undefined)
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures === 0 ? 'REMOTE PATH FLOOR GREEN' : `${failures} REMOTE PATH FLOOR FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
