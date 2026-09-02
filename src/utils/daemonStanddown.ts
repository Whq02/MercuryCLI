
let haltStanddown = false

export function markDaemonHaltStanddown(): void {
  haltStanddown = true
}

export function clearDaemonHaltStanddown(): void {
  haltStanddown = false
}

export function daemonHaltStanddownActive(): boolean {
  return haltStanddown
}
