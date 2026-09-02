import * as React from 'react'
import { ManagerView } from '../../components/mercury-ui/ManagerView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

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
