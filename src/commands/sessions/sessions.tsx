import type { UUID } from 'crypto'
import * as React from 'react'
import { SessionManagerView } from '../../components/mercury-ui/screens/SessionManagerView.js'
import type { ResumeEntrypoint } from '../../commands.js'
import type { LogOption } from '../../types/logs.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// /sessions — the LIVE project-scoped session manager, mounted DIRECTLY
// (: the SpecimenGallery hop + the mislabelled-planned
// teammate row are absent; teammate chats are their own live surface,
// /teammates). The REPL's in-place session swap (resume()) is exposed to
// every local-jsx command as context.resume — the same capability /resume
// uses — so ↵ switches for real and `n` opens a fresh session.
export const call: LocalJSXCommandCall = async (onDone, context) => {
  const live = context.resume

  const onResume = live
    ? (sessionId: UUID, log: LogOption, entrypoint: ResumeEntrypoint) =>
        context.resume!(sessionId, log, entrypoint)
    : undefined

  // `n` = new session in-place: close the panel and submit /clear, which runs
  // the REPL's real clear path (regenerateSessionId + reset) with the proper
  // refs. No faked/duplicated clear machinery; switch-not-concurrent stays
  // honest (the prior session's JSONL is preserved + resumable via ↵).
  const onNewSession = live
    ? () =>
        onDone(undefined, {
          display: 'skip',
          nextInput: '/clear',
          submitNextInput: true,
        })
    : undefined

  // Close with display:'skip' so esc-ing out never leaves a "⎿ (no content)"
  // command-residue line (the command produced no user-visible result).
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
