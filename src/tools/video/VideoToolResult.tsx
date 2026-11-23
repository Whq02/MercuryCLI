import React from 'react'
import { pathToFileURL } from 'node:url'
import { Box, Text } from '../../screen/themedRenderer.js'
import Link from '../../screen/renderer/elements/Link.js'
import { WithCardTone } from '../../screen/widgets/toolCardGrammar.js'
import { FAINT } from '../../screen/theme/mercuryPalette.js'
import type { VideoOutput } from '../../integrations/video-shapes/types.js'

export function VideoToolResult({ output }: { output: VideoOutput }): React.ReactNode {
  return <WithCardTone state={output.outcome}>
    {({ glyph, tone }) => <Box flexDirection="column">
      <Text color={tone}>{glyph} Video</Text>
      {output.result.split('\n').map((line, index) => <Text key={index} color={FAINT}>  {line}</Text>)}
      {output.framePath ? <Text>  <Link url={pathToFileURL(output.framePath).href} fallback={output.framePath}>Open frame at 1s</Link></Text> : null}
    </Box>}
  </WithCardTone>
}
