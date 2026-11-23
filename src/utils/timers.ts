export type TimerHandle = NodeJS.Timeout | string | number
type TimeoutHandle = TimerHandle | undefined

export function startTimeout<TArgs extends unknown[]>(callback: (...args: TArgs) => void, delay?: number, ...args: TArgs): NodeJS.Timeout
export function startTimeout(callback: (_: void) => void, delay?: number): NodeJS.Timeout
export function startTimeout<TArgs extends unknown[]>(callback: (...args: TArgs) => void, delay?: number, ...args: TArgs): NodeJS.Timeout {
  return setTimeout(callback, delay, ...args)
}

export function startInterval<TArgs extends unknown[]>(callback: (...args: TArgs) => void, delay?: number, ...args: TArgs): NodeJS.Timeout
export function startInterval(callback: (_: void) => void, delay?: number): NodeJS.Timeout
export function startInterval<TArgs extends unknown[]>(callback: (...args: TArgs) => void, delay?: number, ...args: TArgs): NodeJS.Timeout {
  return setInterval(callback, delay, ...args)
}

export function startImmediate<TArgs extends unknown[]>(callback: (...args: TArgs) => void, ...args: TArgs): NodeJS.Immediate
export function startImmediate(callback: (_: void) => void): NodeJS.Immediate
export function startImmediate<TArgs extends unknown[]>(callback: (...args: TArgs) => void, ...args: TArgs): NodeJS.Immediate {
  return setImmediate(callback, ...args)
}

export function startMicrotask(callback: () => void): void {
  queueMicrotask(callback)
}

export function stopTimeout(timeout: TimeoutHandle): void {
  clearTimeout(timeout)
}

export function stopInterval(timeout: TimeoutHandle): void {
  clearInterval(timeout)
}

export function stopImmediate(immediate: NodeJS.Immediate | undefined): void {
  clearImmediate(immediate)
}

export function afterMicrotask<T>(run: (value: void) => T | PromiseLike<T>): Promise<T> {
  return Promise.resolve().then(run)
}

export function nextMicrotask(): Promise<void> {
  return Promise.resolve()
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
