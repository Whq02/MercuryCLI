const C0_MNEMONICS = [
  'NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL',
  'BS', 'HT', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI',
  'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB',
  'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US',
] as const

type ControlCode = (typeof C0_MNEMONICS)[number] | 'DEL'

function controlTable(): { readonly [Name in ControlCode]: number } {
  const codes: Record<string, number> = { DEL: 0x7f }
  C0_MNEMONICS.forEach((name, position) => {
    codes[name] = position
  })
  return codes as { readonly [Name in ControlCode]: number }
}

export const C0 = controlTable()

export const ESC = String.fromCharCode(C0.ESC)
export const BEL = String.fromCharCode(C0.BEL)
export const SEP = ';'

const ESCAPE_INTRODUCERS = {
  CSI: '[',
  OSC: ']',
  DCS: 'P',
  APC: '_',
  PM: '^',
  SOS: 'X',
  ST: '\\',
} as const

export function asBytes<Name extends string>(
  characters: Readonly<Record<Name, string>>,
): { readonly [K in Name]: number } {
  const bytes: Record<string, number> = {}
  for (const name of Object.keys(characters) as Name[]) bytes[name] = characters[name].charCodeAt(0)
  return bytes as { readonly [K in Name]: number }
}

export const ESC_TYPE = asBytes(ESCAPE_INTRODUCERS)

export function byteRange(first: number, last: number): (byte: number) => boolean {
  return byte => byte >= first && byte <= last
}

export const isEscFinal = byteRange(0x30, 0x7e)
