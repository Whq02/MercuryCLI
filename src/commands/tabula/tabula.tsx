import * as React from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { MinervaRoom } from '../../components/tabula/MinervaRoom.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return (
    <MinervaRoom
      cwd={getOriginalCwd()}
      onClose={(nextInput?: string) =>
        nextInput !== undefined && nextInput.trim().length > 0
          ? onDone(undefined, { display: 'skip', nextInput })
          : onDone(undefined, { display: 'skip' })
      }
    />
  )
}
