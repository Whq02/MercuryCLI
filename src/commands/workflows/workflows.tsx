import * as React from 'react'
import { WorkflowsBoard } from '../../components/tasks/WorkflowsBoard.js'
import { parseSpawnSwitchArg } from '../../services/switchboard/spawnSwitches.js'
import { runSpawnSwitchCommand } from '../subagents/subagents.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// Each Mercury view is a self-contained <View onClose>.
// LIVE board — mounts the run board (board → run → agent) reading
// AppState.tasks + the on-disk run manifests. (The old illustrative
// "missions DAG" specimen was deleted with the /orch gallery —
//
// `/workflows on|off` is the focused session's WORKFLOWS switch (the
// sub-agents switch's sibling, services/switchboard/spawnSwitches.ts): the
// Workflow tool leaves or rejoins the roster at the next turn boundary; the
// board itself stays readable either way.
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseSpawnSwitchArg(args ?? '')
  if (parsed.op === 'on' || parsed.op === 'off' || parsed.op === 'unknown') {
    onDone(await runSpawnSwitchCommand('workflows', args ?? ''))
    return null
  }
  return <WorkflowsBoard onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
