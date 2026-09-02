// ============================================================================
//  src/cli/exit.ts — the one place a subcommand leaf terminates the process.
//
//  Channel discipline is load-bearing: failures to stderr, successes to
//  stdout. Under test `process.exit` is commonly stubbed and allowed to
//  return, so neither helper may throw after requesting exit.
// ============================================================================

/** Optionally write `msg` to stderr, then exit 1. */
export function cliError(msg?: string): never {
  if (msg !== undefined) {
    console.error(msg)
  }
  process.exit(1)
  // Reached only when process.exit is stubbed under test.
  return undefined as never
}

/** Optionally write `msg` + newline to stdout, then exit 0. The write must
 *  reach the process stdout stream itself — the console-level wrapper
 *  bypasses instrumentation attached to that stream. */
export function cliOk(msg?: string): never {
  if (msg !== undefined) {
    process.stdout.write(`${msg}\n`)
  }
  process.exit(0)
  return undefined as never
}
