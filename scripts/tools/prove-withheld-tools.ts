#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'withheld-tools-'))
const emptyPacks = join(scratch, 'packs')
const emptyBin = join(scratch, 'bin')
const home = join(scratch, 'home')
for (const dir of [emptyPacks, emptyBin, home]) mkdirSync(dir)
process.env.HOME = home
process.env.USERPROFILE = home
process.env.PATH = emptyBin
delete process.env.MERCURY_DAP
delete process.env.MERCURY_DAP_ADAPTERS
process.env.MERCURY_DAP_ADAPTERS_FILE = join(emptyPacks, 'dap-adapters.json')
process.env.MERCURY_JS_DEBUG_DAP = join(emptyPacks, 'js-debug', 'dapDebugServer.js')
process.env.MERCURY_DEBUGPY_VENDOR_DIR = join(emptyPacks, 'debugpy')
delete process.env.MERCURY_GODOT
delete process.env.MERCURY_UNITY
process.env.MERCURY_GODOT_TOOLS = '1'
process.env.MERCURY_GODOT_EXECUTABLE = join(emptyPacks, 'godot')
process.env.MERCURY_COMPUTER_USE = '1'
process.env.MERCURY_DESKTOP_PACK_DIR = join(emptyPacks, 'desktop')

const { getAllBaseTools } = await import('../../src/tools.ts')
const { withheldTools, withheldToolsLine } = await import('../../src/utils/withheldTools.ts')
const { collectReadiness } = await import('../../src/utils/readiness.ts')
const dap = await import('../../src/services/dap/dapClient.ts')
const godot = await import('../../src/services/vulcan/portabilityDoctor.ts')
dap._resetLldbDapForTesting()
dap._resetGdbProbeForTesting()
godot._resetGodotExecutablePresenceForTesting()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
const catalog = (): string[] => getAllBaseTools().map(t => t.name)

section('§1 the packs pointed at empty folders: the tools that cannot work are not offered')
const names = catalog()
check('the Debug tool is not in the catalog (no adapter reachable)', !names.includes('Debug'), names.join(','))
check('the Godot tool is not in the catalog (the pin names no executable)', !names.includes('Godot'))
check('the Computer tool is not in the catalog (no desktop driver)', !names.includes('Computer'))
check('the tools with no machine dependency stay', ['Bash', 'Read', 'Edit', 'Write'].every(n => names.includes(n)), names.join(','))

section('§2 the census names each withheld tool, why, and the remedy')
const withheld = withheldTools()
const byTool = new Map(withheld.map(w => [w.tool, w]))
const debug = byTool.get('Debug')
const godotRow = byTool.get('Godot')
check('Debug — no adapter reachable, with the adapters to arm', debug !== undefined && debug.why.includes('no debug adapter is reachable') && /debugpy/.test(debug.remedy ?? '') && /lldb/.test(debug.remedy ?? ''), JSON.stringify(debug))
check('Godot — the pin that names no executable', godotRow !== undefined && godotRow.why.includes('MERCURY_GODOT_EXECUTABLE') && (godotRow.remedy ?? '').includes('MERCURY_GODOT_EXECUTABLE'), JSON.stringify(godotRow))
check('Computer — the missing driver', byTool.has('Computer'), JSON.stringify([...byTool.keys()]))
check('every withheld tool is absent from the catalog (the census and the catalog read one rule)', withheld.every(w => w.tool.split(' and ').every(n => !names.includes(n))))
const line = withheldToolsLine(withheld)
check('the doctor line counts them and names each with its why', line.startsWith(`${withheld.length} withheld from the catalog:`) && line.includes('Debug — ') && line.includes('Godot — '), line)

section('§3 the readiness table carries a row per withheld tool')
const readiness = collectReadiness({ includeEnv: false }).records
const debugRecord = readiness.find(r => r.id === 'tool:withheld:debug')
const godotRecord = readiness.find(r => r.id === 'tool:withheld:godot')
check('tool:withheld:debug — unavailable, withheld from the catalog, with a remedy', debugRecord?.kind === 'tool' && debugRecord.state === 'unavailable' && debugRecord.detail.startsWith('withheld from the catalog') && (debugRecord.remedy ?? '').length > 0, JSON.stringify(debugRecord))
check('tool:withheld:godot — names the pin', godotRecord?.state === 'unavailable' && godotRecord.detail.includes('MERCURY_GODOT_EXECUTABLE'), JSON.stringify(godotRecord))
check('the Computer tool keeps its own readiness row (no duplicate)', readiness.some(r => r.id === 'tool:computer' && r.state === 'unavailable') && !readiness.some(r => r.id === 'tool:withheld:computer'))

