#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'workflow-bundled-registry-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_SESSION_WORKFLOWS
delete process.env.MERCURY_WORKFLOWS
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' the bundled workflow registry — two built-ins, no gate')
console.log('============================================================')

section('the registration source reads no environment')
{
  const index = code(read('src/tools/WorkflowTool/bundled/index.ts'))
  check('bundled/index.ts imports nothing from the flag registry', !index.includes('flagRegistry'))
  check('bundled/index.ts reads no flag and no env (flagEnabled · flagEnv · process.env absent)', !/flagEnabled\(|flagEnv\(|process\.env/.test(index))
  check('every registration is unconditional (no if around registerBuiltinWorkflow)', !/if\s*\([^)]*\)\s*\{\s*registerBuiltinWorkflow/.test(index))
  const bundledScripts = index.match(/from '\.\/[a-z-]+\.js'/g) ?? []
  check('exactly two bundled scripts are imported', bundledScripts.length === 2, bundledScripts.join(','))
}

section('the registry after startup registration: exactly the two built-ins')
{
  await import('../../src/tools.js')
  const { initBundledWorkflows } = await import('../../src/tools/WorkflowTool/bundled/index.js')
  initBundledWorkflows()
  const { getBuiltinWorkflows, listWorkflows } = await import('../../src/tools/WorkflowTool/registry.js')
  const all = getBuiltinWorkflows()
  check('the built-in set is code-review and deep-research, nothing else', JSON.stringify(all.map(w => w.name).sort()) === JSON.stringify(['code-review', 'deep-research']), all.map(w => w.name).join(','))
  check('code-review is the one hidden entry; deep-research lists', all.find(w => w.name === 'code-review')?.hidden === true && all.find(w => w.name === 'deep-research')?.hidden !== true)
  check('every built-in carries its script and a parsed description', all.every(w => typeof w.script === 'string' && w.script.length > 100 && w.description.length > 0))
  const listed = await listWorkflows(join(scratch, 'cwd'))
  check('a listing from a bare directory carries exactly the two built-ins, code-review the hidden one', JSON.stringify(listed.map(w => [w.name, w.hidden === true])) === JSON.stringify([['deep-research', false], ['code-review', true]]), listed.map(w => w.name).join(','))
  const commands = code(read('src/tools/WorkflowTool/createWorkflowCommand.ts'))
  check('the per-workflow slash commands skip the hidden entry', commands.includes('all.filter(wf => !wf.hidden)'))
}

section('the tool, the consent dialog and the prompt carry no per-workflow special case')
{
  const tool = code(read('src/tools/WorkflowTool/WorkflowTool.tsx'))
  const callAt = tool.indexOf('async call(input: WorkflowInput')
  const runDirAt = tool.indexOf('const runDir = runDirectoryFor(runId)', callAt)
  const beforeRunDir = callAt !== -1 && runDirAt > callAt ? tool.slice(callAt, runDirAt) : ''
  check('the launch path branches on no workflow name before the run directory is chosen', beforeRunDir.length > 0 && !/meta\.name\s*===/.test(beforeRunDir))
  check('the launch never rewrites its input args for a named workflow', !/input = \{ \.\.\.input, args:/.test(tool))
  check('the tool imports no bundled script module', !/from '\.\/bundled\/[a-z-]+\.js'/.test(tool))
  const consent = code(read('src/tools/WorkflowTool/WorkflowPermissionRequest.tsx'))
  check('the consent facts branch on no workflow name (source · phases · args · resume only)', !/workflowName\s*===/.test(consent) && consent.includes("{ k: 'args'") && consent.includes("{ k: 'resume'"))
  const prompt = code(read('src/tools/WorkflowTool/workflowPrompt.ts'))
  check('the prompt module reads no flag (its gated addendum is the ledger global alone)', !prompt.includes('flagRegistry') && !/flagEnabled\(|flagEnv\(/.test(prompt))
  check('the prompt composes exactly the base text, the doctrine and the one gated global', /text \+= AUTHORING_DOCTRINE_SECTION\s*\n\s*if \(evolutionLedgerEnabled\(\)\) text \+= LEDGER_GLOBAL_SECTION\s*\n\s*return text/.test(prompt))
}

rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} check(s) failed`)
  process.exit(1)
}
console.log(' ALL BUNDLED-REGISTRY PROOFS PASS')
