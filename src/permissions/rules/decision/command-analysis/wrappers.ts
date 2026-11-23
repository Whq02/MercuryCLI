const TIMEOUT_DURATION_RE = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/
const TIMEOUT_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

type Peeled = string[] | { failReason: string } | null

const WRAPPERS: ReadonlyMap<string, (argv: string[]) => Peeled> = new Map([
  ['time', argv => argv.slice(1)],
  ['nohup', argv => argv.slice(1)],
  [
    'timeout',
    argv => {
      let i = 1
      while (i < argv.length) {
        const flag = argv[i] as string
        if (!flag.startsWith('-')) break
        if (flag === '--foreground' || flag === '--preserve-status' || flag === '--verbose') {
          i += 1
        } else if (flag.startsWith('--kill-after=') || flag.startsWith('--signal=')) {
          i += 1
        } else if (flag === '--kill-after' || flag === '--signal' || flag === '-k' || flag === '-s') {
          const value = argv[i + 1]
          if (value === undefined || !TIMEOUT_VALUE_RE.test(value)) {
            return { failReason: `unrecognised timeout flag ${JSON.stringify(flag)} hides the wrapped command` }
          }
          i += 2
        } else if (flag === '-v') {
          i += 1
        } else if ((flag.startsWith('-k') || flag.startsWith('-s')) && flag.length > 2 && TIMEOUT_VALUE_RE.test(flag.slice(2))) {
          i += 1
        } else {
          return { failReason: `unrecognised timeout flag ${JSON.stringify(flag)} hides the wrapped command` }
        }
      }
      if (i >= argv.length) return null
      const duration = argv[i] as string
      if (!TIMEOUT_DURATION_RE.test(duration)) {
        return { failReason: `unrecognised timeout duration ${JSON.stringify(duration)}` }
      }
      return argv.slice(i + 1)
    },
  ],
  [
    'nice',
    argv => {
      const first = argv[1]
      if (first === '-n' && argv[2] !== undefined && /^-?[0-9]+$/.test(argv[2])) return argv.slice(3)
      if (first !== undefined && /^-[0-9]+$/.test(first)) return argv.slice(2)
      if (first !== undefined && /[$(`]/.test(first)) {
        return { failReason: `unsafe nice argument ${JSON.stringify(first)}` }
      }
      return argv.slice(1)
    },
  ],
  [
    'env',
    argv => {
      let i = 1
      while (i < argv.length) {
        const arg = argv[i] as string
        if (arg.includes('=') && !arg.startsWith('-')) {
          i += 1
          continue
        }
        if (arg === '-i' || arg === '-0' || arg === '-v') {
          i += 1
          continue
        }
        if (arg === '-u') {
          if (i + 1 >= argv.length) {
            return { failReason: `unrecognised env flag ${JSON.stringify(arg)} hides the wrapped command` }
          }
          i += 2
          continue
        }
        if (arg.startsWith('-')) {
          return { failReason: `unrecognised env flag ${JSON.stringify(arg)} hides the wrapped command` }
        }
        break
      }
      if (i >= argv.length) return null
      return argv.slice(i)
    },
  ],
  [
    'stdbuf',
    argv => {
      let i = 1
      let consumed = false
      while (i < argv.length) {
        const arg = argv[i] as string
        if ((arg === '-i' || arg === '-o' || arg === '-e') && argv[i + 1] !== undefined) {
          i += 2
          consumed = true
          continue
        }
        if (/^-[ioe]./.test(arg) || /^--(?:input|output|error)=/.test(arg)) {
          i += 1
          consumed = true
          continue
        }
        if (arg.startsWith('-')) {
          return { failReason: `unrecognised stdbuf flag ${JSON.stringify(arg)} hides the wrapped command` }
        }
        break
      }
      if (!consumed || i >= argv.length) return null
      return argv.slice(i)
    },
  ],
])

export function peelWrappers(argv: string[]): string[] | { failReason: string } {
  let current = argv
  for (;;) {
    const peel = WRAPPERS.get(current[0] as string)
    if (peel === undefined) return current
    const peeled = peel(current)
    if (peeled === null) return current
    if (!Array.isArray(peeled)) return peeled
    current = peeled
  }
}
