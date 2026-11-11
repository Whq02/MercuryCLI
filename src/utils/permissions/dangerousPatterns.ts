
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

export const PROGRAM_WRAPPERS: string[] = [
  'nice', 'timeout', 'nohup', 'command', 'builtin', 'time', 'stdbuf', 'setsid', 'ionice', 'caffeinate', 'taskset', 'chrt', 'doas', 'su', 'flock', 'script',
  'watch', 'parallel', 'busybox', 'chronic', 'unbuffer', 'nocache', 'arch', 'strace', 'ltrace', 'chroot', 'find',
]
