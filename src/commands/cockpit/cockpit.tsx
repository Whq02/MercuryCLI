import * as React from 'react'
import { CockpitView } from '../../components/CockpitView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const initial = args?.trim().split(/\s+/)[0] || undefined
  let mode = 'default'
  try {
    mode = (await (context as typeof context & { getToolPermissionContext: () => Promise<{ mode: string }> }).getToolPermissionContext()).mode
  } catch {
  }
  return (
    <CockpitView
      initial={initial}
      mode={mode}
      onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }}
    />
  )
}
