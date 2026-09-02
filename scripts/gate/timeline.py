#!/usr/bin/env python3
# ============================================================================
#  scripts/gate/timeline.py — the pool's stopwatch.
#
#  Reads what scripts/run-all-suites.sh leaves in its scratch dir — the event
#  log (one line per launch/finish/queue/tripwire, each with the lane state
#  after the event), pool.json (knobs + phase boundaries), and every captured
#  <suite>.out — and answers "where did the time go" once, without a second
#  diagnostic pool:
#
#    · per run: start/end offsets (from the gate's t0), lane, slot weight,
#      class, the watchdog budget it ran under, queue wait (eligible →
#      launched), cpu seconds, rc;
#    · per phase: prebuild (seconds, or cache hit / skipped), pool drain,
#      exclusive, solo re-runs after the drain, the verdict tail; the phases
#      sum to the wall exactly (one set of boundary timestamps);
#    · lane occupancy integrated over the event intervals — busy seconds,
#      occupancy %, STARVED seconds (work queued, lane under its cap, slots
#      full) and IDLE-UNDER-CAP seconds (lane under its cap with nothing
#      queued — the tail) — and the slot budget's own floor: Σ(weight × secs)
#      ÷ slots, the bound no schedule beats while the weights hold;
#    · the critical path as a SLOT-HANDOFF chain: from the last run of the
#      pool back through whichever run's finish freed the slot each one
#      launched on (any lane), with the gaps named;
#    · the top wall contributors at suite granularity and at prover
#      granularity — `── <prover>  <N>s` lines in suite output are the one
#      agreed shape (the runners print them after each prover, <prover> being
#      the repo-relative path `scripts/<suite>/<file>` or the bare file name;
#      the row records the file — the suite column names the directory);
#    · watchdog kills, the dist tripwire, and the cpu audit of the slot
#      model (cpu seconds ÷ wall seconds per lane).
#
#  Writes <outdir>/timeline.json — the verdict's schema-versioned "timeline"
#  key — and prints the compact stopwatch. Usage:
#      timeline.py <outdir> <wall-seconds>
# ============================================================================
import glob
import json
import os
import re
import sys

SCHEMA = 1
PROVER_LINE = re.compile(r'^\s*──\s+(\S+)\s+(\d+)s\s*$')
KILL_MARK = '__SUITE_TIMEOUT'


