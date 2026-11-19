type SignInPickerV1 = { kind: 'default' } | { kind: 'session'; sessionId: string; title: string }
let pendingSignInPicker: SignInPickerV1 | null = null
export function armSignInPickerReturn(picker: SignInPickerV1): void {
  pendingSignInPicker = picker
}
export function consumeSignInPickerReturn(): SignInPickerV1 | null {
  const picker = pendingSignInPicker
  pendingSignInPicker = null
  return picker
}
