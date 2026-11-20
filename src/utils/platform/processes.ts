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
