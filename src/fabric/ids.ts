import { randomUUID } from 'node:crypto'

export type RecordId = string & { readonly __brand: 'RecordId' }

export type ThreadId = string & { readonly __brand: 'ThreadId' }

export type TurnId = string & { readonly __brand: 'TurnId' }

export type ItemId = string & { readonly __brand: 'ItemId' }

export type ToolCallId = string & { readonly __brand: 'ToolCallId' }

export type ReceiptId = string & { readonly __brand: 'ReceiptId' }

export const asRecordId = (s: string): RecordId => s as RecordId
export const asThreadId = (s: string): ThreadId => s as ThreadId
export const asTurnId = (s: string): TurnId => s as TurnId
export const asItemId = (s: string): ItemId => s as ItemId
export const asToolCallId = (s: string): ToolCallId => s as ToolCallId
export const asReceiptId = (s: string): ReceiptId => s as ReceiptId

export const mintRecordId = (): RecordId => randomUUID() as string as RecordId
export const mintReceiptId = (): ReceiptId => randomUUID() as string as ReceiptId

export const MAIN_THREAD: ThreadId = 'main' as ThreadId
