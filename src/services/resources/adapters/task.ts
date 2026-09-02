// resources/adapters/task — the durable task ledger (mercury://task/<id>,
// listing at mercury://task). Reads the REAL task store (utils/tasks.ts) —
// never a second task DB.

import { getTask, getTaskListId, listTasks } from '../../../utils/tasks.js'
import {
  formatRef,
  type ParsedRef,
  type ResourceAdapter,
  type ResourceResult,
} from '../contracts.js'

export const taskAdapter: ResourceAdapter = {
  kind: 'task',
  describe: 'the durable task ledger (mercury://task/<id>)',
  async resolve(ref: ParsedRef): Promise<ResourceResult> {
    const listId = getTaskListId()
    if (ref.id === '') {
      const tasks = await listTasks(listId)
      const sorted = [...tasks].sort((a, b) => Number(a.id) - Number(b.id))
      return {
        state: 'ok',
        resource: {
          ref: 'mercury://task',
          kind: 'task',
          title: 'task ledger',
          summary: `${tasks.length} task(s) · ${tasks.filter(t => t.status === 'completed').length} completed`,
          version: `n${tasks.length}`,
          mutable: true,
          children: sorted.slice(0, 100).map(t => ({
            ref: formatRef('task', t.id),
            title: `#${t.id} ${t.subject}`,
            summary: t.status,
          })),
        },
      }
    }
    const task = await getTask(listId, ref.id)
    if (!task) {
      return { state: 'absent', note: `no task '${ref.id}' in the ledger` }
    }
    return {
      state: 'ok',
      resource: {
        ref: ref.canonical,
        kind: 'task',
        title: `#${task.id} ${task.subject}`,
        summary: `${task.status}${task.owner ? ` · owner ${task.owner}` : ''}`,
        version: task.status,
        mutable: true,
        text: [
          `subject: ${task.subject}`,
          `status: ${task.status}`,
          ...(task.owner ? [`owner: ${task.owner}`] : []),
          ...(task.blockedBy?.length ? [`blockedBy: ${task.blockedBy.join(', ')}`] : []),
          '',
          task.description,
        ].join('\n'),
        structured: { id: task.id, status: task.status, subject: task.subject },
      },
    }
  },
}
