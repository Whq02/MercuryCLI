/**
 * PowerShell common parameters — accepted by every cmdlet through the standard
 * cmdlet-binding attribute. They only route error/warning/progress streams and
 * cannot make a read-only cmdlet write, so they are merged into the per-cmdlet
 * known-parameter sets (path validation) and the safe-flag check (read-only
 * validation). Lives here so both consumers reach it without an import cycle.
 */

/** Common switch parameters (contract data). Lowercase, leading dash. */
export const COMMON_SWITCHES: string[] = ['-verbose', '-debug']

/** Common value parameters (contract data). Lowercase, leading dash. */
export const COMMON_VALUE_PARAMS: string[] = [
  '-erroraction', '-warningaction', '-informationaction', '-progressaction',
  '-errorvariable', '-warningvariable', '-informationvariable', '-outvariable',
  '-outbuffer', '-pipelinevariable',
]

/** The union of the common switches and value parameters. */
export const COMMON_PARAMETERS: ReadonlySet<string> = new Set([...COMMON_SWITCHES, ...COMMON_VALUE_PARAMS])
