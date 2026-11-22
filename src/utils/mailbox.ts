import { createSignal } from './signal.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


type MessageSource = 'user' | 'crewmate' | 'system' | 'tick' | 'task'

type Message = Unbuilt

type Predicate = (...args: Unbuilt[]) => Unbuilt

type Waiter = Unbuilt

export class Mailbox {
  private readonly queue: Message[] = unbuilt('src/utils/mailbox.ts:22')
  private readonly waiters: Waiter[] = unbuilt('src/utils/mailbox.ts:23')
  private readonly changed: Unbuilt = unbuilt('src/utils/mailbox.ts:24')
  private sendCount: number = unbuilt('src/utils/mailbox.ts:25')

  get length(): number {
    return notBuilt('src/utils/mailbox.ts:27')
  }

  get revision(): number {
    return notBuilt('src/utils/mailbox.ts:31')
  }

  send(message: Message): void {
    return notBuilt('src/utils/mailbox.ts:35')
  }

  poll(predicate?: Predicate): Message | undefined {
    return notBuilt('src/utils/mailbox.ts:48')
  }

  receive(predicate?: Predicate): Promise<Message> {
    return notBuilt('src/utils/mailbox.ts:55')
  }

  subscribe = (listener: () => void): (() => void) => notBuilt('src/utils/mailbox.ts:67')
}
