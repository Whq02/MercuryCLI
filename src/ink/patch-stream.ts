import type { Diff, Patch } from './frame.js'


export function optimizePatches(diff: Diff): Diff {
  if (diff.length <= 1) return diff

  const out: Diff = []
  for (const patch of diff) {
    switch (patch.type) {
      case 'stdout':
        if (patch.content === '') continue
        break
      case 'cursorMove':
        if (patch.x === 0 && patch.y === 0) continue
        break
      case 'clear':
        if (patch.count === 0) continue
        break
      default:
        break
    }

    const prev: Patch | undefined = out[out.length - 1]
    if (prev !== undefined) {
      if (patch.type === 'cursorMove' && prev.type === 'cursorMove') {
        const x = prev.x + patch.x
        const y = prev.y + patch.y
        out.pop()
        if (x !== 0 || y !== 0) out.push({ type: 'cursorMove', x, y })
        continue
      }
      if (patch.type === 'cursorTo' && prev.type === 'cursorTo') {
        out[out.length - 1] = patch
        continue
      }
      if (patch.type === 'styleStr' && prev.type === 'styleStr') {
        out[out.length - 1] = { type: 'styleStr', str: prev.str + patch.str }
        continue
      }
      if (patch.type === 'hyperlink' && prev.type === 'hyperlink' && patch.uri === prev.uri) {
        continue
      }
      if (
        (patch.type === 'cursorShow' && prev.type === 'cursorHide') ||
        (patch.type === 'cursorHide' && prev.type === 'cursorShow')
      ) {
        out.pop()
        continue
      }
    }
    out.push(patch)
  }
  return out
}
