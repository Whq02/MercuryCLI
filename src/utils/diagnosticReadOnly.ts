let readOnlyDiagnostic = false
let onlyCheck: string | null = null

export function beginReadOnlyDiagnostic(only?: string): void {
  readOnlyDiagnostic = true
  onlyCheck = only ?? null
}

export function diagnosticAsksFor(checkId: string): boolean {
  return onlyCheck === null || onlyCheck === checkId
}

export function isReadOnlyDiagnostic(): boolean {
  return readOnlyDiagnostic
}
