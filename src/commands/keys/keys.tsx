import * as React from 'react'
import { MercuryInputAtlas } from '../../components/MercuryInputAtlas.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  // display:'skip' — a reference panel leaves no transcript echo (same
  // contract as /critter; a bare onDone() would emit "(no content)").
  return <MercuryInputAtlas onClose={() => onDone(undefined, { display: 'skip' })} />
}
