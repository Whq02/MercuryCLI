import { deepStrictEqual, equal, notStrictEqual } from 'node:assert/strict'
import * as crypto from 'node:crypto'
import { resolve } from 'node:path'
import { mock, spyOn } from 'bun:test'
import type { TaskStatus, TaskType } from '../../src/engine/tasks/taskBase.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { TASK_ID_ALPHABET, TASK_ID_SUFFIX_LENGTH } = await import('../../src/sessions/transcripts/ids.js')
const events: unknown[] = []
let nextByte = 0

spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => {
  events.push(['random', size])
  return Buffer.from(Array.from({ length: size }, () => nextByte++ % 256))
}) as typeof crypto.randomBytes)
mock.module(resolve(import.meta.dir, '../../src/engine/task-framework/diskOutput.ts'), () => ({
  getTaskOutputPath(id: string) {
    events.push(['path', id])
    return `output/${id}.output`
  },
}))

const { createTaskStateBase, generateTaskId, isTerminalTaskStatus } = await import('../../src/engine/tasks/taskBase.js')

for (const status of ['pending', 'running', 'completed', 'failed', 'killed', '', 'stopped', 'COMPLETED', 'toString']) {
  equal(isTerminalTaskStatus(status as TaskStatus), ['completed', 'failed', 'killed'].includes(status), `isTerminalTaskStatus in src/engine/tasks/taskBase.ts must be true only for completed, failed and killed; it answered wrongly for status ${JSON.stringify(status)}`)
}
for (const [type, prefix] of [
  ['local_bash', 'b'], ['local_agent', 'a'], ['remote_agent', 'r'],
  ['monitor_mcp', 'm'], ['unknown', 'x'], ['local_workflow', 'x'],
  ['toString', String(Object.prototype.toString)],
] as const) {
  for (let start = 0; start < 256; start += TASK_ID_SUFFIX_LENGTH) {
    nextByte = start
    events.length = 0
    const suffix = Array.from({ length: TASK_ID_SUFFIX_LENGTH }, (_, index) => TASK_ID_ALPHABET[((start + index) % 256) % TASK_ID_ALPHABET.length]).join('')
    equal(generateTaskId(type as TaskType), prefix + suffix, `generateTaskId in src/engine/tasks/taskBase.ts must give the kind prefix then the suffix mapped through TASK_ID_ALPHABET from the random bytes; type ${type}, byte start ${start}`)
    deepStrictEqual(events, [['random', TASK_ID_SUFFIX_LENGTH]], `generateTaskId in src/engine/tasks/taskBase.ts must draw exactly one randomBytes(TASK_ID_SUFFIX_LENGTH) per id; type ${type}, byte start ${start}`)
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
    deepStrictEqual(events, ['id', 'type', 'description', 'call', 'clock', ['path', 'a01234567']], 'createTaskStateBase in src/engine/tasks/taskBase.ts must read task_id, task_type, description, call_id, then Date.now, then getTaskOutputPath, once each and in that order')
    deepStrictEqual(state, {
      id: 'a01234567', type: 'local_agent', status: 'pending', description: 'work',
      toolUseId: call, startTime: 123456, outputFile: 'output/a01234567.output', outputOffset: 0, notified: false,
    }, 'createTaskStateBase in src/engine/tasks/taskBase.ts must return the pending state with these exact fields and values')
    deepStrictEqual(Object.keys(state), ['id', 'type', 'status', 'description', 'toolUseId', 'startTime', 'outputFile', 'outputOffset', 'notified'], 'createTaskStateBase in src/engine/tasks/taskBase.ts must build the state with its keys in this order')
    equal(Object.getPrototypeOf(state), Object.prototype, 'createTaskStateBase in src/engine/tasks/taskBase.ts must return a plain object')
    equal(Object.hasOwn(state, 'toolUseId'), true, 'createTaskStateBase in src/engine/tasks/taskBase.ts must keep toolUseId as an own key even when call_id is undefined')
    equal(Object.hasOwn(state, 'endTime'), false, 'createTaskStateBase in src/engine/tasks/taskBase.ts must not set endTime on a new state')
    equal(Object.hasOwn(state, 'totalPausedMs'), false, 'createTaskStateBase in src/engine/tasks/taskBase.ts must not set totalPausedMs on a new state')
    const second = createTaskStateBase(args)
    notStrictEqual(state, second, 'createTaskStateBase in src/engine/tasks/taskBase.ts must return a new object on every call')
    state.outputOffset = 42
    equal(second.outputOffset, 0, 'createTaskStateBase in src/engine/tasks/taskBase.ts must not share state between calls')
  }
} finally {
  Date.now = clock
}
console.log('PASS: task states, every byte mapping, kind prefixes, fallback, property shape and effect order')
