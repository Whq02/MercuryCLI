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
