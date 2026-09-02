import * as React from 'react'
import { PaletteView } from '../../components/mercury-ui/PaletteView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// /palette — the Mercury fuzzy command palette. Renders the navigable
// PaletteView; a pick chains the chosen command back through onDone's nextInput
// (auto-submitted), exactly as the native slash picker applies a command.
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
