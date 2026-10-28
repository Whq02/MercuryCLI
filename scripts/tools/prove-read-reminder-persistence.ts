import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'read-reminder-persistence-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BARE = '1'
delete process.env.MERCURY_HOME
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
try {
  const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  const { setEngineModelOverride } = await import('../../src/bootstrap/state.ts')
  enableConfigs()
  const context: any = { messages: [], readFileState: createFileStateCacheWithSizeLimit(100), abortController: new AbortController(), updateFileHistoryState: () => {}, getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext() }) }
  const files = ['a', 'b', 'c', 'd'].map(name => join(scratch, name + '.txt'))
  for (const file of files) writeFileSync(file, 'alpha\nbeta\n')
  const text = (data: any) => String(FileReadTool.mapToolResultToToolResultBlockParam(data, 'proof').content)
  const read = (file: string, parent?: any) => FileReadTool.call({ file_path: file }, context, undefined, parent)
  const first = await read(files[0]!)
  assert.ok(text(first.data).includes('Assess harm in context'))
  context.messages.push({ type: 'attachment', attachment: { type: 'file', filename: files[0], content: first.data } })
  const second = await read(files[1]!)
  console.log(JSON.stringify({ firstBytes: Buffer.byteLength(text(first.data)), laterBytes: Buffer.byteLength(text(second.data)) }))
  assert.ok(!text(second.data).includes('Assess harm in context'), 'a harness Read after an attached Read must not repeat the instruction')
  const restored = FileReadTool.outputSchema!.parse(JSON.parse(JSON.stringify(second.data)))
  assert.equal(text(restored), text(second.data), 'the reminder decision survives persistence')
  const own = await read(files[2]!, { message: { id: 'read-persistence-parent' } })
  assert.ok(!text(own.data).includes('Assess harm in context'), 'a tool Read sees the already attached instruction')
  assert.equal(text(FileReadTool.outputSchema!.parse(JSON.parse(JSON.stringify(own.data)))), text(own.data))
  setEngineModelOverride('claude-opus-4-6' as never)
  assert.equal(text(first.data), text(FileReadTool.outputSchema!.parse(JSON.parse(JSON.stringify(first.data)))) , 'reconstruction remains identical after a model switch')
  assert.ok(text(first.data).includes('Assess harm in context'), 'an already emitted reminder never disappears on a model switch')
  setEngineModelOverride(undefined)
  context.messages = []
  const afterFold = await read(files[3]!)
  assert.ok(text(afterFold.data).includes('Assess harm in context'), 'a new context without the original instruction restores it')
  console.log('PASS Read reminder is delivered once and its bytes survive persistence')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
