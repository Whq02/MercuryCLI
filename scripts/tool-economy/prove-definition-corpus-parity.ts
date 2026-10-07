import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { mock, setSystemTime } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
setSystemTime(new Date('2026-10-07T12:00:00.000Z'))

const root = join(import.meta.dir, '..', '..')
const fixture = join(import.meta.dir, 'fixtures', 'definition-corpus.json')
const base = '2c8bb4b207d4ad93beedcad9a70e21e5dd61f388'
const model = 'gpt-6-astra'
const record = process.argv.includes('--record-once')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

if (record) {
  assert.equal(git('rev-parse', 'HEAD'), base, 'the corpus is recorded only at its base')
  assert.equal(git('diff', '--name-only', 'HEAD', '--', 'src'), '', 'record before changing product source')
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const interpreters = await import('../../src/services/eval/interpreters.ts')
mock.module('../../src/services/eval/interpreters.js', () => ({
  ...interpreters,
  primeEvalAvailability: async () => [
    { language: 'py', available: true, interpreterPath: 'python3', version: 'Python 3.14.7' },
    { language: 'js', available: true, interpreterPath: 'node', version: 'v24.21.0' },
  ],
}))
const { getAllBaseTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const tools = getAllBaseTools().filter(tool => tool.name !== ComputerTool.name)
const browserIndex = tools.findIndex(tool => tool.name === 'Browser')
assert.notEqual(browserIndex, -1, 'the corpus has its desktop insertion point')
tools.splice(browserIndex + 1, 0, ComputerTool)
assert.equal(tools.length, 58, 'the corpus covers all 58 base catalogue entries')
assert.equal(new Set(tools.map(tool => tool.name)).size, 58, 'every definition has a distinct name')
const permissionContext = getEmptyToolPermissionContext()
const definitions = []
for (const tool of tools) {
  definitions.push(await toolToAPISchema(tool, {
    getToolPermissionContext: async () => permissionContext,
    tools,
    agents: [],
    model,
  }))
}
const bytes = JSON.stringify({ base, model, definitions }, null, 2) + '\n'
if (record) {
  writeFileSync(fixture, bytes, { flag: 'wx' })
  console.log('RECORDED 58 definitions from the base')
}
assert.equal(bytes, readFileSync(fixture, 'utf8'), 'every definition remains byte-identical in catalogue order')
console.log(`PASS CORPUS 58 definitions identical; ${Buffer.byteLength(bytes)} bytes; sha256 ${createHash('sha256').update(bytes).digest('hex')}`)
