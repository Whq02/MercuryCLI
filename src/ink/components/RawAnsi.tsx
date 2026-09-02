// A constant-measure leaf for content that is already terminal-ready: one
// element carrying the newline-joined text, the declared width and the line
// count, handed straight to the buffer write. Skips the whole parse →
// spans → layout → re-serialise round trip.

import React from 'react'

type Props = {
  /** Pre-rendered ANSI lines, each EXACTLY one terminal row (already
   *  wrapped by the producer). */
  readonly lines: readonly string[]
  /** The column width the producer wrapped to. */
  readonly width: number
}

export function RawAnsi({ lines, width }: Props): React.ReactNode {
  if (lines.length === 0) return null
  return (
    <ink-raw-ansi
      rawText={lines.join('\n')}
      rawWidth={width}
      rawHeight={lines.length}
    />
  )
}
