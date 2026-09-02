import * as React from 'react'
import { PolicyPanel } from '../../components/PolicyPanel.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { ToolPermissionContext } from '../../Tool.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  // The live permission mode lives in the tool-permission context; read it
  // defensively (default mode if the method is absent).
  let mode = 'default'
  try {
    mode = (await (context as typeof context & { getToolPermissionContext: () => Promise<ToolPermissionContext> }).getToolPermissionContext()).mode
  } catch {
    // keep default
  }
  // Close with display:'skip' so the panel leaves no "(no content)" echo.
  return <PolicyPanel mode={mode} onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
