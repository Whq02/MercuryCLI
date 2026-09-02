#!/usr/bin/env bash
# ============================================================================
#  scripts/model-routing/live/compositions.sh — A6: the LIVE cross-provider
#  compositions, dispatched once each (billed; §20.1 spend law: subscription
#  logins, ≤1 Sol role per formation, never Fable). SOLO-RUN, never a gate
#  member. Mirrors the proven live-bus-heal-e2e.sh rig shape.
#
#    A. Opus Scribe → SOL implementer  — scribe-engage daemon with the
#       implementer seat slotted gpt-5.6-sol; a stranded dispatch envelope is
#       delivered to the REAL Sol child, which answers the bus with a
#       structured envelope (refRequestId correlation).
#    B. SOL Scribe → Opus implementer  — a headless foreground Scribe turn ON
#       gpt-5.6-sol authors the typed dispatch envelope over the bus; the
#       REAL opus[1m]@max implementer executes and answers.
#    C. Mixed party (≤1 Sol executor) — the 4-seat party daemon with dps1
#       slotted gpt-5.6-sol (tank/healer Opus doctrine, dps2/3 Sonnet); ONE
#       routed work-unit to the Sol executor; reply observed on the bus.
#
#  Usage: bash scripts/model-routing/live/compositions.sh [A|B|C|all]
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
DIST="$repo/dist/mercury.mjs"
CONFIG_HOME="${MERCURY_CONFIG_DIR:-$HOME/.mercury}"
TIMEOUT_S="${MERCURY_APEX_A6_TIMEOUT_S:-360}"
PHASE="${1:-all}"

fail() { echo "❌ $1"; cleanup; exit 1; }
note() { echo "· $1"; }
ok()   { echo "✓ $1"; }

DAEMON_PID=""
cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 1; done
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  DAEMON_PID=""
}
trap cleanup EXIT

[ -f "$DIST" ] || fail "dist missing — bun run build.ts first"

strand_dispatch() { # $1=inbox path  $2=request id  $3=task text
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys, time
p, rid, task = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    msgs = json.load(open(p))
except Exception:
    msgs = []
ts = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
env = {
    'type': 'scribe_protocol', 'kind': 'dispatch', 'request_id': rid,
    'from': 'team-lead', 'timestamp': ts, 'task': task, 'title': 'apex A6 live composition',
}
msgs.append({'from': 'team-lead', 'text': json.dumps(env), 'timestamp': ts, 'read': False})
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(msgs, open(p, 'w'), indent=2)
PY
}

