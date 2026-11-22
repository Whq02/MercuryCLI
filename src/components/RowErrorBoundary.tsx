import * as React from 'react'
import { Text } from '../ink.js'
import { logError } from '../utils/log.js'
import { crashReportDirDisplay, persistCrashReport } from '../utils/crashReport.js'
import { FAINT } from './mercuryPalette.js'
import { GLYPH } from '../utils/glyphs.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type Props = Unbuilt

type State = Unbuilt

export class RowErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    notBuilt('src/components/RowErrorBoundary.tsx:18')
    super(notBuilt('src/components/RowErrorBoundary.tsx:18'))
  }

  static getDerivedStateFromError(): State {
    return notBuilt('src/components/RowErrorBoundary.tsx:23')
  }

  override componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
    return notBuilt('src/components/RowErrorBoundary.tsx:27')
  }

  override render(): React.ReactNode {
    return notBuilt('src/components/RowErrorBoundary.tsx:32')
  }
}
