import * as React from 'react'
import { ManagerView } from '../../components/mercury-ui/ManagerView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// /manager — the effective-catalogue surface index. A pick
// submits the chosen command for real (the /palette pattern); esc closes with
// display:'skip' so no "⎿ (no content)" residue line lands in the transcript.
export const call: LocalJSXCommandCall = async onDone => {
  return (
    <ManagerView
      onClose={() => onDone(undefined, { display: 'skip' })}
      onPick={name =>
        onDone(undefined, {
          nextInput: `/${name} `,
          submitNextInput: true,
        })
      }
    />
  )
}
