#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const home = mkdtempSync(join(tmpdir(), 'host-volume-damaged-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)

const volumes = await import('../../src/services/host/volumes.ts')

const dir = join(home, 'host', 'volumes')
mkdirSync(dir, { recursive: true })
const GOOD = { id: 'good', name: 'mercury-weights-good', model: 'org/model', include: '', kind: 'network', dataCenter: 'dc-1', size: 10, price: 1, createdAt: '2026-11-09T00:00:00Z', state: 'kept' }
const goodText = JSON.stringify(GOOD) + '\n'
writeFileSync(join(dir, 'good.json'), goodText)
writeFileSync(join(dir, 'cut.json'), '{ "id": "cut", "name": "mercury-weights-cut", "model": "org/mod')
const recipe = { model: 'org/model', include: '' } as never
const calls = { volumes: 0, pods: 0 }
const api = {
  volumes: async () => {
    calls.volumes++
    return [{ id: 'good', kind: 'network', name: GOOD.name, size: 10, dataCenter: 'dc-1' }]
  },
  pods: async () => {
    calls.pods++
    return []
  },
} as never
const caught = (run: () => unknown): Error | undefined => {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  return undefined
}
const rejected = async (run: () => Promise<unknown>): Promise<Error | undefined> => {
  try {
    await run()
  } catch (error) {
    return error as Error
  }
  return undefined
}
const names = (error: Error | undefined, file: string): boolean => error !== undefined && error.message.includes(join(dir, file)) && error.message.includes('cannot be read') && error.message.includes('repair or move that file, then try again')

section('§1 a damaged record stops the list — and the error names the file and why')
{
  const error = caught(() => volumes.keptVolumes())
  check('the list of kept disks does not read past a record it cannot parse (a damaged record may be a disk that still bills)', error !== undefined, 'no throw')
  check('the error names the record file, says why it cannot be read and what to do', names(error, 'cut.json') && error!.name === 'Error', `${error?.name}: ${error?.message}`)
  check('the parser\'s own error rides as the cause', error?.cause instanceof SyntaxError, String(error?.cause))
  check('the record that reads still reads by its id', volumes.readKeptVolume('good')?.name === GOOD.name)
  const one = caught(() => volumes.readKeptVolume('cut'))
  check('reading the damaged record by its id names the file too', names(one, 'cut.json'), `${one?.name}: ${one?.message}`)
  check('a record that is not there is still no record, and an id that is no id is still refused', volumes.readKeptVolume('absent') === undefined && caught(() => volumes.readKeptVolume('../good'))?.message === 'Invalid volume id')
}

section('§2 a record that parses but is not a volume record names the file and the fields')
{
  rmSync(join(dir, 'cut.json'))
  writeFileSync(join(dir, 'shape.json'), JSON.stringify({ id: 'shape', name: 'mercury-weights-shape', kind: 'network', state: 'kept' }))
  const error = caught(() => volumes.keptVolumes())
  check('the error names the file and the fields that are missing', names(error, 'shape.json') && /\bmodel: /.test(error!.message) && /\bsize: /.test(error!.message), `${error?.name}: ${error?.message}`)
  rmSync(join(dir, 'shape.json'))
  writeFileSync(join(dir, 'cut.json'), '{ "id": "cut"')
}

section('§3 nothing acts on a partial list: no reconcile, no rental')
{
  const reconcile = await rejected(() => volumes.reconcileVolumes(api))
  check('reconcile refuses with the same named error', names(reconcile, 'cut.json'), `${reconcile?.name}: ${reconcile?.message}`)
  check('…and rewrites no record', readFileSync(join(dir, 'good.json'), 'utf8') === goodText && readdirSync(dir).sort().join(',') === 'cut.json,good.json', readdirSync(dir).join(','))
  calls.volumes = 0
  const rental = await rejected(() => volumes.rentalVolume(api, recipe))
  check('a rental of the model refuses with the named error before it asks the vendor anything', names(rental, 'cut.json') && calls.volumes === 0 && calls.pods === 0, `${rental?.message} · calls ${JSON.stringify(calls)}`)
}

section('§4 with the damaged file moved away the list reads and reconcile acts again')
{
  rmSync(join(dir, 'cut.json'))
  const listed = volumes.keptVolumes()
  check('the list reads the one record', listed.length === 1 && listed[0]!.id === 'good')
  const live = await rejected(() => volumes.reconcileVolumes(api))
  check('reconcile runs and writes the vendor\'s facts onto the record', live === undefined && volumes.readKeptVolume('good')?.price === volumes.networkMonthly(10), String(live?.message))
  const rental = await volumes.rentalVolume(api, recipe)
  check('the rental finds the model\'s disk', rental?.id === 'good')
}

removeScratch(home)
console.log(failures === 0 ? '\nprove-host-volume-damaged-record: ALL LAWS HOLD' : `\nprove-host-volume-damaged-record: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
