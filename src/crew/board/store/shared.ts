import { createHash } from 'node:crypto'
import type { BoardPost } from '../contracts.js'

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
export const normalize = (input: BoardPost) => ({
  clientOpId: input.clientOpId, kind: input.kind, text: input.text,
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  ...(input.corrects === undefined ? {} : { corrects: input.corrects }),
  ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
  ...(input.about === undefined ? {} : { about: input.about }),
  ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  mentions: [...new Set([...(input.mentions ?? []), ...(input.to ?? []), ...Array.from(input.text.matchAll(/(?<![\w@])@([\p{L}\p{N}_][\p{L}\p{N}_.-]*)/gu), match => match[1]!.replace(/[.]+$/, ''))].map(name => name.replace(/^@/, '')))].sort(),
  relatedTasks: [...new Set(input.relatedTasks ?? [])].sort(),
  files: [...new Set(input.files ?? [])].sort(), refs: input.refs ?? [],
})
export const validTeam = (team: string): boolean => /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,79}$/u.test(team) && !['all', 'general'].includes(team.toLowerCase())
