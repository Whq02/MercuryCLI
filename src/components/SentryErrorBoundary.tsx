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

export class SentryErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  // log the swallowed render error. The one-line fallback below is the
  // INTENDED per-message degradation (this boundary wraps individual tool/message
  // renderers, so one bad message degrades itself instead of crashing the whole
  // transcript) — but without this the error vanished silently and was undiagnosable.
  override componentDidCatch(error: unknown, errorInfo: React.ErrorInfo): void {
    logError(error)
    // Post- crash fix: the swallowed per-message crash now
    // leaves an on-disk report with the component stack (logError is
    // in-memory telemetry only).
    persistCrashReport(error, errorInfo, 'message-boundary')
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      // a broken section degrades VISIBLY — the null
      // fallback silently hid real content (a transcript message's hook rows,
      // the prompt notifications) with zero indication. One quiet line,
      // product language, consumer-neutral, pointing at the retained crash
      // report (persistCrashReport above writes it in this same commit).
      return (
        <Text color={FAINT}>
          {GLYPH.warn} a part of this view could not be rendered · crash report: {crashReportDirDisplay()}
        </Text>
      )
    }

    return this.props.children
  }
}
