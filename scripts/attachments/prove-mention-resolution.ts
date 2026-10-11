import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'

const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[arg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'mention-resolution-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
try {
  const { processAgentMentions, processMcpResourceAttachments, processAtMentionedFiles } = await import(`${root}/src/utils/attachments/mentionResolvers.ts`)
  assert.deepEqual(processAgentMentions('@agent-code @agent-missing @agent-review', [{ agentType: 'code' }, { agentType: 'review' }] as never), [{ type: 'agent_mention', agentType: 'code' }, { type: 'agent_mention', agentType: 'review' }])
  assert.deepEqual(await processAtMentionedFiles('plain words', {} as never), [])
  assert.deepEqual(await processMcpResourceAttachments('plain words', {} as never), [])
  console.log('PASS agent admission and context-free empty mentions')
  const calls: string[] = []
  const context = {
    options: {
      mcpClients: [
        { name: 'ready', type: 'connected', client: { async readResource({ uri }: { uri: string }) { calls.push(uri); if (uri === 'fail') throw new Error('fixture read failure'); return { contents: [{ uri, text: uri }] } } } },
        { name: 'offline', type: 'pending' },
      ],
      mcpResources: { ready: [{ uri: 'scheme:a:b', name: '', description: 'desc' }, { uri: 'next', name: 'Next' }, { uri: 'fail', name: 'Fail' }], offline: [{ uri: 'file', name: 'File' }] },
    },
  }
  const resources = await processMcpResourceAttachments('@ready:scheme:a:b @ready:missing @offline:file @ready:fail @ready:next', context as never)
  assert.deepEqual(calls, ['scheme:a:b', 'fail', 'next'])
  assert.deepEqual(resources, [
    { type: 'mcp_resource', server: 'ready', uri: 'scheme:a:b', name: 'scheme:a:b', description: 'desc', content: { contents: [{ uri: 'scheme:a:b', text: 'scheme:a:b' }] } },
    { type: 'mcp_resource', server: 'ready', uri: 'next', name: 'Next', description: undefined, content: { contents: [{ uri: 'next', text: 'next' }] } },
  ])
  console.log('PASS listed connected resources preserve URI colons, metadata, order and read failures')
  const directory = join(scratch, 'directory')
  mkdirSync(directory)
  for (let index = 0; index < 1002; index++) writeFileSync(join(directory, `entry-${String(index).padStart(4, '0')}`), '')
  let stateReads = 0
  const fileContext = { getAppState() { stateReads++; return { toolPermissionContext: { mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map() } } }, options: {} }
  assert.deepEqual(await processAtMentionedFiles('@//not-a-local-path', fileContext as never), [])
  const rows = await processAtMentionedFiles(`@${directory}`, fileContext as never)
  const { getCwd } = await import(`${root}/src/utils/cwd.ts`)
  assert.deepEqual(rows, [{ type: 'directory', path: directory, content: [...readdirSync(directory).slice(0, 1000), '… and 2 more entries'].join('\n'), displayPath: relative(getCwd(), directory) }])
  assert.equal(stateReads, 2)
  console.log('PASS UNC omission and capped directory listing with one state read per prompt')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log('PASS mention resolution')
