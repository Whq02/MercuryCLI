#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function skip(reason: string, remedy: string): void {
  console.log(`\n  [SKIP — LOUD] ${reason}`)
  console.log(`  remedy: ${remedy}`)
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — proof exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'debug-memory-adapters-home-'))
delete process.env.MERCURY_DAP
delete process.env.MERCURY_DAP_ADAPTERS
const distDebugpy = join(ROOT, 'dist', 'vendor', 'debugpy')
const repoDebugpy = join(ROOT, 'vendor', 'debugpy', 'extracted')
if (!process.env.MERCURY_DEBUGPY_VENDOR_DIR) {
  const root = [distDebugpy, repoDebugpy].find(r => existsSync(join(r, 'debugpy', 'adapter', '__main__.py')))
  if (root) process.env.MERCURY_DEBUGPY_VENDOR_DIR = root
}

const { whichSync } = await import('../../src/utils/which.js')
const dap = await import('../../src/services/dap/dapClient.js')
const resolver = await import('../../src/services/dap/debugpyResolver.js')
const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

type CallOut = { data: { result: string; outcome: string; debuggee?: string } }
const callIn = async (cwd: string, input: Record<string, unknown>): Promise<CallOut> => {
  try {
    return (await runWithCwdOverride(cwd, () => DebugTool.call(input as never, {} as never))) as CallOut
  } catch (err) {
    return { data: { result: `THREW: ${(err as Error).message}`, outcome: 'threw' } }
  }
}
const b64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64')
const scratch: string[] = []

console.log('============================================================')
console.log(' writeMemory on js-debug · the refusals on debugpy — vendored adapters')
console.log('============================================================')

section('(A) js-debug — a Uint8Array patched in place; data/instruction breakpoints refused by name')
{
  const nodeBin = process.env.NODE ?? whichSync('node')
  const resolved = dap.resolveJsDebugServer()
  const repoBundle = join(ROOT, 'vendor', 'js-debug', 'extracted', 'src', 'dapDebugServer.js')
  let server: string | null = resolved?.path ?? null
  if (server === null && existsSync(repoBundle)) {
    const stage = mkdtempSync(join(tmpdir(), 'js-debug-stage-'))
    scratch.push(stage)
    cpSync(join(ROOT, 'vendor', 'js-debug', 'extracted', 'src'), join(stage, 'src'), { recursive: true })
    writeFileSync(join(stage, 'package.json'), '{"type":"commonjs"}\n')
    server = join(stage, 'src', 'dapDebugServer.js')
  }
  if (!nodeBin) {
    skip('no node on PATH — the js-debug leg drives node-targeted debugging', 'install node (or set NODE=<path>)')
  } else if (server === null) {
    skip('no js-debug bundle — neither a resolution (MERCURY_JS_DEBUG_DAP, dist/vendor, ~/.js-debug) nor vendor/js-debug/extracted', 'bun run scripts/vendor/fetch-js-debug.ts')
  } else {
    console.log(`  node: ${nodeBin}`)
    console.log(`  js-debug: ${server}`)
    process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
      js: {
        command: nodeBin,
        args: [server, '${port}', '127.0.0.1'],
        connect: 'tcp',
        fileTypes: ['.js'],
        launchDefaults: { type: 'pwa-node' },
        attachDefaults: { type: 'pwa-node' },
      },
    })
    const project = mkdtempSync(join(tmpdir(), 'debug-memory-js-'))
    scratch.push(project)
    const program = join(project, 'demo.js')
    writeFileSync(program, "const bytes = new Uint8Array([1, 2, 3, 4])\nconst total = bytes[0] + bytes[1]\nconsole.log('total:', total)\n")
    const baseline = dap._dapSessionCountForTesting()
    const call = (input: Record<string, unknown>): Promise<CallOut> => callIn(project, { session: 'js-mem', ...input })
    const launch = await call({ op: 'launch', adapter: 'js', program, file: program, lines: [2] })
    check('launch stops at line 2 in the js-debug child', /stopped in '.*' — reason breakpoint/.test(launch.data.result) && launch.data.debuggee === 'stopped', launch.data.result.split('\n')[0])
    const stack = await call({ op: 'stack' })
    const frameId = Number(stack.data.result.match(/\[frameId (\d+)\]/)?.[1])
    const scopes = await call({ op: 'scopes', frameId })
    const localRef = Number(scopes.data.result.match(/^Local \[variablesReference (\d+)\]/m)?.[1])
    check('the Local scope is exposed', Number.isInteger(localRef), scopes.data.result)
    const vars = await call({ op: 'variables', variablesReference: localRef })
    const memoryReference = vars.data.result.match(/^bytes = .*\[memory (\S+)\]$/m)?.[1]
    check('the typed array carries a memory reference in the variables paint', memoryReference !== undefined, vars.data.result.split('\n').find(l => l.startsWith('bytes')) ?? vars.data.result.slice(0, 200))
    if (memoryReference !== undefined) {
      const before = await call({ op: 'readMemory', memoryReference, count: 4 })
      check('readMemory shows the original bytes', /01 02 03 04/.test(before.data.result), before.data.result)
      const patched = await call({ op: 'writeMemory', memoryReference, data: b64([40, 2]) })
      check('writeMemory reports 2 bytes written', /2 bytes written/.test(patched.data.result) && patched.data.outcome === 'succeeded', `${patched.data.outcome}: ${patched.data.result}`)
      const after = await call({ op: 'readMemory', memoryReference, count: 4 })
      check('readMemory reads the patched bytes back', /28 02 03 04/.test(after.data.result), after.data.result)
    }
    const dataRefusal = await call({ op: 'dataBreakpoints', dataBreakpoints: [{ name: 'bytes', variablesReference: localRef }] })
    check('dataBreakpoints refuses naming supportsDataBreakpoints', /does not support dataBreakpoints \(capability supportsDataBreakpoints not advertised\)/.test(dataRefusal.data.result) && dataRefusal.data.outcome === 'no-change', `${dataRefusal.data.outcome}: ${dataRefusal.data.result}`)
    const instructionRefusal = await call({ op: 'instructionBreakpoints', instructionBreakpoints: [{ instructionReference: '0x1' }] })
    check('instructionBreakpoints refuses naming supportsInstructionBreakpoints', /does not support instructionBreakpoints \(capability supportsInstructionBreakpoints not advertised\)/.test(instructionRefusal.data.result) && instructionRefusal.data.outcome === 'no-change', `${instructionRefusal.data.outcome}: ${instructionRefusal.data.result}`)
    const cont = await call({ op: 'continue' })
    await new Promise(res => setTimeout(res, 300))
    const output = await call({ op: 'output' })
    const combined = `${cont.data.result}\n${output.data.result}`
    check('the program ran on with the patched bytes (total: 42)', /terminated/.test(cont.data.result) && /total: 42/.test(combined), combined.slice(0, 300))
    const disc = await call({ op: 'disconnect' })
    check('disconnect reaps the js-debug tree', /disconnected/.test(disc.data.result))
    check('session registry back at baseline', dap._dapSessionCountForTesting() === baseline, `${dap._dapSessionCountForTesting()} vs ${baseline}`)
    delete process.env.MERCURY_DAP_ADAPTERS
  }
}

