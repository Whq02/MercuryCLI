export function loginSuccessReceipt(email: string | null | undefined): string {
  return typeof email === 'string' && email.trim() !== '' ? `Login successful — signed in as ${email.trim()}` : 'Login successful'
}
