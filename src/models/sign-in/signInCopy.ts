import { setClipboardWithReceipt, type ClipboardReceipt } from '../../screen/renderer/termio/osc.js'

export type SignInCopyAnswer = 'copied' | 'offered' | 'none'
export type SignInCopied = 'URL' | 'code'
export interface SignInCopy { sequence: string; answer: SignInCopyAnswer }
export interface SignInCopySaid { copied: boolean; copyNote: string | null; what?: SignInCopied }

export const SIGN_IN_COPY_ACK_MS = 2000

export function signInCopyAnswerOf(receipt: Pick<ClipboardReceipt, 'settled' | 'noRoad'>): SignInCopyAnswer {
  if (receipt.settled.some(road => road !== 'tmux-buffer')) return 'copied'
  return receipt.noRoad ? 'none' : 'offered'
}

export function signInCopyNote(answer: SignInCopyAnswer, what: SignInCopied): string | null {
  if (answer === 'copied') return null
  const next = what === 'URL' ? 'press c again for the URL on one line' : 'select the code above'
  return answer === 'none' ? `nothing copied — ${next}` : `sent to your terminal — if nothing pastes, ${next}`
}

export function signInCopySaid(answer: SignInCopyAnswer, what: SignInCopied): SignInCopySaid {
  const copyNote = signInCopyNote(answer, what)
  return { copied: copyNote === null, copyNote }
}

export async function readSignInCopy(text: string): Promise<SignInCopy> {
  const receipt = await setClipboardWithReceipt(text)
  return { sequence: receipt.sequence, answer: signInCopyAnswerOf(receipt) }
}

export async function copyForSignIn(text: string): Promise<SignInCopyAnswer> {
  const copy = await readSignInCopy(text)
  if (copy.sequence) process.stdout.write(copy.sequence)
  return copy.answer
}
