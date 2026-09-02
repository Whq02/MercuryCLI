/**
 * Contract-data lists of interpreter / code-execution prefixes that make a
 * shell allow-rule dangerous. The cross-platform subset is shared with the
 * PowerShell predicate (via S08's dangerousCmdlets import) so the two lists
 * cannot drift; the Bash-specific additions live only here.
 */

/** The cross-platform interpreter subset (shared with the PowerShell side). */
export const CROSS_PLATFORM_CODE_EXEC = [
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
  'bash',
  'sh',
  'ssh',
] as const

/** The full Bash dangerous-pattern list: the cross-platform subset plus these. */
export const DANGEROUS_BASH_PATTERNS: string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,
  'zsh',
  'fish',
  'eval',
  'exec',
  'env',
  'xargs',
  'sudo',
]
