import { MercuryInputAtlas } from '../../screen/input-atlas/MercuryInputAtlas.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <MercuryInputAtlas onClose={() => onDone(undefined, { display: 'skip' })} />
}
