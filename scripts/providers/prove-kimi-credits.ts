import React from 'react'
import { tally, usagePlanWorld } from './lib/usage-plan-world.ts'

const { check, finish } = tally()
const world = await usagePlanWorld()
try {
  const { owner, reader, fresh, ink } = world
  const wallet = (amountLeft: unknown = '1234000000', currency: unknown = 'USD') => ({
    balance: { type: 'BOOSTER', amount: '2000000000', amountLeft },
    monthlyChargeLimit: { priceInCents: '5000', currency },
    monthlyUsed: { priceInCents: '766', currency },
    monthlyChargeLimitEnabled: true,
  })
  const body = {
    usages: {
      limit_5h: { used_ratio: '0.25', reset_time: new Date(world.resetAtMs).toISOString() },
      limit_7d: { used_ratio: 0.5 },
      limit_month_total: { used_ratio: 0.75 },
      limit_month_code: { used_ratio: 0.125 },
    },
    boosterWallet: wallet(),
  }
  world.setBody(body)
  const before = world.requests.length
  await owner.refreshProviderUsage('moonshot', { fetchImpl: world.fetchImpl, now: world.now, force: true })
  const usage = owner.usageForProvider('moonshot')
  check('Kimi Extra Usage and plan windows arrive in the same single GET /usages', world.requests.length === before + 1 && world.requests.at(-1) === 'GET /coding/v1/usages' && usage.credits?.display === 'USD 12.34 Extra Usage balance', JSON.stringify(usage) + ' — refreshProviderUsage and usageForProvider in src/models/roads/providerUsage.ts must read the Kimi wallet from the one GET /coding/v1/usages and show it as credits; the decode is decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts')
  check('current Kimi used_ratio windows preserve their units without inventing counts', usage.windows.map(w => `${w.label}:${w.usedPct}`).join('|') === '5h:25|7d:50|month:75|month code:12.5' && reader.kimiObservedManagedUsage()?.windows.every(w => w.used === undefined && w.limit === undefined) === true, JSON.stringify(usage.windows) + ' — decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts must turn each used_ratio into a percent window and leave used and limit unset')
  if (!process.argv.includes('--base-only')) {
    check('the credits and windows use one observation stamp and freshness horizon', usage.credits?.observedAtMs === world.now() && usage.windows.every(w => w.observedAtMs === world.now()) && usage.credits.freshForMs === fresh.usageStaleAfterMs(), JSON.stringify(usage) + ' — credits and windows must share one observedAtMs and the horizon from usageStaleAfterMs in src/models/roads/usageFreshness.ts; see providerUsage.ts')
    const count = world.requests.length
    await Promise.all([owner.refreshProviderUsage('moonshot', { fetchImpl: world.fetchImpl, now: world.now }), owner.refreshProviderUsage('moonshot', { fetchImpl: world.fetchImpl, now: world.now })])
    check('credits introduce no second poll inside the existing TTL', world.requests.length === count, `${world.requests.length - count} extra request(s) — refreshProviderUsage in src/models/roads/providerUsage.ts must not poll again inside the freshness horizon`)
    for (const columns of [80, 120]) {
      const words = owner.usageCreditsLine(usage.credits, world.now())!
      const compact = owner.usageCreditsLine(usage.credits, world.now(), 'compact')!
      const deck = owner.usageCreditsWords(usage.credits, world.now())!
      const content = React.createElement(ink.Box, { flexDirection: 'column', width: columns }, ...[words, compact, deck].map((value, index) => React.createElement(ink.Text, { key: index }, value)))
      const board = await world.mount(content, { columns, rows: 8 })
      const frame = board.frame()
      check(`${columns} columns: shared Usage, rail and Deck words contain the Kimi balance`, frame.includes('credits: USD 12.34 Extra Usage balance') && frame.includes('credits USD 12.34 extra') && frame.includes(deck) && world.inBounds(frame, { columns, rows: 8 }), frame + ' — usageCreditsLine and usageCreditsWords in src/models/roads/providerUsage.ts must print the balance in these words and fit the width')
      world.save('kimi-credits-words', frame, { columns, rows: 8 })
      board.close()
    }
    world.setNow(world.now() + fresh.usageStaleAfterMs() + 60_000)
    world.refuse(true)
    await owner.refreshProviderUsage('moonshot', { fetchImpl: world.fetchImpl, now: world.now, force: true })
    const stale = owner.usageForProvider('moonshot')
    check('a refused read keeps the balance and its old stamp, labelled stale with the HTTP note', stale.credits?.observedAtMs === usage.credits?.observedAtMs && owner.usageCreditsLine(stale.credits, world.now())?.includes('stale') === true && stale.readerNote === 'Kimi /usages returned HTTP 503', JSON.stringify(stale) + ' — on a refused read providerUsage.ts must keep the old credits and stamp and set the HTTP note; the line must say stale')
    world.refuse(false)
    for (const [name, boosterWallet, amount] of [
      ['stated zero', wallet('0'), 'USD 0.00 Extra Usage balance'],
      ['stated negative balance', wallet('-100000000'), 'USD -1.00 Extra Usage balance'],
      ['CNY wallet', wallet('1234000000', 'CNY'), 'CNY 12.34 Extra Usage balance'],
      ['positive fraction of a cent', wallet('1'), 'USD 0.01 Extra Usage balance'],
      ['no wallet', null, undefined],
      ['no amountLeft', wallet(undefined), undefined],
      ['null amountLeft', wallet(null), undefined],
      ['empty amountLeft', wallet(''), undefined],
      ['unsafe amountLeft', wallet('99999999999999999999'), undefined],
      ['unstated currency', wallet('1234000000', null), undefined],
    ] as const) {
      const candidate = name === 'no amountLeft' ? { ...wallet(), balance: { type: 'BOOSTER', amount: '2000000000' } } : boosterWallet
      world.setBody({ usages: body.usages, boosterWallet: candidate })
      await owner.refreshProviderUsage('moonshot', { fetchImpl: world.fetchImpl, now: world.now, force: true })
      const read = owner.usageForProvider('moonshot')
      check(`${name}: only the provider-stated amount and currency become credits`, read.credits?.display === amount && read.credits?.state === (amount === undefined ? 'unreported' : 'reported') && read.readerNote === undefined, JSON.stringify(read.credits) + ' — decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts must turn only a stated amountLeft and currency into credits')
    }
    const unitless = reader.decodeKimiManagedUsage({ usage: { used: '3', limit: '10' }, boosterWallet: null }, world.now())!
    const noMoney = owner.usageForProvider('moonshot', { moonshotAccount: () => ({ kind: 'kimi-oauth' }), kimiManagedUsage: () => unitless })
    check('unitless plan quota is never relabelled money or credits', noMoney.credits?.state === 'unreported' && noMoney.credits.reason?.includes('Kimi /usages') === true && noMoney.credits.reason.includes('Kimi Code Console'), JSON.stringify(noMoney.credits) + ' — a plan quota with no unit must stay unreported credits and name Kimi /usages and Kimi Code Console as the reason (src/models/roads/providerUsage.ts)')
    const malformed = reader.decodeKimiManagedUsage({ usages: { limit_5h: { used_ratio: '' }, limit_7d: { used_ratio: null }, limit_month_total: { used_ratio: -1 } }, boosterWallet: null }, world.now())
    check('missing, blank and invalid ratios never fabricate a zero-percent meter', malformed?.windows.length === 0, JSON.stringify(malformed?.windows) + ' — decodeKimiManagedUsage in src/models/roads/moonshot/moonshotUsageState.ts must drop blank, null and negative ratios')
    const both = reader.decodeKimiManagedUsage({ ...body, limits: [world.fiveHour, world.week] }, world.now())!
    check('one window per stated length: the counted 5h and 7d figures stand over their ratio twins, the monthly ratios stay', both.windows.map(w => `${w.name}:${w.used !== undefined ? `${w.used}/${w.limit}` : w.usedRatio}`).join('|') === '5h:50/100|7d:250/1000|month:0.75|month code:0.125' && both.windows.every(w => (w.used === undefined) !== (w.usedRatio === undefined)), JSON.stringify(both.windows))
    const login = await import(world.path('src/models/roads/moonshot/moonshotLogin.ts'))
    check('the login receipt names the window and states the counts the wire stated', login.kimiUsageReceiptLine(both).startsWith('usage 5h 50/100 (50%)'), login.kimiUsageReceiptLine(both) + ' — kimiUsageReceiptLine in src/models/roads/moonshot/moonshotLogin.ts')
    check('a window stated only as a ratio keeps its percent on the receipt, never an invented count', login.kimiUsageReceiptLine(reader.decodeKimiManagedUsage(body, world.now())!).startsWith('usage 5h 25%'), login.kimiUsageReceiptLine(reader.decodeKimiManagedUsage(body, world.now())!))
    world.setBody(body)
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const requested = new Promise<void>(resolve => { started = resolve })
    const delayedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await world.fetchImpl(input, init)
      started()
      await waiting
      return response
    }) as typeof fetch
    const oldRead = owner.refreshProviderUsage('moonshot', { fetchImpl: delayedFetch, now: world.now, force: true })
    await requested
    world.accounts.writeMoonshotTokens({ accessToken: 'other-kimi-account', refreshToken: 'other-kimi-refresh' })
    release()
    await oldRead
    const changed = owner.usageForProvider('moonshot')
    check('another account inherits neither the departed wallet nor its failure note', changed.credits?.state === 'unreported' && changed.credits.compact === 'not read yet' && changed.readerNote === undefined && changed.windows.length === 0, JSON.stringify(changed) + ' — a read that started under the old account must be dropped when the Moonshot tokens change (src/models/roads/providerUsage.ts)')
    world.refuse(true)
    await reader.fetchKimiManagedUsage('kimi-fixture-access', 'global', { fetchImpl: world.fetchImpl, now: world.now })
    const unread = owner.usageForProvider('moonshot')
    check('a failed first read is not a claim that the plan has no balance', unread.credits?.reason === 'Kimi /usages returned HTTP 503' && unread.credits.compact === 'not read', JSON.stringify(unread.credits) + ' — a failed first read must stay unreported with the HTTP reason and the compact words not read (src/models/roads/providerUsage.ts)')
    check('no fixture request escaped loopback', world.escaped.length === 0, JSON.stringify(world.escaped) + ' — a usage read went to a real host instead of the injected fetchImpl; pass fetchImpl through in src/models/roads/providerUsage.ts')
  }
} finally {
  world.close()
}
finish()
