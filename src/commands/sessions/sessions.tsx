import type { UUID } from 'crypto'
import * as React from 'react'
import { SessionManagerView } from '../../components/mercury-ui/screens/SessionManagerView.js'
import type { ResumeEntrypoint } from '../../commands.js'
import type { LogOption } from '../../types/logs.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const live = context.resume

  const onResume = live
    ? (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) =>
        context.resume!(sessionId, log, entrypoint)
    : undefined

  const onNewSession = live
    ? () =>
        onDone(undefined, {
          display: 'skip',
          nextInput: '/clear',
          submitNextInput: true,
        })
    : undefined

  return (
    <SessionManagerView
      onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => {
        const v = typeof value === 'string' ? value : undefined
        onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined))
      }}
      onCloseAll={() => onDone(undefined, { display: 'skip' })}
      onResume={onResume}
      onNewSession={onNewSession}
    />
  )
}
