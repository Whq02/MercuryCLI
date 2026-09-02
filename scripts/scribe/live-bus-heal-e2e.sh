#!/usr/bin/env bash
# ============================================================================
#  live-bus-heal-e2e.sh — BILLED live round-trip of the dead-letter
#  fix, driven against the operator's REAL stranded dispatch.
#
#  NOT gate-joined (spawns a real daemon + a real opus[1m]@max Implementer and
#  burns tokens — an operator-run live script).
#
#  What it proves, on the real config home (~/.mercury/teams/scribe):
#    1. HEAL   — the unread dispatch stranded in the alias inbox
#                (Mercury-Implement.json, written by the pre-fix Scribe) MOVES
#                into implementer.json on the daemon's first drain pass.
#    2. DELIVER— the drain hands it to the real Implementer's stdin (the alias
#                copy AND the canonical copy end up read).
#    3. REPLY  — the real opus child answers with a structured envelope whose
#                refRequestId is the stranded dispatch's literal request_id,
#                landing in team-lead.json (where the fg Scribe polls).
#
#  Usage: bash scripts/scribe/live-bus-heal-e2e.sh
#  Env:   MERCURY_LIVE_E2E_TIMEOUT_S (default 300) — reply wait budget.
# ============================================================================
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
DIST="$repo/dist/mercury.mjs"
CONFIG_HOME="${MERCURY_CONFIG_DIR:-$HOME/.mercury}"
INBOXES="$CONFIG_HOME/teams/scribe/inboxes"
ALIAS_INBOX="$INBOXES/Mercury-Implement.json"
CANON_INBOX="$INBOXES/implementer.json"
LEAD_INBOX="$INBOXES/team-lead.json"
TIMEOUT_S="${MERCURY_LIVE_E2E_TIMEOUT_S:-300}"

fail() { echo "❌ $1"; cleanup; exit 1; }
note() { echo "· $1"; }
ok()   { echo "✓ $1"; }

SCRATCH="$(mktemp -d /tmp/bus-heal-e2e-XXXXXX)"
export MERCURY_DAEMON_DIR="$SCRATCH/daemon-home"   # hermetic control socket — never the real one
DAEMON_LOG="$SCRATCH/daemon.log"
DAEMON_PID=""
cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 1; done
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

[ -f "$DIST" ] || fail "dist missing — bun run build.ts first"

# Use the real stranded specimen when one exists (the first run consumed the
# operator's actual Jul-6 liveness dispatch); otherwise STRAND a synthetic one
# exactly the way the pre-fix sender did — an unread dispatch in the alias
# inbox — so the runner is repeatable.
REQ_ID="$(python3 - "$ALIAS_INBOX" <<'PY'
import json, os, sys, time
p = sys.argv[1]
try:
    msgs = json.load(open(p))
except Exception:
    msgs = []
unread = [m for m in msgs if not m.get('read')]
if unread:
    print(json.loads(unread[0]['text'])['request_id'])
else:
    ts = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    rid = f'dispatch-liveheal-{int(time.time()*1000)}@team-lead'
    env = {
        'type': 'scribe_protocol', 'kind': 'dispatch', 'request_id': rid,
        'from': 'team-lead', 'timestamp': ts,
        'task': 'Bus-heal liveness round-trip (synthetic strand). Reply with ONE progress envelope: status done, detail "pong". No file work.',
        'title': 'bus-heal liveness',
    }
    msgs.append({'from': 'team-lead', 'text': json.dumps(env), 'timestamp': ts, 'read': False})
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(msgs, open(p, 'w'), indent=2)
    print(rid)
PY
)"
[ -n "$REQ_ID" ] || fail "could not resolve or strand a specimen in $ALIAS_INBOX"
ok "stranded specimen: $REQ_ID (unread in Mercury-Implement.json)"

LEAD_BASELINE="$(python3 -c "import json;print(len(json.load(open('$LEAD_INBOX'))))" 2>/dev/null || echo 0)"
note "team-lead baseline: $LEAD_BASELINE message(s)"

# Boot an explicit scribe-engage daemon on a scratch project (real auth, real
# spawn — the Implementer answers from the scratch cwd; content mismatch with
# the stale task is EXPECTED and the lateness note tells it so).
# MERCURY_CONFIG_DIR is stamped EXPLICITLY (production condition: the mercury
# launcher exports it; a bare shell resolves ~/.claude and the daemon heals a
# DIFFERENT, empty teams dir — the first run of this script proved that).
mkdir -p "$SCRATCH/proj"
MERCURY_CONFIG_DIR="$CONFIG_HOME" \
MERCURY_DAEMON_SCRIBE_ENGAGE=1 MERCURY_PARTY=0 \
MERCURY_SCRIBE_DAEMON_PERSIST=1 \
node "$DIST" daemon "$SCRATCH/proj" >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!
note "daemon booting (pid $DAEMON_PID, log $DAEMON_LOG)"

