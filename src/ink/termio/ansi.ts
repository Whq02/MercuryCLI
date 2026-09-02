// The C0 control-code table, the escape introducers and the byte-class
// predicates every scanner and generator in the terminal layer shares.

/** C0 control characters by mnemonic (plus DEL). */
export const C0 = {
  NUL: 0x00,
  SOH: 0x01,
  STX: 0x02,
  ETX: 0x03,
  EOT: 0x04,
  ENQ: 0x05,
  ACK: 0x06,
  BEL: 0x07,
  BS: 0x08,
  HT: 0x09,
  LF: 0x0a,
  VT: 0x0b,
  FF: 0x0c,
  CR: 0x0d,
  SO: 0x0e,
  SI: 0x0f,
  DLE: 0x10,
  DC1: 0x11,
  DC2: 0x12,
  DC3: 0x13,
  DC4: 0x14,
  NAK: 0x15,
  SYN: 0x16,
  ETB: 0x17,
  CAN: 0x18,
  EM: 0x19,
  SUB: 0x1a,
  ESC: 0x1b,
  FS: 0x1c,
  GS: 0x1d,
  RS: 0x1e,
  US: 0x1f,
  DEL: 0x7f,
} as const

export const ESC = '\x1b'
export const BEL = '\x07'
/** The parameter separator. */
export const SEP = ';'

/** The byte immediately after ESC that names the escape type. */
export const ESC_TYPE = {
  CSI: 0x5b, // [
  OSC: 0x5d, // ]
  DCS: 0x50, // P
  APC: 0x5f, // _
  PM: 0x5e, // ^
  SOS: 0x58, // X
  ST: 0x5c, // \
} as const

/** A C0 control byte: below 0x20, or DEL. */
export function isC0(byte: number): boolean {
  return byte < 0x20 || byte === 0x7f
}

/** An ESC-sequence final byte: 0x30–0x7e — deliberately wider than the CSI
 *  final range, since bare-ESC sequences terminate on digits and
 *  punctuation too. */
export function isEscFinal(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x7e
}
