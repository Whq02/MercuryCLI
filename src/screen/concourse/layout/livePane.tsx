import React from 'react'
import { Box, paletteCollapsed } from '../../themedRenderer.js'
import type { MercuryThemeTokens } from '../../theme/mercuryTokens.js'
import type { ConcourseRegion, SwitchboardGeometry } from './shared.js'

export function livePaneOf({
  wide,
  geo,
  t,
  interior,
  region,
  mirrorRows,
  mirrorNode,
  liveComposerNode,
  liveWidth,
}: {
  wide: boolean
  geo: SwitchboardGeometry
  t: MercuryThemeTokens
  interior: number
  region: ConcourseRegion
  mirrorRows: number
  mirrorNode: (rows: number, width: number) => React.ReactNode
  liveComposerNode: ((bandRows: number, width: number) => React.ReactNode) | undefined
  liveWidth: number
}): React.ReactNode {
  const mirrorInner = Math.max(1, mirrorRows - 2 - geo.liveComposerRows)
  return geo.constrained ? (
    <>
      <Box flexDirection="column" height={mirrorRows} overflow="hidden" flexShrink={0}>
        {mirrorNode(mirrorRows, Math.max(0, interior))}
      </Box>
      {geo.liveComposerRows > 0 && liveComposerNode !== undefined ? (
        <Box flexDirection="column" height={geo.liveComposerRows} overflow="hidden" flexShrink={0}>
          {liveComposerNode(geo.liveComposerRows, interior)}
        </Box>
      ) : null}
    </>
  ) : (
    <Box
      flexDirection="column"
      width={wide ? liveWidth : undefined}
      height={mirrorRows}
      overflow="hidden"
      borderStyle={paletteCollapsed() && region === 'live' ? 'bold' : 'round'}
      borderColor={region === 'live' ? t.info : t.borderSubtle}
      paddingX={1}
      flexShrink={0}
    >
      <Box flexDirection="column" height={mirrorInner} overflow="hidden" flexShrink={0}>
        {mirrorNode(mirrorInner, Math.max(0, liveWidth - 4))}
      </Box>
      {geo.liveComposerRows > 0 && liveComposerNode !== undefined ? (
        <Box flexDirection="column" height={geo.liveComposerRows} overflow="hidden" flexShrink={0}>
          {liveComposerNode(Math.max(1, geo.liveComposerRows - 3), Math.max(0, liveWidth - 4))}
        </Box>
      ) : null}
    </Box>
  )
}
