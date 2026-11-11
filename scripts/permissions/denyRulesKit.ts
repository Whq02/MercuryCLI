import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import { removeScratch } from '../lib/removeScratch.ts'

const TREE = resolve(import.meta.dir, '..', '..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'deny-rules-')))
export const RUN_ROOT = join(scratch, 'run')
mkdirSync(join(RUN_ROOT, '.git'), { recursive: true })
mkdirSync(join(RUN_ROOT, 'sub'), { recursive: true })
mkdirSync(join(RUN_ROOT, 'secrets'), { recursive: true })
mkdirSync(join(scratch, 'home'), { recursive: true })
writeFileSync(join(RUN_ROOT, 'x'), 'x\n')
writeFileSync(join(RUN_ROOT, 'notes.txt'), 'notes\n')
writeFileSync(join(RUN_ROOT, 'secrets', 'k.txt'), 'K\n')
try {
  symlinkSync(join(RUN_ROOT, 'secrets', 'k.txt'), join(RUN_ROOT, 'link-to-k'))
  symlinkSync(join(RUN_ROOT, 'secrets'), join(RUN_ROOT, 'link-to-dir'))
} catch (error) {
  if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
}
const previousCwd = process.cwd()
process.chdir(RUN_ROOT)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_HOME', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_WARDS', 'MERCURY_TREE_SCAN_CEILING']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { enableConfigs } = await import('../../src/utils/config.ts')
const { setOriginalCwd, setCwdState, setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
enableConfigs()
setOriginalCwd(RUN_ROOT)
setCwdState(RUN_ROOT)

export type BashDecision = { behavior: string; message?: string; decisionReason?: { type?: string; reason?: string; rule?: { ruleBehavior?: string; ruleValue?: { toolName?: string; ruleContent?: string } } } }
export type Rules = { deny?: string[]; allow?: string[]; ask?: string[] }

const bash = {
  name: 'Bash',
  inputSchema: z.object({ command: z.string() }),
  checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never),
} as never

export async function bashDecision(command: string, mode: string, rules: Rules = {}): Promise<BashDecision> {
  const state = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),
      mode,
      isBypassPermissionsModeAvailable: mode === 'sovereign',
      alwaysDenyRules: rules.deny ? { localSettings: rules.deny } : {},
      alwaysAllowRules: rules.allow ? { localSettings: rules.allow } : {},
      alwaysAskRules: rules.ask ? { localSettings: rules.ask } : {},
    },
  }
  const context = { abortController: new AbortController(), getAppState: () => state, setAppState: () => {}, messages: [], options: {} } as never
  const outcome = await decideToolPermissionWithModes(bash, { command }, context, { message: { id: 'deny-rules' } } as never, 'deny-rules')
  return outcome.decision as BashDecision
}

export const said = (decision: BashDecision): string => `${decision.behavior}${decision.message ? `: ${decision.message.replaceAll('\n', ' ').slice(0, 220)}` : ''}`

let failures = 0
let checks = 0

export function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}

export function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}

export function note(text: string): void {
  console.log(`  [NOTE] ${text}`)
}

export function pageText(): string {
  return readFileSync(join(TREE, 'docs', 'TRUST.md'), 'utf8').replace(/\s+/g, ' ')
}

export function finish(name: string): never {
  console.log(`\n${name}: ${checks} checks, ${failures} failed`)
  process.chdir(previousCwd)
  removeScratch(scratch)
  process.exit(failures === 0 ? 0 : 1)
}
