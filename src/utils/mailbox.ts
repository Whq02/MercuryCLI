import { createSignal } from './signal.js'

type MessageSource = 'user' | 'crewmate' | 'system' | 'tick' | 'task'

type Message = {
  id: string
  source: MessageSource
  content: string
  from?: string
  color?: string
  timestamp: number
}

type Predicate = (message: Message) => boolean

type Waiter = {
  predicate?: Predicate
  resolve: (message: Message) => void
}

export class Mailbox {
  private readonly queue: Message[] = []
  private readonly waiters: Waiter[] = []
  private readonly changed = createSignal()
  private sendCount = 0

  get length(): number {
    return this.queue.length
  }

  get revision(): number {
    return this.sendCount
  }

  send(message: Message): void {
    this.sendCount++
    const waiterIdx = this.waiters.findIndex(
      waiter => waiter.predicate === undefined || waiter.predicate(message),
    )
    if (waiterIdx !== -1) {
      const [waiter] = this.waiters.splice(waiterIdx, 1)
      waiter!.resolve(message)
      this.changed.emit()
      return
    }
    this.queue.push(message)
    this.changed.emit()
  }

  poll(predicate?: Predicate): Message | undefined {
    const idx = predicate === undefined ? (this.queue.length > 0 ? 0 : -1) : this.queue.findIndex(predicate)
    if (idx === -1) return undefined
    const [message] = this.queue.splice(idx, 1)
    return message
  }

  receive(predicate?: Predicate): Promise<Message> {
    const existing = this.poll(predicate)
    if (existing !== undefined) {
      this.changed.emit()
      return Promise.resolve(existing)
    }
    return new Promise<Message>(resolve => {
      this.waiters.push({ predicate, resolve })
    })
  }

  subscribe = (listener: () => void): (() => void) => this.changed.subscribe(listener)
}
