import * as React from 'react'
import { WorkflowsBoard } from '../../components/tasks/WorkflowsBoard.js'
import { parseSpawnSwitchArg } from '../../services/switchboard/spawnSwitches.js'
import { runSpawnSwitchCommand } from '../subagents/subagents.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parsed = parseSpawnSwitchArg(args ?? '')
  if (parsed.op === 'on' || parsed.op === 'off' || parsed.op === 'unknown') {
    onDone(await runSpawnSwitchCommand('workflows', args ?? ''))
    return null
  }
  return <WorkflowsBoard onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
