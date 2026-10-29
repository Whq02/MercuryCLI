export function normaliseForMatch(text: string): string {
  return text.normalize('NFKC').replace(/[\u061c\u0640\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
}
