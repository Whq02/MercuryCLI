export function commentRanges(path: string, text: string): { pos: number; end: number; kind: number; hasTrailingNewLine?: boolean }[]
export function scriptComments(path: string, text: string): { pos: number; end: number; keep: string | null }[]
