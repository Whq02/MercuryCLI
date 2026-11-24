#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 180s; a step of main() in this file did not finish, most likely the LSP init in section 3 (initializeLspServerManager in src/integrations/lsp/serverManagerLifecycle.ts) or a resource read in section 4')
  process.exit(1)
}, 180_000)
guard.unref?.()

async function main(): Promise<void> {
  delete process.env.MERCURY_PROJECT_INTEL
  const home = mkdtempSync(join(tmpdir(), 'project-intel-s4-home-'))
  process.env.MERCURY_CONFIG_DIR = home

  const { materializeFixture } = await import('./fixtures/materialize.js')
  const { projectImpact, collectCodeFiles } = await import('../../src/sessions/project-intel/impact.js')
  const { suggestWorkSplit } = await import('../../src/sessions/project-intel/split.js')
  const steering = await import('../../src/sessions/project-intel/steering.js')
  const owner = await import('../../src/engine/execution-plane/owner.js')
  const registry = await import('../../src/integrations/resources/registry.js')

  const dir = materializeFixture('ts')
  const ctx = {
    owner: owner.makeOwnerKey({ workspace: dir, sessionId: 'proof-s4', lane: owner.MAIN_LANE }),
    cwd: dir,
  }

  section('(1) impact projection — established only, labeled inference, caps')
  const impact = projectImpact(dir, 'src/core/pricing.ts')
  check('projects', impact !== null, 'projectImpact in src/sessions/project-intel/impact.ts returned null for src/core/pricing.ts of the ts fixture')
  if (!impact) throw new Error('no impact')
  check(
    'forward imports established',
    JSON.stringify(impact.established.imports) ===
      JSON.stringify(['src/core/rules.ts', 'src/core/types.ts', 'src/util/money.ts'].sort()),
    `${impact.established.imports.join(',')} — established.imports from projectImpact in src/sessions/project-intel/impact.ts must list the target's direct imports, sorted`,
  )
  check(
    'reverse importers established (the three services)',
    ['src/services/checkout.ts', 'src/services/invoicing.ts', 'src/services/reporting.ts'].every(p =>
      impact.established.importedBy.includes(p),
    ),
    `${impact.established.importedBy.join(',')} — established.importedBy from projectImpact in src/sessions/project-intel/impact.ts must list every file that imports the target`,
  )
  check('tests established via reverse imports', impact.established.tests.includes('tests/pricing.test.ts'), `${impact.established.tests.join(',')} — projectIntel/impact.ts must put test files that import the target in established.tests`)
  check('clean file ⇒ null change stats', impact.established.change === null, `${JSON.stringify(impact.established.change)} — projectImpact in src/sessions/project-intel/impact.ts must leave established.change null when git reports no change`)
  check(
    'second-order reach is LABELED inference (api handlers)',
    impact.inferences.some(i => i.includes('INFERRED') && i.includes('src/api/handlers.ts')),
    `${JSON.stringify(impact.inferences)} — projectImpact in src/sessions/project-intel/impact.ts must emit a second-order reach line containing INFERRED and the reached file`,
  )
  check('scan caps named', impact.caps.scannedFiles > 0 && impact.caps.capped === false, `${JSON.stringify(impact.caps)} — projectImpact in src/sessions/project-intel/impact.ts must report caps.scannedFiles above 0 and capped false on this small fixture`)
  writeFileSync(join(dir, 'src', 'core', 'pricing.ts'), '// touched\n' + (await import('node:fs')).readFileSync(join(dir, 'src', 'core', 'pricing.ts'), 'utf8'))
  const dirty = projectImpact(dir, 'src/core/pricing.ts')
  check('dirty file ⇒ change stats from the git owner', (dirty?.established.change?.added ?? 0) >= 1, `${JSON.stringify(dirty?.established.change)} — projectImpact in src/sessions/project-intel/impact.ts must fill established.change (added lines) from git for a modified file`)
  const impact2 = projectImpact(dir, 'src/core/pricing.ts')
  check(
    'deterministic across calls',
    JSON.stringify({ ...dirty, generation: 0 }) === JSON.stringify({ ...impact2, generation: 0 }),
    'two projectImpact calls in src/sessions/project-intel/impact.ts on the same unchanged tree returned different results; remove the nondeterministic field or ordering',
  )
  check('bogus target ⇒ null', projectImpact(dir, 'src/nope.ts') === null, 'projectImpact in src/sessions/project-intel/impact.ts must return null for a path that is not a scanned code file')
  const scan = collectCodeFiles(dir)
  check('code-file scan bounded + sorted', scan.files.length > 10 && [...scan.files].sort().join() === scan.files.join(), 'collectCodeFiles (src/sessions/project-intel/capsule.ts) must return more than 10 files of the ts fixture in sorted order')

  section('(2) advisory work split — disjoint streams, contested flagged')
  const TASK_A =
    'Add a required taxRate to PricingRules in src/core/types.ts, apply it in src/core/pricing.ts and src/core/rules.ts and src/services/checkout.ts, expose taxCents in src/api/handlers.ts'
  const TASK_B =
    'Add CSV export of daily revenue: new src/services/exportCsv.ts using src/services/reporting.ts, route it in src/api/server.ts and src/api/handlers.ts'
  const split = suggestWorkSplit(dir, [TASK_A, TASK_B])
  check('suggests', split !== null, 'suggestWorkSplit in src/sessions/project-intel/split.ts returned null for the two tasks')
  if (!split) throw new Error('no split')
  check('advisory marker present', split.advisory === true, 'suggestWorkSplit in src/sessions/project-intel/split.ts must set advisory: true on its result')
  check('stream A owns the pricing core', split.perTask[0]!.files.includes('src/core/types.ts') && split.perTask[0]!.files.includes('src/core/pricing.ts'), `${split.perTask[0]!.files.join(',')} — suggestWorkSplit in src/sessions/project-intel/split.ts must pick up the paths named in task A`)
  check('stream B owns reporting/server', split.perTask[1]!.files.includes('src/services/reporting.ts') && split.perTask[1]!.files.includes('src/api/server.ts'), `${split.perTask[1]!.files.join(',')} — suggestWorkSplit in src/sessions/project-intel/split.ts must pick up the paths named in task B`)
  check(
    'the contested path is FLAGGED (handlers.ts in both)',
    split.contested.some(c => c.path === 'src/api/handlers.ts' && c.tasks.length === 2),
    `${JSON.stringify(split.contested.map(c => c.path))} — suggestWorkSplit in src/sessions/project-intel/split.ts must list a path named by both tasks in contested with both task indexes`,
  )
  check('tests ride the streams', split.perTask[0]!.tests.includes('tests/pricing.test.ts'), `${split.perTask[0]!.tests.join(',')} — suggestWorkSplit in src/sessions/project-intel/split.ts must attach tests of a stream's files to that stream`)
  const nonContested = split.perTask[0]!.files.filter(
    f => split.perTask[1]!.files.includes(f) && !split.contested.some(c => c.path === f),
  )
  check('every cross-stream overlap is flagged (no silent overlap)', nonContested.length === 0, `${nonContested.join(',')} — suggestWorkSplit in src/sessions/project-intel/split.ts must flag every file shared by two streams in contested`)

  section('(3) point-of-use steering — no tool describes another: the search and edit steering lines are gone; the read orientation line gates on projectIntel')
  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_STRUCTURE
  const lspManager = await import('../../src/integrations/lsp/serverManagerLifecycle.js')
  check('searchSteeringLine and editSteeringLine no longer exist', !('searchSteeringLine' in steering) && !('editSteeringLine' in steering), 'remove the exported searchSteeringLine/editSteeringLine from src/sessions/project-intel/steering.ts')
  lspManager.initializeLspServerManager()
  await lspManager.waitForInitialization()
  check('the LSP tool is mounted for the steering leg', lspManager.isLspToolMounted(), `${JSON.stringify(lspManager.getInitializationStatus())} — initializeLspServerManager in src/integrations/lsp/serverManagerLifecycle.ts did not mount the LSP tool`)
  const { GrepTool } = await import('../../src/tools/grep/GrepTool.ts')
  const { EditTool } = await import('../../src/tools/edit/EditTool.ts')
  const grepOn = await GrepTool.prompt({ tools: [{ name: 'Grep' }, { name: 'LspRead' }, { name: 'AstSearch' }] } as never)
  const editOn = await EditTool.prompt({ tools: [{ name: 'Edit' }, { name: 'LspRename' }, { name: 'AstEdit' }] } as never)
  check('Grep and Edit name no other tool with the LSP mounted and the shape owners offered', !/\b(Lsp\w+|AstSearch|AstEdit|Structure|ToolSearch)\b/.test(grepOn) && !/\b(Lsp\w+|AstSearch|AstEdit|Structure|ToolSearch)\b/.test(editOn), `${grepOn} — the prompt text in src/tools/grep/prompt.ts or src/tools/edit/prompt.ts must not name another tool`)
  process.env.MERCURY_LSP = '0'
  process.env.MERCURY_STRUCTURE = '0'
  check('…and their text is byte-identical with every owner off', await GrepTool.prompt({ tools: [{ name: 'Grep' }] } as never) === grepOn && await EditTool.prompt({ tools: [{ name: 'Edit' }] } as never) === editOn, 'the Grep or Edit prompt (src/tools/grep/prompt.ts, src/tools/edit/prompt.ts) changes with MERCURY_LSP/MERCURY_STRUCTURE; make its text independent of which owners are on')
  delete process.env.MERCURY_LSP
  delete process.env.MERCURY_STRUCTURE
  process.env.MERCURY_PROJECT_INTEL = '0'
  check('read steering gates on projectIntel too', steering.readSteeringLine() === null, 'readSteeringLine in src/sessions/project-intel/steering.ts must return null when MERCURY_PROJECT_INTEL=0')
  delete process.env.MERCURY_PROJECT_INTEL

  const { getSimplePrompt } = await import('../../src/tools/shell/prompt.js')
  const offered = new Set(['Bash', 'Test', 'Debug'])
  process.env.MERCURY_PROJECT_INTEL = '0'
  const bashBase = getSimplePrompt(offered)
  delete process.env.MERCURY_PROJECT_INTEL
  check('Bash carries no steering line: it names neither Test nor Debug, whatever is offered', !/\b(Test|Debug)\b/.test(getSimplePrompt(offered)) && !('debugSteeringLine' in steering), 'getSimplePrompt in src/tools/shell/prompt.ts must not name Test or Debug, and steering.ts must not export debugSteeringLine')
  for (const names of [[], ['Test'], ['Debug'], ['Test', 'Debug']]) {
    check(`the Bash description is byte-identical whatever debugger pair is offered (${names.join(',') || 'neither'})`, getSimplePrompt(new Set(['Bash', ...names])) === bashBase, 'getSimplePrompt in src/tools/shell/prompt.ts must not vary its text with the offered Test/Debug tools')
  }
  process.env.MERCURY_PROJECT_INTEL = '0'
  check('the master gate leaves the Bash description byte-identical', getSimplePrompt(offered) === bashBase, 'getSimplePrompt in src/tools/shell/prompt.ts must not read MERCURY_PROJECT_INTEL')
  delete process.env.MERCURY_PROJECT_INTEL

  section('(4) mercury://transcript — bounded concise rows, distinct states')
  const paths = await import('../../src/sessions/transcripts/paths.js')
  const sid = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
  const sessionFile = paths.getTranscriptPathForSession(sid)
  mkdirSync(join(sessionFile, '..'), { recursive: true })
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'user', message: { content: 'find the pricing owner' } }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'computeOrderTotal' } }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'It lives in src/core/pricing.ts.' }] },
      }),
    ].join('\n') + '\n',
  )
  const subDir = join(sessionFile, '..', sid, 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(
    join(subDir, 'agent-test1.jsonl'),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/README.md' } }] } }) + '\n',
  )
  const sess = await registry.resolveResource(`mercury://transcript/session/${sid}`, ctx)
  check('session transcript resolves', sess.state === 'ok', `${JSON.stringify(sess).slice(0, 120)} — the mercury://transcript/session adapter in src/integrations/resources/adapters/transcript.ts must resolve a stored session file`)
  if (sess.state === 'ok') {
    check('rows are concise + include tool one-liners', /user: find the pricing owner/.test(sess.resource.text ?? '') && /→ Grep/.test(sess.resource.text ?? ''), 'src/integrations/resources/adapters/transcript.ts must render rows as "user: <text>" and tool calls as "→ <Tool>"')
    check('paged view present', sess.resource.page !== undefined, 'src/integrations/resources/adapters/transcript.ts must return a page on the resource')
  }
  const filtered = await registry.resolveResource(`mercury://transcript/session/${sid}?q=pricing`, ctx)
  check('q= filters rows', filtered.state === 'ok' && (filtered.resource.text ?? '').split('\n').every(l => l.toLowerCase().includes('pricing')), 'the q= filter in src/integrations/resources/adapters/transcript.ts must keep only rows containing the query')
  const agent = await registry.resolveResource(`mercury://transcript/agent/${sid}/agent-test1`, ctx)
  check('subagent transcript resolves', agent.state === 'ok' && /→ Read \/x\/README\.md/.test(agent.state === 'ok' ? (agent.resource.text ?? '') : ''), 'the mercury://transcript/agent adapter in src/integrations/resources/adapters/transcript.ts must resolve the subagent file and render its tool calls')
  const missing = await registry.resolveResource(`mercury://transcript/session/aaaabbbb-cccc-dddd-eeee-000000000000`, ctx)
  check('unknown sid ⇒ absent (never an empty ok)', missing.state === 'absent', `${missing.state} — src/integrations/resources/adapters/transcript.ts must return absent for a session with no file`)
  const badForm = await registry.resolveResource('mercury://transcript/bogus/x', ctx)
  check('unknown form ⇒ absent with usage note', badForm.state === 'absent', `${badForm.state} — src/integrations/resources/adapters/transcript.ts must return absent with a usage note for an unknown form`)
  process.env.MERCURY_PROJECT_INTEL = '0'
  const gated = await registry.resolveResource(`mercury://transcript/session/${sid}`, ctx)
  check('=0 gates the transcript adapter (unavailable, named)', gated.state === 'unavailable', `${gated.state} — the transcript adapter (src/integrations/resources/adapters/transcript.ts) must report unavailable when MERCURY_PROJECT_INTEL=0`)
  delete process.env.MERCURY_PROJECT_INTEL

  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  delete process.env.MERCURY_CONFIG_DIR

  console.log('\n' + '═'.repeat(76))
  if (failures > 0) {
    console.log(`❌ ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('✅ IMPACT + SPLIT + STEERING + TRANSCRIPT PROOF PASSES')
  process.exit(0)
}

void main()
