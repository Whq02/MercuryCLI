import * as React from 'react'
import { PaletteView } from '../../components/mercury-ui/PaletteView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return (
    <PaletteView
      onClose={() => onDone()}
      onPick={name =>
        onDone(undefined, {
          nextInput: `/${name} `,
          submitNextInput: true,
        })
      }
    />
  )
}
