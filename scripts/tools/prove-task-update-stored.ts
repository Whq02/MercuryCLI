#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFixtureRunner } from '../lib/builtProduct.ts'
import type { CapturedRequest } from '../lib/fixtureApi.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const LIST_ID = 'task-update-stored-proof'
const CONFIG_HOME = mkdtempSync(join(tmpdir(), 'task-update-stored-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function findToolResultText(reqs: CapturedRequest[], toolUseId: string): string | null {
  for (const req of reqs) {
    const body = req.body as { messages?: Array<{ content?: unknown }> } | null
    for (const msg of body?.messages ?? []) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block && typeof block === 'object' && block.type === 'tool_result' && block.tool_use_id === toolUseId) {
          if (typeof block.content === 'string') return block.content
          if (Array.isArray(block.content)) {
            return block.content.map((c: { text?: string }) => c.text ?? '').join('')
          }
        }
      }
    }
  }
  return null
}

type StoredTask = {
  id: string
  subject: string
  description: string
  status: string
  owner?: string
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
}

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-task-update-stored exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

try {
  await withFixtureRunner(
    [
      { kind: 'tool_use', name: 'ToolSearch', id: 'toolu_search', input: { query: 'select:TaskCreate,TaskUpdate,TaskList,TaskGet' } },
      { kind: 'tool_use', name: 'TaskCreate', id: 'toolu_create_1', input: { subject: 'Draft design', description: 'First task', metadata: { area: 'parser', obsolete: 'drop-me' } } },
      { kind: 'tool_use', name: 'TaskCreate', id: 'toolu_create_2', input: { subject: 'Write implementation', description: 'Second task', metadata: { area: 'core', stale: true } } },
      { kind: 'tool_use', name: 'TaskCreate', id: 'toolu_create_3', input: { subject: 'Land prerequisite', description: 'Third task' } },
      { kind: 'tool_use', name: 'TaskUpdate', id: 'toolu_block_pre_del', input: { taskId: '1', addBlocks: ['2'] } },
      { kind: 'tool_use', name: 'TaskUpdate', id: 'toolu_delete_1', input: { taskId: '1', status: 'deleted' } },
      {
        kind: 'tool_use',
        name: 'TaskUpdate',
        id: 'toolu_update_2',
        input: {
          taskId: '2',
          addBlockedBy: ['3'],
          owner: 'worker-b',
          status: 'in_progress',
          metadata: { stale: null, priority: 'high' },
        },
      },
      { kind: 'tool_use', name: 'TaskUpdate', id: 'toolu_missing_edge', input: { taskId: '3', addBlocks: ['999'] } },
      { kind: 'tool_use', name: 'TaskList', id: 'toolu_list', input: {} },
      { kind: 'tool_use', name: 'TaskGet', id: 'toolu_get_deleted', input: { taskId: '1' } },
      { kind: 'tool_use', name: 'TaskGet', id: 'toolu_get_3', input: { taskId: '3' } },
      { kind: 'text', text: 'Task updates verified.' },
    ],
    async (runner, api) => {
      await runner.prompt('Create three tasks, delete task 1, block task 2 on task 3, set owner and metadata, then list.')
      await runner.waitFor('turn completes', row => row.type === 'outcome', 60_000)

      const reqs = api.messageRequests().filter(r => !r.path.includes('count_tokens'))
      const deleteResult = findToolResultText(reqs, 'toolu_delete_1') ?? ''
      const updateResult = findToolResultText(reqs, 'toolu_update_2') ?? ''
      const missingEdgeResult = findToolResultText(reqs, 'toolu_missing_edge') ?? ''
      const listResult = findToolResultText(reqs, 'toolu_list') ?? ''
      const getDeletedResult = findToolResultText(reqs, 'toolu_get_deleted') ?? ''
      const getThreeResult = findToolResultText(reqs, 'toolu_get_3') ?? ''

      check(
        'TaskUpdate status deleted reports task 1 deleted',
        deleteResult.includes('Updated task 1') && deleteResult.includes('deleted'),
        deleteResult,
      )
      check(
        'TaskUpdate on task 2 reports owner, metadata, status, and blockedBy updated',
        updateResult.includes('Updated task 2') &&
          updateResult.includes('owner') &&
          updateResult.includes('metadata') &&
          updateResult.includes('status') &&
          updateResult.includes('blockedBy'),
        updateResult,
      )
      check(
        'TaskUpdate with missing dependency endpoint refuses honestly and names the missing id',
        missingEdgeResult.includes('999 (blocks)') && missingEdgeResult.includes('missing task endpoints'),
        missingEdgeResult,
      )

      const listLines = listResult.split('\n')
      check(
        'TaskList shows exactly tasks #2 and #3 with owner and blocker, omitting deleted #1',
        listLines.length === 2 &&
          listLines[0] === '#2 [in_progress] Write implementation (worker-b) [blocked by #3]' &&
          listLines[1] === '#3 [pending] Land prerequisite',
        JSON.stringify(listLines),
      )
      check('TaskGet on deleted task #1 returns Task not found', getDeletedResult === 'Task not found', getDeletedResult)
      check('TaskGet on task #3 reports Blocks: #2', getThreeResult.includes('Blocks: #2'), getThreeResult)

      const tasksDir = join(CONFIG_HOME, 'tasks', LIST_ID)
      const file1 = join(tasksDir, '1.json')
      const file2 = join(tasksDir, '2.json')
      const file3 = join(tasksDir, '3.json')
      const watermarkFile = join(tasksDir, '.highwatermark')

      check('stored file for deleted task #1 is removed from disk', !existsSync(file1), file1)
      check('highwatermark file is recorded so deleted id #1 is not reused', existsSync(watermarkFile) && Number(readFileSync(watermarkFile, 'utf8').trim()) >= 1)

      const stored2 = existsSync(file2) ? (JSON.parse(readFileSync(file2, 'utf8')) as StoredTask) : null
      check(
        'stored record for task #2 holds owner, in_progress status, blockedBy [#3] with deleted #1 scrubbed, and merged metadata with null key removed',
        stored2 !== null &&
          stored2.id === '2' &&
          stored2.status === 'in_progress' &&
          stored2.owner === 'worker-b' &&
          JSON.stringify(stored2.blockedBy) === JSON.stringify(['3']) &&
          JSON.stringify(stored2.blocks) === JSON.stringify([]) &&
          stored2.metadata?.area === 'core' &&
          stored2.metadata?.priority === 'high' &&
          !('stale' in (stored2.metadata ?? {})),
        JSON.stringify(stored2),
      )

      const stored3 = existsSync(file3) ? (JSON.parse(readFileSync(file3, 'utf8')) as StoredTask) : null
      check(
        'stored record for task #3 holds bidirectional blocks [#2] and omits refused missing id #999',
        stored3 !== null &&
          stored3.id === '3' &&
          stored3.status === 'pending' &&
          stored3.owner === undefined &&
          JSON.stringify(stored3.blocks) === JSON.stringify(['2']) &&
          JSON.stringify(stored3.blockedBy) === JSON.stringify([]),
        JSON.stringify(stored3),
      )
    },
    { env: { MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_TASKS: '1', MERCURY_TASK_LIST_ID: LIST_ID } },
  )
} finally {
  clearTimeout(guard)
  removeScratch(CONFIG_HOME)
}

console.log(failures === 0 ? '\nprove-task-update-stored: ALL CHECKS PASS' : `\nprove-task-update-stored: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
