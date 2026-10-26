import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (process.platform !== 'win32') process.env.SHELL = '/bin/bash'
const { windowsPathToPosixPath } = await import('../../src/utils/windowsPaths.js')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'normalized-cwd-')))
const project = join(root, 'project')
const screenshots = join(project, 'mockups/launcher-rs/screenshots')
const previews = join(project, 'assets/cleanroom/previews')
const shellProject = process.platform === 'win32' ? windowsPathToPosixPath(project) : project
const shellScreenshots = process.platform === 'win32' ? windowsPathToPosixPath(screenshots) : screenshots
for (const dir of [screenshots, previews]) mkdirSync(dir, { recursive: true })
writeFileSync(join(previews, 'preview.png'), 'preview fixture\n')
writeFileSync(join(screenshots, 'comparison.png'), 'comparison fixture\n')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { setCwd, getShellCwd } = await import('../../src/utils/Shell.js')
const { setOriginalCwd } = await import('../../src/bootstrap/state.js')
const { getCwd, runWithCwdOverride } = await import('../../src/utils/cwd.js')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.js')
const { normalizeToolInput } = await import('../../src/utils/api.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { endEngineSession } = await import('../../src/utils/shell/engineSession.js')
const initialCwd = getCwd()
setCwd(project)
setOriginalCwd(project)
let appState = getDefaultAppState()
const context = {
  options: { tools: [], commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
  abortController: new AbortController(),
  toolUseId: 'normalized-cwd',
}
const normalize = (input: { command: string; cwd?: string }) => normalizeToolInput(BashTool as never, input)
async function run(input: { command: string; cwd?: string }): Promise<string> {
  const normalized = normalize(input)
  assert.equal(normalized.cwd, input.cwd, 'the normalizer preserves the explicit directory')
  const result = await BashTool.call(normalized, context as never)
  assert.equal(result.data.code, 0, JSON.stringify(result.data))
  assert.equal(getCwd(), project, 'a shell command never moves the project directory')
  return result.data.stdout.trim()
}
try {
  await run({ command: 'cd mockups/launcher-rs/screenshots && pwd -P' })
  assert.equal(getShellCwd(), screenshots)
  const readPreviews = 'pwd -P && echo "=== previews ===" && ls assets/cleanroom/previews/'
  assert.equal(await run({ command: readPreviews, cwd: project }), `${shellProject}\n=== previews ===\npreview.png`)
  assert.equal(getShellCwd(), screenshots, 'an explicit cwd does not move the persistent shell')
  assert.equal(normalize({ command: `cd ${shellProject} && pwd -P` }).command, `cd ${shellProject} && pwd -P`)
  assert.equal(await run({ command: `cd ${shellProject} && ${readPreviews}` }), `${shellProject}\n=== previews ===\npreview.png`)
  assert.equal(getShellCwd(), project)
  assert.equal(normalize({ command: `cd ${shellProject} && pwd -P` }).command, 'pwd -P')
  await run({ command: 'cd mockups/launcher-rs && pwd -P' })
  assert.equal(await run({ command: 'cat mockups/launcher-rs/screenshots/comparison.png', cwd: project }), 'comparison fixture')
  assert.equal(await run({ command: `cd ${shellProject} && cat mockups/launcher-rs/screenshots/comparison.png` }), 'comparison fixture')
  assert.equal(await run({ command: 'pwd -P', cwd: 'mockups/launcher-rs/screenshots' }), shellScreenshots)
  assert.equal(getShellCwd(), project)
  assert.equal(await run({ command: `cd ${shellProject} && pwd -P`, cwd: screenshots }), shellProject)
  assert.equal(getShellCwd(), project)
  assert.equal(await run({ command: `echo 'cd ${shellProject} && pwd'` }), `cd ${shellProject} && pwd`)
  await runWithCwdOverride(screenshots, async () => {
    const input = normalize({ command: `cd ${shellProject} && pwd -P` })
    assert.equal(input.command, `cd ${shellProject} && pwd -P`, 'a crewmate normalizes against its own shell directory')
    const result = await BashTool.call(input, { ...context, agentId: 'cwd-fixture' } as never)
    assert.equal(result.data.stdout.trim(), shellProject)
    assert.equal(getShellCwd(), screenshots, 'a crewmate command cannot move its directory')
  })
  assert.equal(getShellCwd(), project)
  console.log('Bash normalization and real-shell cwd recovery: PASS')
} finally {
  await endEngineSession()
  setCwd(initialCwd)
  setOriginalCwd(initialCwd)
  rmSync(root, { recursive: true, force: true })
  rmSync(proofHome, { recursive: true, force: true })
}
process.exit(0)
