import * as React from 'react'
import { CritterSelect } from '../../components/CritterSelect.js'
import { getCritterSize, setCritterSize } from '../../utils/cockpit/critterSize.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const want = (args ?? '').trim().toLowerCase()
  if (want === '' || want === 'on' || want === 'off') {
    setCritterSize(want === 'on' ? 'full' : want === 'off' ? 'mini' : getCritterSize() === 'mini' ? 'full' : 'mini')
    onDone(undefined, { display: 'skip' })
    return null
  }
  return <CritterSelect onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