section('§4 the dependency present, the tool is offered again')
process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ planted: { command: process.execPath, args: ['-e', '0'], fileTypes: ['.planted'] } })
check('a configured adapter table seats the Debug tool', catalog().includes('Debug') && withheldTools().every(w => w.tool !== 'Debug'), catalog().join(','))
writeFileSync(process.env.MERCURY_GODOT_EXECUTABLE!, '#!/bin/sh\nexit 0\n')
chmodSync(process.env.MERCURY_GODOT_EXECUTABLE!, 0o755)
godot._resetGodotExecutablePresenceForTesting()
check('a Godot executable at the pin seats the Godot tool', catalog().includes('Godot') && withheldTools().every(w => w.tool !== 'Godot'), catalog().join(','))
check('the Computer tool stays withheld while the driver is absent', !catalog().includes('Computer'))
check('the readiness table drops the rows of the tools now seated', !collectReadiness({ includeEnv: false }).records.some(r => r.id === 'tool:withheld:debug' || r.id === 'tool:withheld:godot'))
const nothing = withheldToolsLine([])
check('with nothing withheld the doctor says so and names every dependency it checks', nothing.startsWith('no tool is withheld') && nothing.includes('Debug') && nothing.includes('Godot') && nothing.includes('Computer') && nothing.includes('Grep'))
delete process.env.MERCURY_DAP_ADAPTERS
process.env.MERCURY_DAP = '0'
check('MERCURY_DAP=0 is off, not withheld: the census does not name the Debug tool', withheldTools().every(w => w.tool !== 'Debug') && !catalog().includes('Debug'))
delete process.env.MERCURY_DAP

section('§5 the wiring: the catalog seats the two tools through their owners')
const toolsSource = readFileSync(join(ROOT, 'src/tools.ts'), 'utf8')
check('tools.ts seats Debug through isDapToolCatalogEnabled', toolsSource.includes('isDapToolCatalogEnabled() ? [DebugTool]'))
check('tools.ts seats Godot through vulcanToolCatalogEnabled', toolsSource.includes('vulcanToolCatalogEnabled() ? [GodotTool]'))
const dapSource = readFileSync(join(ROOT, 'src/services/dap/dapClient.ts'), 'utf8')
check('the Debug gate reads the flag and the reachable adapters', dapSource.includes('return mercuryDapEnabled() && reachableDapAdapterKeys().length > 0'))
const gatesSource = readFileSync(join(ROOT, 'src/utils/vulcan/vulcanGates.ts'), 'utf8')
check('the Godot gate reads the flag and the executable presence', gatesSource.includes('return vulcanEnabled() && godotExecutablePresence().present'))
const healthSource = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
check("the doctor's TOOL CAPABILITY section carries the Tools withheld row", healthSource.includes("id: 'tools-withheld'") && healthSource.includes("label: 'Tools withheld'"))
check('the census reads the adapter table through the memo, never the live probes', dapSource.includes("const table = builtinAdapters('memo')") && dapSource.includes('if (lldbDapFromMemo() !== null) reachable.push(key)'))
check("the doctor's row waits for the toolchain probes before it reads the census", healthSource.includes('await settleDapAdapterProbes()'))

section('§6 the toolchain probes answer in the background: the catalog build reads their memo')
dap._resetLldbDapForTesting()
dap._resetGdbProbeForTesting()
const pendingAtBuild = dap.dapAdapterProbePending()
const firstBuild = catalog()
const firstWords = withheldTools().find(w => w.tool === 'Debug')
check('the first catalog build answers at once: the Debug tool is withheld', !firstBuild.includes('Debug') && firstWords !== undefined, firstBuild.join(','))
check('on macOS with no lldb-dap on PATH the toolchain probe is pending at that build', process.platform !== 'darwin' || pendingAtBuild)
check('the words say what is known: a pending probe is named as unanswered, a settled census as no launch could work', firstWords !== undefined && (pendingAtBuild ? firstWords.why.includes('has not answered') && firstWords.why.includes('no debug adapter is reachable') : firstWords.why.includes('so no launch could work')), JSON.stringify(firstWords))
await dap.settleDapAdapterProbes()
const settledWords = withheldTools().find(w => w.tool === 'Debug')
check('once the probes answer nothing is pending and the words say no launch could work', !dap.dapAdapterProbePending() && settledWords !== undefined && settledWords.why.includes('so no launch could work') && !settledWords.why.includes('has not answered'), JSON.stringify(settledWords))
check('the catalog and the census still read one rule after the probes answer', !catalog().includes('Debug'))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
