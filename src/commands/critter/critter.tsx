import { CritterSelect } from './CritterSelect.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <CritterSelect onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
}
