import { createSignal } from './signal.js'

/**
 * An in-memory queue with selective receive. No cap, no timeout and no
 * cancellation on waiters.
 */

export type MessageSource = 'user' | 'teammate' | 'system' | 'tick' | 'task'

export type Message = {
  id: string
  source: MessageSource
  content: string
  from?: string
  color?: string
  timestamp: string
}

type Predicate = (message: Message) => boolean

type Waiter = { predicate: Predicate; resolve: (message: Message) => void }

const acceptAny: Predicate = () => true

export class Mailbox {
  private readonly queue: Message[] = []
  private readonly waiters: Waiter[] = []
  private readonly changed = createSignal()
  private sendCount = 0

  /** Queued messages only — waiters are not counted. */
  get length(): number {
    return this.queue.length
  }

  /** The send counter — external-store subscribers detect change cheaply. */
  get revision(): number {
    return this.sendCount
  }

  /** Delivered straight to the first waiter whose predicate accepts it (and never queued), else queued. */
  send(message: Message): void {
    this.sendCount++
    const index = this.waiters.findIndex(waiter => waiter.predicate(message))
    if (index !== -1) {
      const [waiter] = this.waiters.splice(index, 1)
      waiter!.resolve(message)
      this.changed.emit()
      return
    }
    this.queue.push(message)
    this.changed.emit()
  }

  /** Non-blocking; deliberately does NOT notify subscribers. */
  poll(predicate: Predicate = acceptAny): Message | undefined {
    const index = this.queue.findIndex(predicate)
    if (index === -1) return undefined
    const [message] = this.queue.splice(index, 1)
    return message
  }

  /** Resolves immediately from the queue (notifying), else waits for a matching send. */
  receive(predicate: Predicate = acceptAny): Promise<Message> {
    const index = this.queue.findIndex(predicate)
    if (index !== -1) {
      const [message] = this.queue.splice(index, 1)
      this.changed.emit()
      return Promise.resolve(message as Message)
    }
    return new Promise<Message>(resolve => {
      this.waiters.push({ predicate, resolve })
    })
  }

  /**
   * A PRE-BOUND field, not an unbound method, so it is safe to pass
   * detached to an external-store subscription.
   */
  subscribe = (listener: () => void): (() => void) => {
    return this.changed.subscribe(listener)
  }
}
