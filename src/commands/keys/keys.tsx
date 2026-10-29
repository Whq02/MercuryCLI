import * as React from 'react'
import { MercuryInputAtlas } from '../../components/MercuryInputAtlas.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <MercuryInputAtlas onClose={() => onDone(undefined, { display: 'skip' })} />
}
