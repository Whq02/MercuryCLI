// The crash surface: the last frame the operator sees when the render tree
// dies. It reads as product, not as a developer dump — no stack, no bundle
// positions. Colours are plain named ANSI values on purpose: the theme
// machinery may itself be mid-crash.

import React from 'react'
import { crashReportDirDisplay } from '../../utils/crashReport.js'
import Box from './Box.js'
import Text from './Text.js'

type Props = {
  readonly error: Error
}

const SUMMARY_LIMIT = 200

/** `Name: first line of the message`, the name omitted when absent or the
 *  generic base name; a stand-in phrase when nothing survives. */
function summarize(error: Error): string {
  const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
  const firstLine = (error.message ?? '').split('\n')[0] ?? ''
  const summary = `${name}${firstLine}`.slice(0, SUMMARY_LIMIT)
  return summary.trim() === '' ? 'an unexpected render failure' : summary
}

export default function ErrorOverview({ error }: Props): React.ReactNode {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
      <Box gap={1}>
        <Text inverse color="ansi:red">
          {' RENDER ERROR '}
        </Text>
        <Text>Mercury hit a render error and this view had to close.</Text>
      </Box>
      <Text>
        Anything already saved to disk — transcript, drafts, receipts — is
        preserved.
      </Text>
      <Box flexDirection="column">
        <Text dim>{summarize(error)}</Text>
        <Text dim>
          {`Full stack and component trace in the crash report: ${crashReportDirDisplay()}`}
        </Text>
      </Box>
      <Text>Restart Mercury to continue.</Text>
    </Box>
  )
}
