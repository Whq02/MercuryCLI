import { initializeErrorLogSink } from './errorLogSink.js'

/**
 * Attach the error log sink. Idempotent. setup() runs this for the default
 * command; entrypoints that never pass through setup() — subcommands, the
 * daemon, the bridge — invoke it themselves.
 *
 * The analytics sink is ABSENT: logEvent and its pre-attach queue
 * were structurally deleted with the telemetry estate, so there is nothing
 * to drain — boot memory-flatness holds by construction now.
 *
 * A leaf on purpose: folding this into setup.ts would close the setup →
 * commands → bridge → setup import cycle.
 */
export function initSinks(): void {
  initializeErrorLogSink()
}
