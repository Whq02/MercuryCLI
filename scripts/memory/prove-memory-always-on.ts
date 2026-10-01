#!/usr/bin/env bun
// gate-watch: src/memdir/mnemeGates.ts src/memdir/memoryVerbs.ts src/memdir/mnemeBuffer.ts
// gate-watch: src/memdir/mnemeConsolidate.ts src/substrate/flagRegistry.ts src/substrate/startupMenu.ts
// gate-watch: src/services/mcp/coordinationServer.ts src/utils/capability/declarations.ts src/query/stopHooks.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'mercury-memory-always-on-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
for (const name of Object.keys(process.env)) {
  if (/^MERCURY_(MNEME|MEMORY_OBSERVE)$/.test(name)) delete process.env[name]
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { memoryVerbsEnabled, memoryVerbsWhyNot, retainItems } = await import('../../src/memdir/memoryVerbs.js')
const { appendObservation, readBuffer } = await import('../../src/memdir/mnemeBuffer.js')
const { maybeConsolidate, listTopicDocs } = await import('../../src/memdir/mnemeConsolidate.js')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')
const { RetainTool, RecallTool, ReflectTool, CorrectTool } = await import('../../src/tools/MemoryTools/MemoryTools.js')

section('memory is on with nothing set in the environment')
check('the verbs are available', memoryVerbsEnabled() === true, memoryVerbsWhyNot() ?? '')
check('every memory tool answers isEnabled', [RetainTool, RecallTool, ReflectTool, CorrectTool].every(t => t.isEnabled()))
const lib = join(scratch, 'library')
check('a fact lands in the buffer', appendObservation({ text: 'the runtime deploys from mercury-working', source: 'proof', topicHint: 'deploy' }, lib) === true)
check('the buffer reads the row back', readBuffer(lib).length === 1)
const retained = retainItems([{ content: 'the owner signs as Whq02', topic: 'owner' }], { session: 'always-on' }, lib)
check('Retain stores', retained[0]?.status === 'stored', JSON.stringify(retained))
const result = maybeConsolidate({ force: true, dir: lib })
check('consolidation runs', result.consolidated === true, result.reason)
check('two topic pages exist', listTopicDocs(lib).length === 2, listTopicDocs(lib).map(d => d.id).join(','))

section('the gate words are gone')
const envNames = new Set(FLAG_REGISTRY.map(f => f.env))
check('the registry has no memory gate row', !envNames.has('MERCURY_MNEME') && !envNames.has('MERCURY_MEMORY_OBSERVE'))
check('the observe hook module is gone', !existsSync(join(ROOT, 'src/memdir/mnemeObserveTurn.ts')))
const server = readFileSync(join(ROOT, 'src/services/mcp/coordinationServer.ts'), 'utf8')
check('the coordination server registers no mneme_ verb', !/registerTool\(\s*'mneme_/.test(server))
const menu = readFileSync(join(ROOT, 'src/substrate/startupMenu.ts'), 'utf8')
check('the boot menu has no memory gate row', !menu.includes("env: 'MERCURY_MNEME'"))
const declarations = readFileSync(join(ROOT, 'src/utils/capability/declarations.ts'), 'utf8')
check('the capability rows declare no memory gate', !declarations.includes("gate: 'MERCURY_MNEME'"))

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
}
const files: string[] = []
walk(join(ROOT, 'src'), files)
const carriers = files
  .filter(p => !p.endsWith('/src/utils/healthReport.ts'))
  .filter(p => /MERCURY_MNEME|MERCURY_MEMORY_OBSERVE|mneme_observe|mneme_catalog|mneme_grep|mneme_read|mneme_correct|mneme_retire/.test(readFileSync(p, 'utf8')))
check('no source file this lane owns names the retired gate or the retired verbs', carriers.length === 0, carriers.map(p => p.slice(ROOT.length + 1)).join(', '))

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ MEMORY IS ON FOR EVERYONE' : `❌ ${failures} ALWAYS-ON CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
