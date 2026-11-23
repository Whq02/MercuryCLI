
let haltStanddown = false

export function markDaemonHaltStanddown(): void {
  haltStanddown = true
}

export function daemonHaltStanddownActive(): boolean {
  return haltStanddown
}