await_reply() { # $1=lead inbox  $2=request id  → prints the matching envelope or fails
  local deadline=$(( $(date +%s) + TIMEOUT_S ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if python3 - "$1" "$2" <<'PY'
import json, sys
p, rid = sys.argv[1], sys.argv[2]
try:
    msgs = json.load(open(p))
except Exception:
    sys.exit(1)
for m in msgs:
    try:
        env = json.loads(m.get('text', ''))
    except Exception:
        continue
    if env.get('refRequestId') == rid or env.get('ref_request_id') == rid:
        print(json.dumps({'kind': env.get('kind'), 'status': env.get('status'), 'detail': str(env.get('detail', env.get('summary', '')))[:160]}))
        sys.exit(0)
sys.exit(1)
PY
    then return 0; fi
    sleep 5
  done
  return 1
}

boot_daemon() { # $1=scratch  $2... env pairs (KEY=VAL) — boots daemon on $scratch/proj
  local scratch="$1"; shift
  mkdir -p "$scratch/proj"
  DAEMON_LOG="$scratch/daemon.log"
  env MERCURY_CONFIG_DIR="$CONFIG_HOME" \
      MERCURY_DAEMON_DIR="$scratch/daemon-home" \
      MERCURY_SCRIBE_DAEMON_PERSIST=1 MERCURY_EVOLUTION_LEDGER=0 \
      "$@" \
      node "$DIST" daemon "$scratch/proj" >"$DAEMON_LOG" 2>&1 &
  DAEMON_PID=$!
  note "daemon booting (pid $DAEMON_PID, log $DAEMON_LOG)"
}

# ────────────────────────────────────────────────────────────────────────────
phase_a() {
  echo ""
  echo "── PHASE A · Opus Scribe → SOL implementer ────────────────────────────"
  local scratch; scratch="$(mktemp -d /tmp/apex-a6-a-XXXXXX)"
  local inboxes="$CONFIG_HOME/teams/scribe/inboxes"
  local rid="dispatch-apex-a6-sol-impl-$(date +%s)@team-lead"
  strand_dispatch "$inboxes/implementer.json" "$rid" \
    "Live composition check. Reply with ONE progress envelope: status done, detail 'sol-implementer-pong'. No file work, no tools."
  ok "stranded dispatch $rid"
  boot_daemon "$scratch" MERCURY_DAEMON_SCRIBE_ENGAGE=1 MERCURY_PARTY=0 \
    MERCURY_IMPLEMENTER_MODEL=gpt-5.6-sol MERCURY_IMPLEMENTER_EFFORT=low
  for i in $(seq 1 40); do
    grep -q "Amanuensis Implementer spawned" "$DAEMON_LOG" 2>/dev/null && break
    kill -0 "$DAEMON_PID" 2>/dev/null || { tail -5 "$DAEMON_LOG"; fail "A: daemon died before spawn"; }
    sleep 1
  done
  grep -q "Amanuensis Implementer spawned" "$DAEMON_LOG" || { tail -8 "$DAEMON_LOG"; fail "A: implementer never spawned"; }
  local spawnline; spawnline="$(grep 'Amanuensis Implementer spawned' "$DAEMON_LOG" | head -1)"
  echo "$spawnline" | grep -q "gpt-5.6-sol" || fail "A: implementer is NOT Sol — $spawnline"
  ok "SOL implementer spawned — ${spawnline#*— }"
  local reply
  if reply="$(await_reply "$inboxes/team-lead.json" "$rid")"; then
    ok "Sol implementer answered the bus: $reply"
  else
    tail -12 "$DAEMON_LOG"; fail "A: no reply envelope within ${TIMEOUT_S}s"
  fi
  cleanup
  ok "PHASE A GREEN — Opus Scribe → Sol implementer (live)"
}

# ────────────────────────────────────────────────────────────────────────────
phase_b() {
  echo ""
  echo "── PHASE B · SOL Scribe → Opus implementer ────────────────────────────"
  local scratch; scratch="$(mktemp -d /tmp/apex-a6-b-XXXXXX)"
  local inboxes="$CONFIG_HOME/teams/scribe/inboxes"
  boot_daemon "$scratch" MERCURY_DAEMON_SCRIBE_ENGAGE=1 MERCURY_PARTY=0
  for i in $(seq 1 40); do
    grep -q "Amanuensis Implementer spawned" "$DAEMON_LOG" 2>/dev/null && break
    kill -0 "$DAEMON_PID" 2>/dev/null || { tail -5 "$DAEMON_LOG"; fail "B: daemon died before spawn"; }
    sleep 1
  done
  local spawnline; spawnline="$(grep 'Amanuensis Implementer spawned' "$DAEMON_LOG" | head -1)"
  echo "$spawnline" | grep -q "opus" || fail "B: implementer is not Opus — $spawnline"
  ok "Opus implementer up — ${spawnline#*— }"
  local marker="sol-scribe-pong-$(date +%s)"
  local before_count
  before_count="$(python3 -c "import json;print(len(json.load(open('$inboxes/implementer.json'))))" 2>/dev/null || echo 0)"
  # The SOL SCRIBE turn: a headless foreground scribe (MERCURY_SCRIBE=1 composes
  # the Scribe pack) ON gpt-5.6-sol authors the typed dispatch envelope via
  # SendMessage → the scribe bus.
  local out
  # MERCURY_SCRIBE_MODEL = the ENV slot tier (precedence: env pin >
  # persisted slot > default) — the scribe ROLE pin outranks --model by the §9
  # law, so the Sol slotting rides the seat machinery, exactly as A6 specifies.
  out="$(cd "$scratch/proj" && env MERCURY_CONFIG_DIR="$CONFIG_HOME" MERCURY_SCRIBE=1 MERCURY_PARTY=0 \
    MERCURY_SCRIBE_MODEL=gpt-5.6-sol \
    node "$DIST" -p "Dispatch exactly one task to the Implementer over the bus now: the task text is: Reply with ONE progress envelope: status done, detail '$marker'. No file work. Use your SendMessage dispatch envelope exactly as your protocol specifies, then stop." \
    --model gpt-5.6-sol --permission-mode flow --output-format json \
    --team-name scribe --agent-name team-lead --agent-id team-lead@scribe 2>&1 | tail -1)"
  echo "$out" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
mu = list((d.get('modelUsage') or {}).keys())
print(f'  scribe turn: error={d.get(\"is_error\")} models={mu}')
assert not d.get('is_error'), d.get('result')
assert any('gpt-5.6-sol' in m for m in mu), f'scribe turn did not run on Sol: {mu}'
" || { tail -5 "$DAEMON_LOG"; fail "B: the Sol scribe turn failed (out: ${out:0:300})"; }
  ok "Sol scribe turn settled on gpt-5.6-sol"
  # The dispatch envelope must EXIST on the bus, authored by the Sol scribe.
  local rid
  rid="$(python3 - "$inboxes/implementer.json" "$before_count" <<'PY'
import json, sys
p, before = sys.argv[1], int(sys.argv[2])
msgs = json.load(open(p))
for m in msgs[before:]:
    try:
        env = json.loads(m.get('text', ''))
    except Exception:
        continue
    if env.get('kind') == 'dispatch':
        print(env['request_id']); break
PY
)"
  [ -n "$rid" ] || fail "B: the Sol scribe did not author a dispatch envelope on the bus"
  ok "Sol-authored dispatch envelope on the bus: $rid"
  local reply
  if reply="$(await_reply "$inboxes/team-lead.json" "$rid")"; then
    ok "Opus implementer answered the Sol-routed dispatch: $reply"
  else
    tail -12 "$DAEMON_LOG"; fail "B: no reply within ${TIMEOUT_S}s"
  fi
  cleanup
  ok "PHASE B GREEN — Sol Scribe → Opus implementer (live)"
}

# ────────────────────────────────────────────────────────────────────────────
phase_c() {
  echo ""
  echo "── PHASE C · RETIRED — the party composition left with the multiplayer estate"
  echo "   (the daemon no longer spawns party seats; the scribe/implementer"
  echo "    compositions in phases A/B are the living surface)"
}

case "$PHASE" in
  A|a) phase_a ;;
  B|b) phase_b ;;
  C|c) phase_c ;;
  all) phase_a; phase_b; phase_c ;;
  *) fail "usage: compositions.sh [A|B|C|all]" ;;
esac

echo ""
echo "LIVE COMPOSITIONS — requested phase(s) GREEN"
