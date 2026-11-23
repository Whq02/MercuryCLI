import * as React from 'react'
import { Text } from '../themedRenderer.js'
import { logError } from '../../platform/logs/errorLog.js'
import { crashReportDirDisplay, persistCrashReport } from '../../platform/logs/crashReport.js'
import { FAINT } from '../theme/mercuryPalette.js'
import { GLYPH } from '../theme/glyphs.js'

type Props = {
  children: React.ReactNode
  origin?: Parameters<typeof persistCrashReport>[2]
}

type State = {
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
    persistCrashReport(error, errorInfo, this.props.origin ?? 'message-boundary')
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <Text color={FAINT}>
          {GLYPH.warn} a part of this view could not be rendered · crash report:{' '}
          {crashReportDirDisplay()}
        </Text>
      )
    }
    return this.props.children
  }
}
