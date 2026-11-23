import { initializeErrorLogSink } from '../platform/logs/errorLogSink.js'

export function initSinks(): void {
  initializeErrorLogSink()
}
