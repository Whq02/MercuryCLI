import React from 'react'
import { pathToFileURL } from 'node:url'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import { WithCardTone } from '../../components/mercury-ui/toolCardGrammar.js'
import { FAINT } from '../../components/mercuryPalette.js'
import type { VideoOutput } from '../../services/video/types.js'

export function VideoToolResult({ output }: { output: VideoOutput }): React.ReactNode {
  return <WithCardTone state={output.outcome}>
    {({ glyph, tone }) => <Box flexDirection="column">
      <Text color={tone}>{glyph} Video</Text>
      {output.result.split('\n').map((line, index) => <Text key={index} color={FAINT}>  {line}</Text>)}
      {output.framePath ? <Text>  <Link url={pathToFileURL(output.framePath).href} fallback={output.framePath}>Open frame at 1s</Link></Text> : null}
    </Box>}
  </WithCardTone>
}
