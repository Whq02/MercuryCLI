import { deepStrictEqual, equal, notStrictEqual } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { TaskStatus, TaskType } from '../../src/Task.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { TASK_ID_ALPHABET, TASK_ID_SUFFIX_LENGTH } = await import('../../src/types/ids.js')
const events: unknown[] = []
let nextByte = 0
const output = { exports: {} as typeof import('../../src/Task.js') }
const fixtureImports: Record<string, unknown> = {
  'node:crypto': {
    randomBytes(size: number) {
      events.push(['random', size])
      return Buffer.from(Array.from({ length: size }, () => nextByte++ % 256))
    },
  },
  './types/ids.js': { TASK_ID_ALPHABET, TASK_ID_SUFFIX_LENGTH },
  './utils/task/diskOutput.js': {
    getTaskOutputPath(id: string) {
      events.push(['path', id])
      return `output/${id}.output`
    },
  },
}
const compiled = ts.transpileModule(readFileSync(resolve(import.meta.dir, '../../src/Task.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
new Function('require', 'module', 'exports', compiled)(
  (name: string) => {
    if (!(name in fixtureImports)) throw new Error(`Unexpected dependency ${name}`)
    return fixtureImports[name]
  },
  output,
  output.exports,
)
const { createTaskStateBase, generateTaskId, isTerminalTaskStatus } = output.exports

for (const status of ['pending', 'running', 'completed', 'failed', 'killed', '', 'stopped', 'COMPLETED', 'toString']) {
  equal(isTerminalTaskStatus(status as TaskStatus), ['completed', 'failed', 'killed'].includes(status))
}
for (const [type, prefix] of [
  ['local_bash', 'b'], ['local_agent', 'a'], ['remote_agent', 'r'],
  ['local_workflow', 'w'], ['monitor_mcp', 'm'], ['unknown', 'x'],
  ['toString', String(Object.prototype.toString)],
] as const) {
  for (let start = 0; start < 256; start += TASK_ID_SUFFIX_LENGTH) {
    nextByte = start
    events.length = 0
    const suffix = Array.from({ length: TASK_ID_SUFFIX_LENGTH }, (_, index) => TASK_ID_ALPHABET[((start + index) % 256) % TASK_ID_ALPHABET.length]).join('')
    equal(generateTaskId(type as TaskType), prefix + suffix)
    deepStrictEqual(events, [['random', TASK_ID_SUFFIX_LENGTH]])
  }
}

const clock = Date.now
Date.now = () => { events.push('clock'); return 123456 }
try {
  for (const call of [undefined, '', 'call-one']) {
    events.length = 0
    const args = {
      get task_id() { events.push('id'); return 'a01234567' },
      get task_type(): TaskType { events.push('type'); return 'local_agent' },
      get description() { events.push('description'); return 'work' },
      get call_id() { events.push('call'); return call },
    }
    const state = createTaskStateBase(args)
    deepStrictEqual(events, ['id', 'type', 'description', 'call', 'clock', ['path', 'a01234567']])
    deepStrictEqual(state, {
      id: 'a01234567', type: 'local_agent', status: 'pending', description: 'work',
      toolUseId: call, startTime: 123456, outputFile: 'output/a01234567.output', outputOffset: 0, notified: false,
    })
    deepStrictEqual(Object.keys(state), ['id', 'type', 'status', 'description', 'toolUseId', 'startTime', 'outputFile', 'outputOffset', 'notified'])
    equal(Object.getPrototypeOf(state), Object.prototype)
    equal(Object.hasOwn(state, 'toolUseId'), true)
    equal(Object.hasOwn(state, 'endTime'), false)
    equal(Object.hasOwn(state, 'totalPausedMs'), false)
    const second = createTaskStateBase(args)
    notStrictEqual(state, second)
    state.outputOffset = 42
    equal(second.outputOffset, 0)
  }
} finally {
  Date.now = clock
}
console.log('PASS: task states, every byte mapping, kind prefixes, fallback, property shape and effect order')
