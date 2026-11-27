import { setClipboardWithReceipt, type ClipboardReceipt } from '../../screen/renderer/termio/osc.js'

export type SignInCopyAnswer = 'copied' | 'offered' | 'none'
export type SignInCopied = 'URL' | 'code'
export interface SignInCopy { sequence: string; answer: SignInCopyAnswer }
export interface SignInCopySaid { copied: boolean; copyNote: string | null }

export const SIGN_IN_COPY_ACK_MS = 2000

export function signInCopyAnswerOf(receipt: Pick<ClipboardReceipt, 'settled' | 'noRoad'>): SignInCopyAnswer {
  if (receipt.settled.some(road => road !== 'tmux-buffer')) return 'copied'
  return receipt.noRoad ? 'none' : 'offered'
}

const selectAbove = (what: SignInCopied): string => `select the ${what} above`

export function signInCopyNote(answer: SignInCopyAnswer, what: SignInCopied): string | null {
  if (answer === 'copied') return null
  return answer === 'none' ? `nothing copied — ${selectAbove(what)}` : `sent to your terminal — if nothing pastes, ${selectAbove(what)}`
}

export function signInCopyNoteWhereCut(note: string): string {
  const what = (['URL', 'code'] as const).find(word => note.endsWith(selectAbove(word)))
  return what === undefined ? note : `${note.slice(0, -selectAbove(what).length)}make this window taller to read the whole ${what}`
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
