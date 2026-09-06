import * as React from 'react'
import { Text } from '../ink.js'
import { logError } from '../utils/log.js'
import { crashReportDirDisplay, persistCrashReport } from '../utils/crashReport.js'
import { FAINT } from './mercuryPalette.js'
import { GLYPH } from './mercury-ui/glyphs.js'

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

export class RowErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  override componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
    logError(error)
    persistCrashReport(error, errorInfo, 'message-boundary')
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <Text color={FAINT}>
          {GLYPH.warn} a part of this view could not be rendered · crash report: {crashReportDirDisplay()}
        </Text>
      )
    }

    return this.props.children
  }
}