for i in $(seq 1 30); do
  grep -q "Amanuensis Implementer spawned" "$DAEMON_LOG" 2>/dev/null && break
  kill -0 "$DAEMON_PID" 2>/dev/null || { tail -5 "$DAEMON_LOG"; fail "daemon died before Implementer spawn"; }
  sleep 1
done
grep -q "Amanuensis Implementer spawned" "$DAEMON_LOG" || { tail -5 "$DAEMON_LOG"; fail "Implementer never spawned (30s)"; }
ok "real Implementer spawned — $(grep 'Amanuensis Implementer spawned' "$DAEMON_LOG" | head -1 | sed 's/^\[daemon\] //')"

busstate() {
  python3 - "$ALIAS_INBOX" "$CANON_INBOX" "$REQ_ID" <<'PY'
import json, sys
alias, canon, rid = sys.argv[1], sys.argv[2], sys.argv[3]
def msgs(p):
    try: return json.load(open(p))
    except Exception: return []
alias_unread = sum(1 for m in msgs(alias) if not m.get('read'))
canon_rows = [m for m in msgs(canon) if rid in m.get('text', '')]
canon_has = len(canon_rows) > 0
canon_read = canon_has and all(m.get('read') for m in canon_rows)
print(f"{alias_unread} {int(canon_has)} {int(canon_read)}")
PY
}

# 1: HEAL — alias drained into the canonical inbox (fast; the first drain pass).
HEALED=0
for i in $(seq 1 30); do
  read -r A_UNREAD C_HAS C_READ <<<"$(busstate)"
  if [ "$A_UNREAD" = "0" ] && [ "$C_HAS" = "1" ]; then HEALED=1; break; fi
  sleep 1
done
[ "$HEALED" = "1" ] || fail "heal did not move the alias mail in 30s (alias_unread=$A_UNREAD canon_has=$C_HAS)"
ok "HEAL: alias inbox drained; canonical inbox holds $REQ_ID"

# 2: DELIVER — the canonical copy consumed (marked read after a successful
# stdin write). The opus child boots its full tool/MCP init before stdin
# accepts, and held dispatches retry ~1s — allow up to 120s.
DELIVERED=0
for i in $(seq 1 120); do
  read -r A_UNREAD C_HAS C_READ <<<"$(busstate)"
  if [ "$C_READ" = "1" ]; then DELIVERED=1; break; fi
  kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon died before delivery"
  sleep 1
done
[ "$DELIVERED" = "1" ] || fail "canonical dispatch never consumed (stdin delivery) in 120s"
ok "DELIVER: dispatch consumed by the real Implementer's stdin"
grep -q "bus heal: moved" "$DAEMON_LOG" && ok "daemon log confirms the heal ($(grep 'bus heal: moved' "$DAEMON_LOG" | head -1 | sed 's/^\[daemon\] //'))"

# 3: the billed leg — a real reply referencing the literal request_id.
note "waiting on the real opus reply (budget ${TIMEOUT_S}s — seats turn in minutes)"
GOT_REPLY=0
ELAPSED=0
while [ "$ELAPSED" -lt "$TIMEOUT_S" ]; do
  REPLY="$(python3 - "$LEAD_INBOX" "$LEAD_BASELINE" "$REQ_ID" <<'PY'
import json, sys
p, base, rid = sys.argv[1], int(sys.argv[2]), sys.argv[3]
try: msgs = json.load(open(p))
except Exception: msgs = []
for m in msgs[base:]:
    try: env = json.loads(m['text'])
    except Exception: continue
    if env.get('type') == 'scribe_protocol' and env.get('refRequestId') == rid:
        print(f"{env.get('kind')}|{env.get('from')}|{str(env.get('detail') or env.get('reason') or '')[:120]}")
        break
PY
)"
  if [ -n "$REPLY" ]; then GOT_REPLY=1; break; fi
  kill -0 "$DAEMON_PID" 2>/dev/null || fail "daemon died mid-wait"
  sleep 5; ELAPSED=$((ELAPSED + 5))
done
[ "$GOT_REPLY" = "1" ] || fail "no structured reply carrying refRequestId=$REQ_ID within ${TIMEOUT_S}s"
ok "REPLY: real envelope landed in team-lead.json → $REPLY"

cleanup
DAEMON_PID=""
echo
echo "✅ LIVE BUS-HEAL E2E GREEN — stranded alias dispatch healed, delivered to a real Implementer, structured reply round-tripped (ref $REQ_ID)"
