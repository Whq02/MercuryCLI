type OtherBuildAliveProbe = () => Promise<string | null>

let registered: OtherBuildAliveProbe | undefined

export function registerOtherBuildAliveProbe(probe: OtherBuildAliveProbe): void {
  registered = probe
}

export function otherBuildAliveProbe(): Promise<string | null> {
  if (registered === undefined) {
    throw new Error('otherBuildAlive probe is not registered: call registerBootDoors() at startup')
  }
  return registered()
}
