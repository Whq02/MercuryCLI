import * as React from 'react'
import { CockpitView } from '../../components/CockpitView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  // Optional first arg selects the starting tab (e.g. /cockpit fleet).
  const initial = args?.trim().split(/\s+/)[0] || undefined
  // The live permission mode lives in the tool-permission context; read it
  // defensively (default mode if the method is absent) so the Policy tab shows
  // the real mode instead of a hard-coded 'default'.
  let mode = 'default'
  try {
    mode = (await (context as typeof context & { getToolPermissionContext: () => Promise<{ mode: string }> }).getToolPermissionContext()).mode
  } catch {
    // keep default
  }
  // Close with display:'skip' so the panel leaves no "(no content)" echo.
  return (
    <CockpitView
      initial={initial}
      mode={mode}
      onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }}
    />
  )
}
