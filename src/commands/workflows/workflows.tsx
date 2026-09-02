import * as React from 'react'
import { WorkflowsBoard } from '../../components/tasks/WorkflowsBoard.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// Each Mercury view is a self-contained <View onClose>.
// LIVE board — mounts the run board (board → run → agent) reading
// AppState.tasks + the on-disk run manifests. (The old illustrative
// "missions DAG" specimen was deleted with the /orch gallery —
// 
export const call: LocalJSXCommandCall = async onDone => {
  return <WorkflowsBoard onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
