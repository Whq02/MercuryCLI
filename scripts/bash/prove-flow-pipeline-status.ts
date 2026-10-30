import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const original = process.cwd()
const root = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'flow-pipeline-status-')))
const project = join(root, 'project')
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = join(root, 'home')
process.chdir(project)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { decideToolPermissionWithModes } = await import('../../src/utils/permissions/decision/wrapper.ts')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.ts')
const { parseForSecurity, checkSemantics } = await import('../../src/utils/permissions/decision/commandAnalysis.ts')
const tool = { name: 'Bash', inputSchema: z.object({ command: z.string() }), checkPermissions: (input: { command: string }, context: { getAppState: () => { toolPermissionContext: unknown } }) => bashToolHasPermission(input, context.getAppState().toolPermissionContext as never) } as never
const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'flow', shouldAvoidPermissionPrompts: true } }
const context = { abortController: new AbortController(), getAppState: () => state, options: { isNonInteractiveSession: true } } as never
let failures = 0
function check(label: string, ok: boolean, detail: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}
try {
  for (const expression of ['${pipestatus[1]}', '${PIPESTATUS[0]:-$?}', '${PIPESTATUS[1]:-pipe}']) {
    const command = `npm test 2>&1 | tail -6; echo "test exit: ${expression}"`
    const result = await decideToolPermissionWithModes(tool, { command }, context, { message: { id: 'flow-pipeline-status' } } as never, command)
    check(`quoted echo of ${expression}`, result.decision.behavior === 'allow', result.decision)
  }
  for (const command of [
    'echo "exit: ${PIPESTATUS[$(touch injected)]}"',
    'echo "exit: ${PIPESTATUS[0]:-$(touch injected)}"',
    'echo "exit: ${PIPESTATUS[index]}"',
    'echo ${PIPESTATUS[0]}',
    'node -e "${PIPESTATUS[0]}"',
    'node -e "x${PIPESTATUS[0]}"',
    'cat "file-${PIPESTATUS[0]}"',
    'echo x > "file-${PIPESTATUS[0]}"',
    'printf "exit: ${PIPESTATUS[0]}"',
    'echo "exit: ${other[0]}"',
  ]) {
    const parsed = await parseForSecurity(command)
    const semantic = parsed.kind === 'simple' ? checkSemantics(parsed.commands) : null
    check(`non-display or executable expansion stays unknown: ${command}`, parsed.kind !== 'simple' || semantic?.ok === false, { parsed, semantic })
  }
} finally {
  process.chdir(original)
  rmSync(root, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
