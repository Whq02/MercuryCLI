// ============================================================================
//  fabric/ids — branded identities for the Mercury record fabric.
//
//  Stable identity is assigned at CREATION, never inferred during later
// normalization. SessionId/AgentId stay owned by
//  src/types/ids.ts; this module adds the fabric-local identity vocabulary.
//  No provider package types anywhere in this family.
// ============================================================================
import { randomUUID } from 'node:crypto'

/** A durable fabric record's identity (uuid-shaped; entry uuids
 *  brand directly so migration preserves creation-time identity). */
export type RecordId = string & { readonly __brand: 'RecordId' }

/** A conversation thread within a session (main thread, sidechains, forks). */
export type ThreadId = string & { readonly __brand: 'ThreadId' }

/** One model-request cycle (the run-core turn vocabulary). */
export type TurnId = string & { readonly __brand: 'TurnId' }

/** A semantic item (message/tool-call/attachment) that projections key on. */
export type ItemId = string & { readonly __brand: 'ItemId' }

/** A tool call's stable identity across stream/persistence/UI/replay. */
export type ToolCallId = string & { readonly __brand: 'ToolCallId' }

/** A sealed provider continuation receipt's identity. */
export type ReceiptId = string & { readonly __brand: 'ReceiptId' }

export const asRecordId = (s: string): RecordId => s as RecordId
export const asThreadId = (s: string): ThreadId => s as ThreadId
export const asTurnId = (s: string): TurnId => s as TurnId
export const asItemId = (s: string): ItemId => s as ItemId
export const asToolCallId = (s: string): ToolCallId => s as ToolCallId
export const asReceiptId = (s: string): ReceiptId => s as ReceiptId

export const mintRecordId = (): RecordId => randomUUID() as string as RecordId
export const mintReceiptId = (): ReceiptId => randomUUID() as string as ReceiptId

/** The main thread of a session (every session has one). */
export const MAIN_THREAD: ThreadId = 'main' as ThreadId
