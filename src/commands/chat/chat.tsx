import * as React from 'react'
import { ChatTranscriptView } from '../../components/mercury-ui/screens/ChatTranscriptView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
// Close with display:'skip' so the panel leaves no "(no content)" echo.
export const call: LocalJSXCommandCall = async onDone => (
  <ChatTranscriptView onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }} />
)
