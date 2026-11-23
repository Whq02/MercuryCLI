export function childGetsOwnProcessGroup(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export type ProcessStartForm = 'token' | 'instant'

export function processStartFormFor(likeIsInstant: boolean, platform: NodeJS.Platform = process.platform): ProcessStartForm {
  return platform === 'win32' && likeIsInstant ? 'instant' : 'token'
}

export function processInstantStartForm(platform: NodeJS.Platform = process.platform): ProcessStartForm {
  return platform === 'win32' ? 'instant' : 'token'
}

type ProcessStartProbeKind = 'win32-cim' | 'linux-proc' | 'posix-ps'

export function processStartProbeKind(platform: NodeJS.Platform = process.platform): ProcessStartProbeKind {
  return platform === 'win32' ? 'win32-cim' : platform === 'linux' ? 'linux-proc' : 'posix-ps'
}

export type AvailableMemoryReader = 'vm_stat' | 'meminfo' | 'counter' | 'free'

export function availableMemoryReader(platform: NodeJS.Platform = process.platform): AvailableMemoryReader {
  return platform === 'darwin' ? 'vm_stat' : platform === 'linux' ? 'meminfo' : platform === 'win32' ? 'counter' : 'free'
}

export function processListCommand(platform: NodeJS.Platform = process.platform): {
  file: string
  args: string[]
  timeoutMs: number
} {
  return platform === 'win32'
    ? {
        file: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }",
        ],
        timeoutMs: 8000,
      }
    : {
        file: 'ps',
        args: ['-axo', 'pid=,command='],
        timeoutMs: 3000,
      }
}

export function posixExitSignalsCount(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function isOwnKillExitCode(killedByMercury: boolean, code: number, platform: NodeJS.Platform = process.platform): boolean {
  return killedByMercury && platform === 'win32' && (code === 1 || code === 137)
}

export function wasEndedByProcessTreeKill(
  signalCode: NodeJS.Signals | null,
  endedCount: number,
  exitCode: number | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return signalCode !== null || (platform === 'win32' && endedCount > 0 && exitCode !== 0)
}

const MSYS_COUNTS_A_SIGNAL_BY = 256
const MSYS_SIGNALS = 64

export function msysSignalExitCode(status: number, underMsys: boolean, platform: string = process.platform): number {
  const signal = status / MSYS_COUNTS_A_SIGNAL_BY
  return platform === 'win32' && underMsys && Number.isInteger(signal) && signal >= 1 && signal <= MSYS_SIGNALS ? 128 + signal : status
}

export function canReraiseOwnSignal(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function killSignalForChild(signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): NodeJS.Signals | undefined {
  return platform === 'win32' ? undefined : signal
}

export function supportsGracefulSigterm(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

type ProcessTreeEndMethod = 'win32-taskkill' | 'posix-group'

export function processTreeEndMethod(platform: NodeJS.Platform = process.platform): ProcessTreeEndMethod {
  return platform === 'win32' ? 'win32-taskkill' : 'posix-group'
}

export function posixProcessTableSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function syncStartTokenSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

export function loadAverageSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

type ParentPidProbeKind = 'win32-ancestors' | 'posix-ps'

export function parentPidProbeKind(platform: NodeJS.Platform = process.platform): ParentPidProbeKind {
  return platform === 'win32' ? 'win32-ancestors' : 'posix-ps'
}

export function ancestorPidsCommand(
  pid: number,
  maxDepth: number,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform === 'win32') {
    const script = `$p=${pid};$out=@();for($i=0;$i -lt ${maxDepth};$i++){$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;if(-not $proc){break};$pp=$proc.ParentProcessId;if(-not $pp -or $pp -eq 0){break};$out+=$pp;$p=$pp};$out -join ','`
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  const script = `p=${pid}; i=0; while [ $i -lt ${maxDepth} ]; do pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); if [ -z "$pp" ] || [ "$pp" = "0" ] || [ "$pp" = "1" ]; then break; fi; echo "$pp"; p=$pp; i=$((i+1)); done`
  return { file: 'sh', args: ['-c', script] }
}

type ProcessQueryTool = 'tasklist' | 'ps'

export function processQueryTool(platform: NodeJS.Platform = process.platform): ProcessQueryTool {
  return platform === 'win32' ? 'tasklist' : 'ps'
}

type ProcessUserSource = 'table' | 'uid'

export function processUserSource(platform: NodeJS.Platform = process.platform): ProcessUserSource {
  return platform === 'win32' ? 'table' : 'uid'
}
