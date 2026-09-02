// =============================================================================
// globPreamble — the Bash tool's shell-glob normalization preamble.
//
// Deliberately a LEAF module (zero imports) so the proof
// (scripts/bash/prove-glob-preamble.ts) can bun-import the REAL function and
// run its output through real /bin/zsh and /bin/bash — bashProvider itself is
// not bun-loadable (transitive harness deps).
// =============================================================================

/**
 * Returns the shell-glob normalization preamble (runs after user config is
 * sourced, so it wins):
 *  • Disables extended glob patterns for security. Extended globs (bash
 *    extglob, zsh EXTENDED_GLOB) can be exploited via malicious filenames
 *    that expand after our security validation.
 *  • zsh only: NO_NOMATCH restores bash's unmatched-glob semantics (pass the
 *    pattern through literally). zsh's default NOMATCH aborts the whole
 *    command with "no matches found" — fatal to exploratory globs from a
 *    model trained on bash conventions for a tool literally named Bash
 * Bash needs nothing: failglob is off
 *    by default.
 *
 * When MERCURY_SHELL_PREFIX is set, the actual executing shell may differ
 * from shellPath (e.g., shellPath is zsh but the wrapper runs bash). In this
 * case, we include commands for BOTH shells — the setopt leg only executes
 * where shopt failed, i.e. under zsh, so it carries the zsh-only options. We
 * redirect both stdout and stderr to /dev/null because zsh's
 * command_not_found_handler writes to STDOUT.
 *
 * When no shell prefix is set, we use the appropriate command for the detected shell.
 */
export function getGlobPreambleCommand(shellPath: string): string | null {
  // When a shell prefix is set, the wrapper may use a different shell
  // than shellPath, so we include both bash and zsh commands
  if (process.env.MERCURY_SHELL_PREFIX) {
    // Redirect both stdout and stderr because zsh's command_not_found_handler
    // writes to stdout instead of stderr
    return '{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_NOMATCH; } >/dev/null 2>&1 || true'
  }

  // No shell prefix - use shell-specific command
  if (shellPath.includes('bash')) {
    return 'shopt -u extglob 2>/dev/null || true'
  } else if (shellPath.includes('zsh')) {
    return 'setopt NO_EXTENDED_GLOB NO_NOMATCH 2>/dev/null || true'
  }
  // Unknown shell - do nothing, we don't know the right command
  return null
}
