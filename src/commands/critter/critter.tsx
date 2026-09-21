import * as React from 'react'
import { CritterSelect } from '../../components/CritterSelect.js'
import { setCritterSize } from '../../utils/cockpit/critterSize.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const want = (args ?? '').trim().toLowerCase()
  if (want === 'mini' || want === 'full') {
    setCritterSize(want)
    onDone(undefined, { display: 'skip' })
    return null
  }
  return <CritterSelect onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
