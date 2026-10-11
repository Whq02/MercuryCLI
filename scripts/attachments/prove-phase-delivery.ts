import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { join, resolve } from 'node:path'

const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const engine = await import(join(root, 'services/instructions/engine.ts'))
const bootstrap = await import(join(root, 'bootstrap/state.ts'))
const permissions = await import(join(root, 'utils/permissions/filesystem.ts'))
const framework = await import(join(root, 'utils/task/framework.ts'))
const { getNestedMemoryAttachmentsForFile, getDirectoriesToProcess } = await import(join(root, 'utils/attachments/nestedMemory.ts'))
const { getUnifiedTaskAttachments } = await import(join(root, 'utils/attachments/taskStatus.ts'))
const base = resolve(process.env.MERCURY_CONFIG_DIR!, 'project')
const file = join(base, 'sub', 'deep', 'file.ts')
const context = { readFileState: new Map(), loadedNestedMemoryPaths: new Set() }
const events: string[] = []
const ledgers: Set<string>[] = []
let allowed = true
let failAt = ''
const entry = (key: string) => ({ path: join(base, key + '.md'), content: key, type: 'Project' })
const spies = [
  spyOn(bootstrap, 'getOriginalCwd').mockReturnValue(base),
  spyOn(permissions, 'pathInAllowedWorkingPath').mockImplementation(() => allowed),
  spyOn(engine, 'getManagedAndUserConditionalInstructionRules').mockImplementation(async (_path, seen) => { events.push('managed'); ledgers.push(seen); return [entry('managed')] as never }),
  spyOn(engine, 'getInstructionFilesForNestedDirectory').mockImplementation(async (directory, _path, seen) => {
    assert(context.readFileState.has(join(base, 'managed.md')))
    events.push('nested:' + directory); ledgers.push(seen)
    if (directory === failAt) throw new Error('fixture phase failure')
    return [entry('nested-' + events.length)] as never
  }),
  spyOn(engine, 'getConditionalInstructionRulesForCwdLevelDirectory').mockImplementation(async (directory, _path, seen) => { events.push('root:' + directory); ledgers.push(seen); return [entry('root-' + events.length)] as never }),
]
try {
  const directories = getDirectoriesToProcess(file, base)
  const rows = await getNestedMemoryAttachmentsForFile(file, context as never, { toolPermissionContext: {} } as never)
  assert.deepEqual(events, ['managed', ...directories.nestedDirs.map((directory: string) => 'nested:' + directory), ...directories.cwdLevelDirs.map((directory: string) => 'root:' + directory)])
  assert.equal(rows.length, events.length)
  assert(ledgers.every(seen => seen === ledgers[0]))
  assert.equal(context.readFileState.size, events.length)
  events.length = 0; ledgers.length = 0; context.readFileState.clear(); context.loadedNestedMemoryPaths.clear()
  failAt = directories.nestedDirs[0]!
  const partial = await getNestedMemoryAttachmentsForFile(file, context as never, { toolPermissionContext: {} } as never)
  assert.equal(partial.length, 1)
  assert.deepEqual(events, ['managed', 'nested:' + failAt])
  allowed = false; events.length = 0
  assert.deepEqual(await getNestedMemoryAttachmentsForFile(file, context as never, { toolPermissionContext: {} } as never), [])
  assert.deepEqual(events, [])
  console.log('PASS nested phase order, live admission before next load, shared ledger, partial failure and allowed-path gate')
  const state = { fixture: true }
  const offsets = new Map([['task', 9]])
  const evictions = ['finished']
  const setState = () => {}
  spies.push(spyOn(framework, 'generateTaskAttachments').mockImplementation(async value => { assert.equal(value, state); events.push('generate'); return { updatedTaskOffsets: offsets, evictedTaskIds: evictions, attachments: [] } as never }))
  spies.push(spyOn(framework, 'applyTaskOffsetsAndEvictions').mockImplementation((setter, positions, removed) => { assert.equal(setter, setState); assert.equal(positions, offsets); assert.equal(removed, evictions); events.push('apply') }))
  assert.deepEqual(await getUnifiedTaskAttachments({ getAppState: () => { events.push('state'); return state }, setAppState: setState } as never), [])
  assert.deepEqual(events, ['state', 'generate', 'apply'])
  console.log('PASS task sweep awaits generation, applies exact offsets/evictions and attaches nothing')
} finally { for (const spy of spies) spy.mockRestore() }
