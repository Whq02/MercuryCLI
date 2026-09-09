#!/usr/bin/env bun
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'capacity-render-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
let failures = 0
const check = (name: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
  if (!ok) failures++
}
let syncCalls = 0
let samples = 0
let release: ((value: { code: number; stdout: string; stderr: string }) => void) | undefined
let meminfoWaits = false
let meminfoAborted = false
mock.module('node:fs/promises', () => ({
  ...fsPromises,
  readFile: (path: any, options: any) => path !== '/proc/meminfo'
    ? fsPromises.readFile(path, options)
    : meminfoWaits
      ? new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { meminfoAborted = true; reject(new Error('fixture read aborted')) }, { once: true }))
      : Promise.resolve('MemAvailable: 1572864 kB\n'),
}))
mock.module('node:os', () => ({ ...os, freemem: () => 8 * 2 ** 30, totalmem: () => 16 * 2 ** 30 }))
mock.module('node:child_process', () => ({
  ...childProcess,
  execFileSync: () => { syncCalls++; throw new Error('synchronous process creation') },
}))
mock.module(join(ROOT, 'src/utils/availableCores.ts'), () => ({ availableCores: () => 8 }))
mock.module(join(ROOT, 'src/utils/execFileNoThrow.ts'), () => ({
  execFileNoThrowWithCwd: async () => { throw new Error('unexpected subprocess') },
  execSyncWithDefaults_DEPRECATED: () => { throw new Error('unexpected synchronous subprocess') },
  execFileNoThrow: () => {
    samples++
    return new Promise(resolve => { release = resolve })
  },
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
const cap = await import('../../src/services/switchboard/capacityCheck.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
config.enableConfigs()
const clock = Date.now
let now = clock()
Date.now = () => now
const vmStat = (pages: number): string => `Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: ${pages}.\nPages inactive: 0.\n`
try {
  const first = cap.seatCeilingFactsAsync()
  const second = cap.seatCeilingFactsAsync()
  check('overlapping refreshes share one asynchronous sample', samples === 1 && syncCalls === 0)
  let eventRan = false
  await new Promise<void>(resolve => setImmediate(() => { eventRan = true; resolve() }))
  check('other events run while capacity is unresolved', eventRan && release !== undefined)
  release?.({ code: 0, stdout: vmStat(393216), stderr: '' })
  const [a, b] = await Promise.all([first, second])
  check('the completed sample retains the machine-derived ceiling', a.seats === 4 && b.seats === 4 && a.sample?.cores === 8)
  now += 6000
  const detail = cap.seatCeilingDetailLines(a)
  check('formatting a captured reading never samples again', syncCalls === 0 && samples === 1 && detail.some(line => line.includes('GB available')))
  const lower = cap.seatCeilingFactsAsync()
  release?.({ code: 0, stdout: vmStat(98304), stderr: '' })
  const held = await lower
  check('a lower sample preserves the existing high-water reading and its inputs', held.seats === 4 && held.sample?.availableBytes === a.sample?.availableBytes)
  now += 6000
  const higher = cap.seatCeilingFactsAsync()
  release?.({ code: 0, stdout: vmStat(589824), stderr: '' })
  check('a higher sample raises the existing reading', (await higher).seats === 6)
  cap.setOperatorSeats(9)
  check('the stored operator ceiling still takes precedence', (await cap.seatCeilingFactsAsync()).seats === 9)
  process.env.MERCURY_SEATS = '7'
  cap.setOperatorSeats(null)
  now += 6000
  const sampledBeforeStamp = samples
  const stamped = await cap.seatCeilingFactsAsync()
  check('a daemon-stamped reading never probes again', stamped.seats === 7 && stamped.sample === null && samples === sampledBeforeStamp)
  delete process.env.MERCURY_SEATS
  check('the asynchronous path never calls the synchronous process API', syncCalls === 0)
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  cap._setMemorySamplerForTesting(null)
  const linux = await cap.seatCeilingFactsAsync()
  check('Linux uses the asynchronous MemAvailable read', linux.seats === 4 && linux.sample?.read === 'meminfo')
  cap._setMemorySamplerForTesting(null)
  meminfoWaits = true
  const expired = await cap.seatCeilingFactsAsync()
  check('an unresponsive memory read aborts at its deadline and names the fallback', meminfoAborted && expired.sample?.read === 'free')
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  cap._setMemorySamplerForTesting(null)
  const samplesBeforeWindows = samples
  const windows = await cap.seatCeilingFactsAsync()
  check('Windows uses the available-bytes counter without a subprocess', windows.seats === 16 && windows.sample?.read === 'counter' && samples === samplesBeforeWindows)

  for (const [file, name] of [
    ['src/components/Settings/Config.tsx', 'Config'],
    ['src/components/BootSettingsScreen.tsx', 'BootSettingsScreen'],
  ]) {
    const source = ts.createSourceFile(file!, readFileSync(join(ROOT, file!), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const component = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration | undefined
    const statements = component?.body?.statements ?? []
    const index = statements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isArrayBindingPattern(declaration.name)
      ? declaration.name.elements.some(element => ts.isBindingElement(element) && element.name.getText(source) === 'seatFacts')
      : declaration.name.getText(source) === 'seatFacts'))
    check(`${name}: the real component's capacity statement exists`, index >= 0)
    if (index < 0) continue
    const statement = statements[index]!
    const next = statements[index + 1]
    const effect = next && ts.isExpressionStatement(next) && ts.isCallExpression(next.expression) && next.expression.expression.getText(source) === 'useEffect' ? next.getText(source) : ''
    const body = ts.transpileModule(`${statement.getText(source)}\n${effect}\nreturn seatFacts`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    const effects: Array<() => (() => void)> = []
    let reads = 0
    let asyncReads = 0
    let updates = 0
    let finish: ((facts: unknown) => void) | undefined
    const render = new Function('useState', 'useMemo', 'useEffect', 'seatCeilingFacts', 'seatCeilingFactsAsync', 'version', 'seatsTick', 'saveTick', body)
    const value = render(
      (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => { updates++ }],
      (callback: () => unknown) => callback(),
      (callback: () => (() => void)) => { effects.push(callback) },
      () => { reads++; return a },
      () => { asyncReads++; return new Promise(resolve => { finish = resolve }) },
      0, 0, 0,
    )
    check(`${name}: render performs no capacity operation and keeps an honest pending value`, reads === 0 && asyncReads === 0 && value === null)
    check(`${name}: refresh is registered as an effect`, effects.length === 1)
    if (effects.length !== 1) continue
    const dispose = effects[0]!()
    check(`${name}: the effect starts one asynchronous refresh`, asyncReads === 1 && updates === 0)
    finish!(a)
    await Promise.resolve()
    check(`${name}: the completed sample updates the mounted component`, updates === 1)
    dispose()
    const disposePending = effects[0]!()
    disposePending()
    finish!(a)
    await Promise.resolve()
    check(`${name}: an unmounted component ignores a late answer`, updates === 1)
  }
} finally {
  Date.now = clock
  Object.defineProperty(process, 'platform', platform)
}
console.log(`capacity-render-async: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
