import { LEAVE_PENDING, standInRunner } from '../lib/seatDoor.ts'
import { refused } from '../../src/runner/wire/errors.ts'
import type { RunnerDoor } from '../../src/daemon/runnerConnection.ts'

type Workers = typeof import('../../src/daemon/concourseWorkers.ts')
type Quiesce = { action: 'prepare' | 'commit' | 'cancel'; token: string }

export function retiringRunners(sup: Workers, dir: string, gonePid: number) {
  const killed: string[] = []
  const asked: Array<{ short: string; action: string }> = []
  const owes = new Map<string, string>()
  const held = new Set<string>()
  const dying = new Set<string>()
  const stands = new Map<string, ReturnType<typeof standInRunner>>()
  const livePid = (runnerId: string): number | undefined => sup.readSessionWorkers(dir)[runnerId]?.pid
  const leave = (runnerId: string): void => {
    sup.updateConcourseWorkers(workers => {
      const w = workers[runnerId]
      if (w) w.pid = gonePid
    }, dir)
  }
  const seat = (runnerId: string): void => {
    stands.set(runnerId, standInRunner({
      autoAnswer: {
        'session/quiesce': (params: unknown) => {
          const request = params as Quiesce
          asked.push({ short: runnerId, action: request.action })
          const owed = owes.get(runnerId)
          if (request.action === 'prepare' && owed !== undefined) throw refused(owed, 'quiesce')
          if (request.action === 'prepare' && dying.has(runnerId)) {
            setTimeout(() => stands.get(runnerId)?.close('the runner died'), 0)
            return LEAVE_PENDING
          }
          if (request.action === 'prepare' && held.has(runnerId)) return LEAVE_PENDING
          if (request.action === 'commit') setTimeout(() => leave(runnerId), 20)
          return { token: request.token, phase: request.action === 'prepare' ? 'prepared' : request.action === 'commit' ? 'committed' : 'cancelled' }
        },
      },
    }))
  }
  return {
    killed,
    owes,
    held,
    dying,
    preparing: async (runnerId: string): Promise<() => void> => {
      const request = await stands.get(runnerId)!.nextRequest('session/quiesce')
      return () => request.answer({ token: (request.params as Quiesce).token, phase: 'prepared' })
    },
    seat,
    leave,
    askedOf: (runnerId: string): string => asked.filter(a => a.short === runnerId).map(a => a.action).join(','),
    roster: {
      kill: (short: string): boolean => (killed.push(short), true),
      has: (short: string) => ({ alive: livePid(short) !== gonePid && livePid(short) !== undefined, present: true }),
      door: (short: string): RunnerDoor | undefined => stands.get(short)?.connection,
    },
    close: (): void => {
      for (const stand of stands.values()) stand.close()
    },
  }
}
