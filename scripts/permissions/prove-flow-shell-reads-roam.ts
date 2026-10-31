import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { ruleRoot, slashed } from '../lib/platformPath.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const world = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'flow-shell-reads-')))
const project = join(world, 'project')
const outsideDir = join(world, 'outside')
const outside = slashed(outsideDir)
mkdirSync(project)
mkdirSync(join(outsideDir, 'pkg'), { recursive: true })
writeFileSync(join(outsideDir, 'pkg', 'package.json'), '{}\n')
writeFileSync(join(outsideDir, 'notes.txt'), 'hello\n')
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.chdir(project)
const { getPlatform } = await import('../../src/utils/platform.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
let failures = 0
function check(label: string, ok: boolean, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' — ' + detail}`)
  if (!ok) failures++
}
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const assistant = { message: { id: 'flow-shell-reads' } } as never
function context(mode: string, headless: boolean, host = false, rules: { deny?: string[] } = {}) {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, shouldAvoidPermissionPrompts: headless, alwaysDenyRules: { localSettings: rules.deny ?? [] } } }
  return { abortController: new AbortController(), getAppState: () => state, options: { isNonInteractiveSession: headless, hostHoldsAsks: host } } as never
}
const decide = async (command: string, mode: string, headless: boolean, host = false, rules: { deny?: string[] } = {}) =>
  (await decideToolPermissionWithModes(tool, { command }, context(mode, headless, host, rules), assistant, command)).decision
const reads = [
  `find ${outside} -name package.json -type f | wc -l`,
  `ls ${outside}`,
  `cat ${outside}/notes.txt`,
  `grep -r hello ${outside}`,
  `head -n 1 ${outside}/notes.txt`,
  `tail -n 1 ${outside}/notes.txt`,
  `wc -l ${outside}/notes.txt`,
  `stat ${outside}/notes.txt`,
  `cat ${outside}/notes.txt | head -n 1`,
]
const home = slashed(homedir())
const changes = [
  `rm ${home}/notes.txt`,
  `mv ${home}/notes.txt ${home}/moved.txt`,
  `echo hi > ${home}/notes.txt`,
  `cp ${slashed(join(project, 'x'))} ${home}/Documents/x`,
  `cat ${outside}/notes.txt | tee ${home}/copy.txt`,
  'sed -i "s/a/b/" /etc/hosts',
]
const free = [
  `rm ${outside}/notes.txt`,
  `echo hi > ${outside}/notes.txt`,
  `touch ${home}/new.txt`,
  `mkdir -p ${home}/new-folder`,
  `cat < $(echo ${outside}/notes.txt)`,
  `cd ${outside} && ls`,
  `cd ${home} && ls`,
  `cat < ${outside}/notes.txt`,
  `cat < ${home}/.zshrc`,
]
try {
  console.log('§1 Flow: a read-only shell command reading outside the project goes ahead, hostless headless, hosted and in the cockpit')
  for (const command of reads) {
    for (const [road, headless, host] of [['hostless headless', true, false], ['hosted', true, true], ['cockpit', false, false]] as const) {
      const decision = await decide(command, 'flow', headless, host)
      check(`Flow ${road} runs: ${command}`, decision.behavior === 'allow', JSON.stringify(decision))
    }
  }
  console.log('§2 Flow: a delete or an overwrite outside the project and the temp roots asks, in one sentence naming the path')
  for (const command of changes) {
    for (const [road, headless, host] of [['hostless headless', true, false], ['hosted', true, true], ['cockpit', false, false]] as const) {
      const decision = await decide(command, 'flow', headless, host)
      const words = 'message' in decision ? decision.message : ''
      const named = /^Flow asks before .*, outside the project\./.test(words)
      check(`Flow ${road} ${headless ? 'refuses with the sentence (no prompt here)' : 'asks'} before: ${command}`, named && decision.behavior === (headless ? 'deny' : 'ask'), JSON.stringify(decision))
    }
  }
  console.log('§2b Flow: a write under the temp roots, a creation anywhere, a read anywhere and a cd anywhere run')
  for (const command of free) {
    for (const [road, headless, host] of [['hostless headless', true, false], ['hosted', true, true], ['cockpit', false, false]] as const) {
      const decision = await decide(command, 'flow', headless, host)
      check(`Flow ${road} runs: ${command}`, decision.behavior === 'allow', JSON.stringify(decision))
    }
  }
  console.log('§3 Default and Implement keep asking for both, as today')
  for (const mode of ['default', 'implement']) {
    for (const command of [reads[0]!, reads[2]!, changes[0]!, changes[2]!]) {
      const decision = await decide(command, mode, false)
      check(`${mode} still asks: ${command}`, decision.behavior !== 'allow', JSON.stringify(decision))
    }
  }
  console.log('§4 a deny rule and the remote-host floor still outrank the Flow read')
  const denied = await decide(reads[0]!, 'flow', true, false, { deny: [`Read(${ruleRoot(outsideDir)}/**)`] })
  check('Flow: a deny rule on the outside folder refuses the read', denied.behavior === 'deny', JSON.stringify(denied))
  getPlatform.cache.set(undefined, 'windows')
  const remote = await decide(String.raw`type \\server.invalid\share\x.txt`, 'flow', false)
  check('Flow on Windows: a read naming a remote host is still the operator\'s ask', remote.behavior === 'ask' && remote.decisionReason?.type === 'safetyCheck', JSON.stringify(remote))
  getPlatform.cache.delete(undefined)
} finally {
  getPlatform.cache.delete(undefined)
  process.chdir(original)
  rmSync(world, { recursive: true, force: true })
}
console.log(failures === 0 ? 'FLOW SHELL READS ROAM GREEN' : `${failures} FLOW SHELL READS ROAM FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
