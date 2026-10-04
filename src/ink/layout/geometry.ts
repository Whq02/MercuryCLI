
export type Point = {
  x: number
  y: number
}

export type Size = {
  width: number
  height: number
}

export type Rectangle = Point & Size

export type Edges = {
  top: number
  right: number
  bottom: number
  left: number
}

export function edges(all: number): Edges
export function edges(vertical: number, horizontal: number): Edges
export function edges(
  top: number,
  right: number,
  bottom: number,
  left: number,
): Edges
export function edges(a: number, b?: number, c?: number, d?: number): Edges {
  if (b === undefined) return { top: a, right: a, bottom: a, left: a }
  if (c === undefined || d === undefined) {
    return { top: a, right: b, bottom: a, left: b }
  }
  return { top: a, right: b, bottom: c, left: d }
}

export function unionRect(a: Rectangle, b: Rectangle): Rectangle {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: bottom - y }
}

export function clamp(value: number, min?: number, max?: number): number {
  let result = value
  if (min !== undefined) result = Math.max(min, result)
  if (max !== undefined) result = Math.min(max, result)
  return result
}
