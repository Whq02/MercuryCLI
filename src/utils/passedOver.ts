type PassedOverSink = (error: unknown) => void
type Held = { count: number; last: unknown; sink: PassedOverSink | undefined; telling: boolean }
type HeldDoor = { (): Held; state?: Held }

function held(): Held {
  const door: HeldDoor = held
  return (door.state ??= { count: 0, last: undefined, sink: undefined, telling: false })
}

export function passedOver(error: unknown): void {
  const state = held()
  state.count++
  state.last = error
  if (state.sink === undefined || state.telling) return
  state.telling = true
  try {
    state.sink(error)
  } catch {
  } finally {
    state.telling = false
  }
}

export function passedOverAs<T>(value: T): (error: unknown) => T {
  return error => {
    passedOver(error)
    return value
  }
}

export function setPassedOverSink(next: PassedOverSink | undefined): void {
  held().sink = next
}

export function passedOverSoFar(): { count: number; last: unknown } {
  const { count, last } = held()
  return { count, last }
}
