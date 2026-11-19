import { randomUUID } from 'node:crypto'
import { boardReachNote, boardLabelKey, type BoardChannel, type BoardEvent, type BoardPost, type BoardPrincipal, type BoardReach, type BoardReceipt, type BoardSeat, type BoardStore, type OwnerPostInput, type OwnerPostReceipt } from '../contracts.js'
import { boardAddressesSeat, parseBoardWait } from '../waits.js'
import { digest, normalize } from './shared.js'
import type { StoreContext } from './context.js'

export function post(ctx: StoreContext, p: BoardPrincipal, input: BoardPost, delivery?: 'mirror'): BoardReceipt {
  const { transaction, sessionId, db, checkPrincipal, resolveMentions, teamOf, now, seats, captainId, boardId, waveId, appendEvent, wakes, roster, publish } = ctx
  let result: BoardReceipt
  try {
    result = transaction(() => {
      if (input.kind === 'message' || input.kind === 'notice') {
        if (p.author.sessionId !== sessionId) throw new Error('This message belongs to another session.')
        db.prepare('INSERT INTO members (agent, name, execution, enrolled) VALUES (?, ?, ?, 0) ON CONFLICT(agent) DO NOTHING').run(p.author.agentId, p.name, p.author.executionId)
      } else checkPrincipal(p)
      const post = normalize(input)
      const mirrored = delivery === 'mirror' && (post.kind === 'message' || post.kind === 'notice')
      if (!['ask', 'answer', 'blocker', 'result', 'correction', 'message', 'notice'].includes(post.kind)) return { ok: false, reason: 'The board accepts questions, answers, blockers, results and corrections, not ownership or control commands.' }
      if (!post.clientOpId || post.clientOpId.length > 160) return { ok: false, reason: 'A post needs a retry key of at most 160 characters.' }
      const hash = digest(JSON.stringify(post))
      const prior = db.prepare('SELECT id, seq, digest, record FROM events WHERE author = ? AND op = ?').get(p.author.agentId, post.clientOpId)
      if (prior != null) return prior.digest === hash ? { ok: true, eventId: String(prior.id), seq: Number(prior.seq), replay: true, ...(JSON.parse(String(prior.record)).unknownMentions?.length ? { unknownMentions: JSON.parse(String(prior.record)).unknownMentions } : {}) } : { ok: false, reason: 'That retry key already names a different post.' }
      if (!post.text.trim()) return { ok: false, reason: 'A post needs text.' }
      if (post.files.length > 32 || post.refs.length > 8) return { ok: false, reason: 'A post holds at most 32 files and 8 references.' }
      if (post.files.some(file => !file || file.startsWith('/') || file.split(/[\\/]/).includes('..'))) return { ok: false, reason: 'Files must be exact paths relative to the task repository.' }
      if (post.kind === 'correction' && !post.corrects) return { ok: false, reason: 'A correction names its earlier post with corrects.' }
      const target = post.corrects ?? post.replyTo
      const reply = target === undefined ? undefined : db.prepare('SELECT record FROM events WHERE id = ?').get(target)
      if (target !== undefined && reply == null) return { ok: false, reason: 'The earlier post is not in this wave.' }
      const question = reply == null ? undefined : JSON.parse(String(reply.record)) as BoardEvent
      const ownReply = question?.author.agentId === p.author.agentId
      if (post.kind === 'answer' && question?.kind !== 'ask' && !ownReply) return { ok: false, reason: 'An answer names an ask or your own earlier post with replyTo.' }
      const thread = question?.threadId ?? post.threadId ?? randomUUID()
      if (post.threadId !== undefined && question !== undefined && post.threadId !== question.threadId) return { ok: false, reason: 'The reply belongs to the earlier post’s thread.' }
      const addressing = resolveMentions(post.mentions)
      const team = teamOf(p.author.agentId)
      if (!mirrored && addressing.unknownMentions.length > 0 && addressing.mentions.length === 0 && team === undefined && !post.mentions.some(name => name.toLowerCase() === 'main')) return { ok: false, reason: `no seat named ${addressing.unknownMentions.join(', ')} — a seat exists once Crewmate launches it` }
      const time = now()
      const own = seats().find(seat => seat.agent === p.author.agentId)
      const declared = !mirrored && own ? parseBoardWait(post, own, seats()) : null
      const eventId = randomUUID()
      const event: BoardEvent = { ...post, addresses: post.mentions, mentions: addressing.mentions, recipients: seats().filter(seat => addressing.mentions.includes(seat.agent)), ...(post.lifecycle ? { authorRole: 'system' as const } : {}), ...(addressing.unknownMentions.length ? { unknownMentions: addressing.unknownMentions } : {}), ...(team === undefined ? {} : { team }), ...(captainId(team) === p.author.agentId ? { captain: true } : {}), ...(post.taskId === undefined && question?.taskId !== undefined ? { taskId: question.taskId } : {}), schema: 1, boardId, waveId, seq: 0, eventId, author: p.author, authorName: p.name, createdAt: new Date(time).toISOString(), payloadDigest: hash, threadId: thread, policyRevision: 1 }
      appendEvent(event)
      if (mirrored) db.prepare('INSERT INTO mirror_events VALUES (?)').run(eventId)
      let reach: BoardReach | undefined
      if (delivery !== 'mirror') {
        if (declared) wakes.declare(p.author.agentId, event, declared)
        const waiting = new Set(wakes.posted(event, seats()))
        const root = db.prepare('SELECT author FROM events WHERE thread = ? ORDER BY seq LIMIT 1').get(thread)
        const replies = new Set([...(question ? [question.author.agentId] : []), ...(root ? [String(root.author)] : [])])
        const queued = new Set(wakes.pending().filter(wake => wake.eventId === eventId).map(wake => wake.agent))
        const addressed = seats().filter(seat => seat.agent !== p.author.agentId && (event.mentions.includes(seat.agent) || replies.has(seat.agent) || waiting.has(seat.agent)))
        const idle = addressed.filter(seat => seat.state === 'parked' && !queued.has(seat.agent))
        reach = { running: addressed.filter(seat => seat.state !== 'parked').map(seat => seat.name), wakes: addressed.filter(seat => queued.has(seat.agent)).map(seat => seat.name), held: idle.filter(seat => boardAddressesSeat(event, seat)).map(seat => seat.name), parked: idle.filter(seat => !boardAddressesSeat(event, seat)).length }
        const captains = new Set((post.kind === 'ask' || post.kind === 'blocker') ? seats().filter(seat => seat.captain && seat.team && (seat.team === team || event.recipients?.some(recipient => recipient.team === seat.team))).map(seat => seat.agent) : [])
        const recipients = new Set([...event.mentions, ...replies, ...waiting, ...captains, ...roster().map(row => String(row.agent))])
        recipients.delete(p.author.agentId)
        for (const recipient of recipients) {
          const named = (names: readonly string[]): boolean => post.mentions.some(name => names.includes(name.toLowerCase()))
          const captain = captainId(team) === recipient && !named(['all']) && ((post.kind === 'ask' || post.kind === 'blocker') || (['result', 'answer', 'correction'].includes(post.kind) && named([recipient.toLowerCase(), String(db.prepare('SELECT name FROM members WHERE agent = ?').get(recipient)?.name).toLowerCase()])))
          const wake = recipient === 'main' && ((post.kind === 'ask' || post.kind === 'blocker') ? named(['main', 'all']) : named(['main'])) || captain || captains.has(recipient) || waiting.has(recipient)
          const mode = wake ? 'mention-wake-body' : event.mentions.includes(recipient) ? 'mention-body' : replies.has(recipient) ? 'thread-body' : 'body'
          db.prepare('INSERT INTO deliveries (recipient, event, mode) VALUES (?, ?, ?)').run(recipient, eventId, mode)
        }
      }
      const note = reach ? boardReachNote(reach) : undefined
      return { ok: true, eventId, seq: event.seq, replay: false, ...(addressing.unknownMentions.length ? { unknownMentions: addressing.unknownMentions } : {}), ...(reach ? { reach } : {}), ...(note ? { note } : {}) }
    })
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
  if (result.ok && !result.replay) publish()
  return result
}

export function postOwner(ctx: StoreContext, p: BoardPrincipal, input: OwnerPostInput): OwnerPostReceipt {
  const { transaction, checkPrincipal, db, seats, captainId, boardId, waveId, now, appendEvent, wakes, publish } = ctx
  let result: ReturnType<BoardStore['postOwner']>
  try {
    result = transaction(() => {
      checkPrincipal(p)
      if (p.author.agentId !== 'main') return { ok: false, reason: 'Only the operator command path posts as owner.' }
      const hash = digest(JSON.stringify(input))
      const prior = db.prepare("SELECT record, digest FROM events WHERE author = 'owner' AND op = ?").get(input.clientOpId)
      if (prior) {
        if (prior.digest !== hash) return { ok: false, reason: 'That retry key already names a different post.' }
        const event = JSON.parse(String(prior.record)) as BoardEvent
        return { ok: true, eventId: event.eventId, seq: event.seq, replay: true, channel: event.channel!, recipients: event.mentions }
      }
      if (!input.clientOpId || input.clientOpId.length > 160) return { ok: false, reason: 'A post needs a retry key of at most 160 characters.' }
      if (!input.text.trim()) return { ok: false, reason: 'A post needs text.' }
      const roster = seats().filter(seat => seat.agent !== 'main')
      const target = (input.target ?? '').replace(/^@/, '')
      let recipients: BoardSeat[], channel: BoardChannel, address: string
      if (input.channel === 'general') {
        recipients = roster; channel = { kind: 'general' }; address = 'all'
      } else if (input.channel === 'team') {
        const labels = [...new Set(roster.flatMap(seat => seat.team ? [seat.team] : []))]
        const label = labels.find(label => boardLabelKey(label) === boardLabelKey(target))
        if (!label) return { ok: false, reason: 'Name one team on the board.', candidates: labels }
        const captain = captainId(label)
        recipients = roster.filter(seat => captain ? seat.agent === captain : seat.team === label)
        channel = { kind: 'team', target: label }; address = label
      } else if (input.channel === 'whisper') {
        if (['main', 'owner'].includes(target.toLowerCase())) return { ok: false, reason: 'Use the prompt line for main.' }
        recipients = roster.filter(seat => seat.agent === target || seat.name.toLowerCase() === target.toLowerCase())
        if (recipients.length !== 1) return { ok: false, reason: 'Name one enrolled crewmate.', candidates: (recipients.length ? recipients : roster).map(seat => roster.filter(other => other.name.toLowerCase() === seat.name.toLowerCase()).length > 1 ? `${seat.name} (${seat.agent})` : seat.name) }
        channel = { kind: 'whisper', target: recipients[0]!.name }; address = recipients[0]!.name
      } else return { ok: false, reason: 'Use general, team or whisper.' }
      const event: BoardEvent = { schema: 1, boardId, waveId, seq: 0, eventId: randomUUID(), author: { ...p.author, agentId: 'owner' }, authorName: 'owner', authorRole: 'owner', kind: 'ask', text: input.text, clientOpId: input.clientOpId, channel, addresses: [address, 'main'], mentions: [...new Set(['main', ...recipients.map(seat => seat.agent)])], recipients: seats().filter(seat => seat.agent === 'main' || recipients.some(recipient => recipient.agent === seat.agent)), relatedTasks: [], files: [], refs: [], createdAt: new Date(now()).toISOString(), payloadDigest: hash, threadId: randomUUID(), policyRevision: 1 }
      appendEvent(event)
      const waiting = wakes.posted(event, seats())
      for (const recipient of new Set([...event.mentions, ...waiting])) db.prepare('INSERT INTO deliveries (recipient, event, mode) VALUES (?, ?, ?)').run(recipient, event.eventId, recipient === 'main' || waiting.includes(recipient) ? 'mention-wake-body' : 'mention-body')
      return { ok: true, eventId: event.eventId, seq: event.seq, replay: false, channel, recipients: event.mentions }
    })
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) } }
  if (result.ok && !result.replay) publish()
  return result
}
