const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

export function caretEscape(text: string): string {
  return text.replace(CONTROL_CHARACTERS, character => {
    const code = character.charCodeAt(0)
    if (code === 0x7f) return '^?'
    if (code >= 0x80) return `^[${String.fromCharCode(code - 0x40)}`
    return `^${String.fromCharCode(code + 0x40)}`
  })
}
