import * as React from 'react'
import { Box } from '../../ink.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'

export function CursorRow({ selected, flexDirection = 'row', children }: { selected: boolean; flexDirection?: 'row' | 'column'; children: React.ReactNode }): React.ReactNode {
  const cursorRef = useDeclaredCursor({ line: 0, column: 0, active: selected })
  return (
    <Box ref={cursorRef} flexDirection={flexDirection}>
      {children}
    </Box>
  )
}