section('(B) debugpy — the three ops answer the typed refusal on a live Python stop')
{
  resolver._resetDebugpyResolverForTesting()
  const resolution = resolver.resolvePythonDebugAdapter()
  if (resolution.state === 'unavailable') {
    skip(`no healthy Python debug interpreter: ${resolution.reason}`, resolution.remedy)
  } else {
    console.log(`  python: ${resolution.command} (${resolution.provenance.adapterSource} debugpy ${resolution.provenance.debugpyVersion ?? '?'})`)
    const project = mkdtempSync(join(tmpdir(), 'debug-memory-py-'))
    scratch.push(project)
    const program = join(project, 'demo.py')
    writeFileSync(program, 'def compute(a, b):\n    total = a * 10 + b\n    return total\n\nprint("result:", compute(4, 2))\n')
    const baseline = dap._dapSessionCountForTesting()
    const call = (input: Record<string, unknown>): Promise<CallOut> => callIn(project, { session: 'py-mem', ...input })
    const launch = await call({ op: 'launch', adapter: 'python', program, file: program, lines: [2] })
    check('launch stops at the verified breakpoint', /line 2 verified/.test(launch.data.result) && /stopped — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n')[0])
    const stack = await call({ op: 'stack' })
    const frameId = Number(stack.data.result.match(/\[frameId (\d+)\]/)?.[1])
    const scopes = await call({ op: 'scopes', frameId })
    const localRef = Number(scopes.data.result.match(/Local[^\[]*\[variablesReference (\d+)\]/i)?.[1])
    check('the Locals scope is exposed', Number.isInteger(localRef), scopes.data.result)
    const cases: Array<{ label: string; input: Record<string, unknown>; capability: string }> = [
      { label: 'dataBreakpoints', input: { op: 'dataBreakpoints', dataBreakpoints: [{ name: 'a', variablesReference: localRef }] }, capability: 'supportsDataBreakpoints' },
      { label: 'instructionBreakpoints', input: { op: 'instructionBreakpoints', instructionBreakpoints: [{ instructionReference: '0x1' }] }, capability: 'supportsInstructionBreakpoints' },
      { label: 'writeMemory', input: { op: 'writeMemory', memoryReference: '0x1', data: b64([1]) }, capability: 'supportsWriteMemoryRequest' },
    ]
    for (const c of cases) {
      const out = await call(c.input)
      check(`${c.label} ⇒ refusal names ${c.capability}`, out.data.result.includes(`adapter 'python' does not support ${c.label} (capability ${c.capability} not advertised)`) && out.data.outcome === 'no-change', `${out.data.outcome}: ${out.data.result}`)
    }
    const cont = await call({ op: 'continue' })
    check('the program still runs to a clean end', /terminated/.test(cont.data.result), cont.data.result.split('\n')[0])
    const disc = await call({ op: 'disconnect' })
    check('disconnect reaps', /disconnected/.test(disc.data.result))
    check('session registry back at baseline', dap._dapSessionCountForTesting() === baseline, `${dap._dapSessionCountForTesting()} vs ${baseline}`)
  }
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
console.log('\n============================================================')
if (failures === 0) {
  console.log(' ALL VENDORED-ADAPTER MEMORY CHECKS PASS')
  process.exit(0)
}
console.log(` ${failures} CHECK(S) FAILED`)
process.exit(1)