def main(outdir: str, wall_s: int) -> int:
    pool = json.load(open(os.path.join(outdir, 'pool.json')))
    slots_total = int(pool['slots'])
    pty_max = int(pool['ptyMax'])
    pure_max = int(pool['pureMax'])
    ph = pool['phases']
    pool_start = int(ph['poolStartS'])
    pool_end = int(ph['poolEndS'])
    solo_end = int(ph['soloEndS'])

    # ── events → runs + state intervals ──────────────────────────────────────
    runs = {}          # (suite, attempt) → run dict
    states = []        # (t_abs, state-after-event)
    eligible = {}      # (suite, attempt) → eligible offset (abs)
    retry_queued = {}
    dist_event = None
    for line in open(os.path.join(outdir, 'events.log')):
        parts = line.split()
        if len(parts) < 14:
            continue
        t = int(parts[0]) + pool_start
        kind, suite, attempt, lane, wt, budget = parts[1], parts[2], int(parts[3]), parts[4], parts[5], parts[6]
        q_pty, q_cpu, q_pure, pty_n, pure_n, slots = (int(x) for x in parts[7:13])
        extra = ' '.join(parts[13:])
        states.append((t, dict(q_pty=q_pty, q_cpu=q_cpu, q_pure=q_pure, pty_n=pty_n, pure_n=pure_n, slots=slots)))
        key = (suite, attempt)
        if kind == 'retryq':
            retry_queued[key] = t
        elif kind == 'launch':
            cls = lane
            for kv in extra.split(','):
                if kv.startswith('class='):
                    cls = kv[6:]
            elig = retry_queued.get(key, pool_start if lane != 'solo' else pool_end)
            runs[key] = dict(
                suite=suite, attempt=attempt,
                kind='pool' if attempt == 1 else ('retry-solo' if lane == 'solo' else 'retry-in-pool'),
                **{'class': cls}, lane=lane, weight=(int(wt) if wt.isdigit() else 0),
                budgetS=(int(budget) if budget.isdigit() else None),
                eligibleS=elig, startS=t, endS=None, secs=None, queueWaitS=t - elig, cpuS=None, rc=None,
            )
        elif kind == 'finish' and key in runs:
            r = runs[key]
            r['endS'] = t
            for kv in extra.split(','):
                k, _, v = kv.partition('=')
                if k == 'rc' and v.isdigit():
                    r['rc'] = int(v)
                elif k == 'secs' and v.isdigit():
                    r['secs'] = int(v)
                elif k == 'cpu' and v.isdigit():
                    r['cpuS'] = int(v)
            if r['secs'] is None:
                r['secs'] = t - r['startS']
        elif kind == 'distchange':
            dist_event = dict(atS=t, suspects=[s for s in extra.split(',') if s and s != '-'])
    run_list = sorted(runs.values(), key=lambda r: (r['startS'], r['suite'], r['attempt']))
    for r in run_list:
        if r['endS'] is None:   # an attempt the log never closed (the gate was cut short)
            r['endS'] = pool_end
            r['secs'] = r['endS'] - r['startS']

    # ── lane integrals over the event intervals ───────────────────────────────
    busy = dict(pty=0, pure=0, slots=0)
    starved = dict(pty=0, cpu=0, pure=0)
    pty_starved_by_others = 0   # pty work waited while cpu/pure work held the slots it needed
    idle_under_cap = dict(pty=0)
    packing_idle_slot_s = 0
    for i in range(len(states) - 1):
        t0, s = states[i]
        dt = min(states[i + 1][0], pool_end) - t0   # the lanes exist inside the pool phase only
        if dt <= 0:
            continue
        busy['pty'] += s['pty_n'] * dt
        busy['pure'] += s['pure_n'] * dt
        busy['slots'] += min(s['slots'], slots_total) * dt
        if s['q_pty'] > 0 and s['pty_n'] < pty_max:
            starved['pty'] += dt
            if s['slots'] > 2 * s['pty_n']:
                pty_starved_by_others += dt
        if s['q_pty'] == 0 and s['pty_n'] < pty_max:
            idle_under_cap['pty'] += dt
        if s['q_cpu'] > 0 and s['slots'] + 2 > slots_total:
            starved['cpu'] += dt
        if s['q_pure'] > 0 and s['pure_n'] < pure_max and s['slots'] + 1 > slots_total:
            starved['pure'] += dt
        if (s['q_pty'] + s['q_cpu'] + s['q_pure']) > 0 and s['slots'] < slots_total:
            packing_idle_slot_s += (slots_total - s['slots']) * dt

    pool_runs = [r for r in run_list if r['kind'] != 'retry-solo']
    excl_runs = [r for r in pool_runs if r['lane'] == 'exclusive']
    drain = pool_end - pool_start
    exclusive_s = sum(r['secs'] for r in excl_runs)
    lane_secs = {}
    lane_cpu = {}
    for r in run_list:
        lane_secs[r['lane']] = lane_secs.get(r['lane'], 0) + r['secs']
        lane_cpu[r['lane']] = lane_cpu.get(r['lane'], 0) + (r['cpuS'] or 0)
    slot_work = sum(r['weight'] * r['secs'] for r in pool_runs if r['lane'] != 'exclusive')
    slot_floor = (slot_work + slots_total - 1) // slots_total + exclusive_s if slots_total else 0
    pty_floor = (lane_secs.get('pty', 0) + pty_max - 1) // pty_max if pty_max else 0
    pct = lambda num, den: round(100.0 * num / den, 1) if den > 0 else 0.0

    # ── the slot-handoff critical path ────────────────────────────────────────
    chain = []
    gaps = 0
    if pool_runs:
        cur = max(pool_runs, key=lambda r: (r['endS'], r['startS']))
        seen = set()
        while cur is not None and id(cur) not in seen:
            seen.add(id(cur))
            chain.append(cur)
            if cur['startS'] <= pool_start:
                break
            preds = [r for r in pool_runs if r['endS'] <= cur['startS'] and r is not cur]
            if not preds:
                gaps += cur['startS'] - pool_start
                break
            pred = max(preds, key=lambda r: (r['endS'], r['secs']))
            gaps += cur['startS'] - pred['endS']
            cur = pred
        chain.reverse()

    # ── prover attribution: the one agreed line shape in captured output ─────
    provers = []
    for r in run_list:
        sub = {'pool': '', 'retry-in-pool': 'retry1', 'retry-solo': 'retry2'}[r['kind']]
        path = os.path.join(outdir, sub, r['suite'] + '.out')
        if not os.path.exists(path):
            continue
        killed = False
        try:
            with open(path, errors='replace') as fh:
                for line in fh:
                    m = PROVER_LINE.match(line)
                    if m:
                        # the token is the prover's repo-relative path or its bare file name;
                        # the suite column already names the directory, so the row keeps the file
                        provers.append(dict(suite=r['suite'], attempt=r['attempt'], prover=m.group(1).rsplit('/', 1)[-1], secs=int(m.group(2))))
                    elif KILL_MARK in line:
                        killed = True
        except OSError:
            pass
        r['killed'] = killed or r['rc'] == 137
    # one row per (suite, prover): the slowest attempt is the one that matters
    prover_lines = len(provers)
    slowest = {}
    for p in provers:
        k = (p['suite'], p['prover'])
        if k not in slowest or p['secs'] > slowest[k]['secs']:
            slowest[k] = p
    provers = sorted(slowest.values(), key=lambda p: (-p['secs'], p['suite'], p['prover']))
    kills = [dict(suite=r['suite'], attempt=r['attempt'], budgetS=r['budgetS'], secs=r['secs']) for r in run_list if r.get('killed')]

    in_pool_retries = [r for r in run_list if r['kind'] == 'retry-in-pool']
    solo_retries = [r for r in run_list if r['kind'] == 'retry-solo']
    tail_s = wall_s - solo_end
    prebuild_s = int(ph['prebuildS'])
    setup_s = pool_start - prebuild_s   # suite discovery, the duration table, the queues — before the pool
    timeline = dict(
        schema=SCHEMA,
        cores=pool['cores'], slots=slots_total, ptyMax=pty_max, pureMax=pure_max,
        sequential=pool.get('sequential', False), retryMode=pool['retryMode'], budget=pool['budget'],
        phases=dict(setupS=setup_s, prebuild=ph['prebuild'], prebuildS=prebuild_s, poolS=drain, exclusiveS=exclusive_s,
                    soloRetryS=solo_end - pool_end, tailS=tail_s, wallS=wall_s),
        runs=[{k: v for k, v in r.items() if k != 'killed'} for r in run_list],
        lanes=dict(
            pty=dict(cap=pty_max, busyS=busy['pty'], occupancyPct=pct(busy['pty'], pty_max * drain),
                     starvedS=starved['pty'], starvedByNonPtyS=pty_starved_by_others, idleUnderCapS=idle_under_cap['pty']),
            cpu=dict(busyS=lane_secs.get('cpu', 0), starvedS=starved['cpu']),
            pure=dict(cap=pure_max, busyS=busy['pure'], occupancyPct=pct(busy['pure'], pure_max * drain), starvedS=starved['pure']),
            slots=dict(total=slots_total, busySlotS=busy['slots'], occupancyPct=pct(busy['slots'], slots_total * drain),
                       packingIdleSlotS=packing_idle_slot_s),
        ),
        floors=dict(slotFloorS=slot_floor, ptyFloorS=pty_floor, poolDrainS=drain, overSlotFloorS=drain - slot_floor),
        criticalPath=dict(
            chain=[dict(suite=r['suite'], attempt=r['attempt'], lane=r['lane'], startS=r['startS'], endS=r['endS'], secs=r['secs']) for r in chain],
            chainS=sum(r['secs'] for r in chain), gapS=gaps, endS=(chain[-1]['endS'] if chain else pool_start),
        ),
        topWall=[dict(suite=r['suite'], attempt=r['attempt'], lane=r['lane'], secs=r['secs'])
                 for r in sorted(run_list, key=lambda r: (-r['secs'], r['suite']))[:10]],
        topProvers=provers[:10],
        proverLines=prover_lines,
        retries=dict(inPool=len(in_pool_retries), inPoolGreen=sum(1 for r in in_pool_retries if r['rc'] == 0),
                     inPoolS=sum(r['secs'] for r in in_pool_retries),
                     solo=len(solo_retries), soloGreen=sum(1 for r in solo_retries if r['rc'] == 0),
                     soloS=sum(r['secs'] for r in solo_retries)),
        kills=kills,
        cpu=dict(totalS=sum(lane_cpu.values()),
                 byLane={l: dict(cpuS=lane_cpu.get(l, 0), wallS=lane_secs.get(l, 0),
                                 ratio=round(lane_cpu.get(l, 0) / lane_secs[l], 2) if lane_secs.get(l) else None)
                         for l in sorted(lane_secs)}),
        distMutated=dist_event if pool.get('distMutated') or dist_event else None,
    )
    with open(os.path.join(outdir, 'timeline.json'), 'w') as fh:
        json.dump(timeline, fh, separators=(',', ':'))

    # ── the stopwatch ─────────────────────────────────────────────────────────
    pre = {'hit': 'cache hit', 'built': 'built', 'skipped': 'skipped by MERCURY_GATE_NO_PREBUILD', 'none': 'none'}[ph['prebuild']]
    print('── stopwatch ' + '─' * 60)
    print(f"  wall {wall_s}s = setup {setup_s}s · prebuild {prebuild_s}s ({pre}) · pool {drain}s (exclusive {exclusive_s}s) · "
          f"solo re-runs {solo_end - pool_end}s · tail {tail_s}s")
    print(f"  slots {slots_total}: {timeline['lanes']['slots']['occupancyPct']}% busy · slot floor {slot_floor}s · drain {drain}s "
          f"({drain - slot_floor:+d}s over the floor) · pty≤{pty_max}: {timeline['lanes']['pty']['occupancyPct']}% busy, "
          f"floor {pty_floor}s, starved {starved['pty']}s, idle-under-cap {idle_under_cap['pty']}s · "
          f"cpu starved {starved['cpu']}s · pure starved {starved['pure']}s")
    if chain:
        hops = ' → '.join(f"{r['suite']}{'' if r['attempt'] == 1 else '#' + str(r['attempt'])} {r['secs']}" for r in chain[-12:])
        lead = '… → ' if len(chain) > 12 else ''
        print(f"  critical path (slot handoffs, {len(chain)} hops, chain {timeline['criticalPath']['chainS']}s, gaps {gaps}s): {lead}{hops}")
    print('  top wall: ' + ' · '.join(f"{w['suite']}{'' if w['attempt'] == 1 else '#' + str(w['attempt'])} {w['secs']}" for w in timeline['topWall']))
    if provers:
        print('  top provers: ' + ' · '.join(f"{p['suite']}/{p['prover']} {p['secs']}" for p in provers[:10]))
    else:
        print('  top provers: none — no `── <prover>  <N>s` lines in suite output')
    rt = timeline['retries']
    print(f"  flake re-runs: {rt['inPool'] + rt['solo']} — in-pool {rt['inPool']} ({rt['inPoolGreen']} green, Σ {rt['inPoolS']}s inside the pool) · "
          f"solo {rt['solo']} ({rt['soloGreen']} green, Σ {rt['soloS']}s after the drain)")
    b = pool['budget']
    rule = f"{b['overrideS']}s pinned" if b.get('overrideS') else f"max({b['floorS']}s, {b['k']}×last)"
    cpu_bits = ' · '.join(f"{l} {v['ratio']}×wall" for l, v in timeline['cpu']['byLane'].items() if v['ratio'] is not None)
    print(f"  watchdog {rule} · kills {len(kills)}{(' (' + ', '.join(k['suite'] for k in kills) + ')') if kills else ''} · "
          f"cpu Σ {timeline['cpu']['totalS']}s ({cpu_bits})")
    if timeline['distMutated']:
        print(f"  ⚠ dist mutated in-pool at +{timeline['distMutated']['atS']}s — suspects: {', '.join(timeline['distMutated']['suspects'])}")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], int(sys.argv[2])))
