let readOnlyDiagnostic = false

export function beginReadOnlyDiagnostic(): void {
  readOnlyDiagnostic = true
}

export function isReadOnlyDiagnostic(): boolean {
  return readOnlyDiagnostic
}
