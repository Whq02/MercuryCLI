type PassedOverSink = (error: unknown) => void

let sink: PassedOverSink | undefined
let count = 0
let last: unknown
let telling = false

export function passedOver(error: unknown): void {
  count++
  last = error
  if (sink === undefined || telling) return
  telling = true
  try {
    sink(error)
  } catch {
  } finally {
    telling = false
  }
}

export function passedOverAs<T>(value: T): (error: unknown) => T {
  return error => {
    passedOver(error)
    return value
  }
}

export function setPassedOverSink(next: PassedOverSink | undefined): void {
  sink = next
}

export function passedOverSoFar(): { count: number; last: unknown } {
  return { count, last }
}
