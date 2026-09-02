
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

export function addEdges(a: Edges, b: Edges): Edges {
  return {
    top: a.top + b.top,
    right: a.right + b.right,
    bottom: a.bottom + b.bottom,
    left: a.left + b.left,
  }
}

export const ZERO_EDGES: Edges = { top: 0, right: 0, bottom: 0, left: 0 }

export function resolveEdges(partial?: Partial<Edges>): Edges {
  return {
    top: partial?.top ?? 0,
    right: partial?.right ?? 0,
    bottom: partial?.bottom ?? 0,
    left: partial?.left ?? 0,
  }
}

export function unionRect(a: Rectangle, b: Rectangle): Rectangle {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: bottom - y }
}

export function clampRect(rect: Rectangle, size: Size): Rectangle {
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  const farX = Math.min(size.width - 1, rect.x + rect.width - 1)
  const farY = Math.min(size.height - 1, rect.y + rect.height - 1)
  return {
    x,
    y,
    width: Math.max(0, farX - x + 1),
    height: Math.max(0, farY - y + 1),
  }
}

export function withinBounds(size: Size, point: Point): boolean {
  return (
    point.x >= 0 && point.x < size.width && point.y >= 0 && point.y < size.height
  )
}

export function clamp(value: number, min?: number, max?: number): number {
  let result = value
  if (min !== undefined) result = Math.max(min, result)
  if (max !== undefined) result = Math.min(max, result)
  return result
}
