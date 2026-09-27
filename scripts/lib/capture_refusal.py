import sys


def capture_refusals(driver, ready_texts, ready_at, total, ended_at_tick,
                     end_reason, sends, sent, stable_need, require_stable,
                     seen, ready_seen_pre_sends=False):
    rows = []
    visible = "\n".join(line.rstrip() for line in seen.splitlines() if line.strip())
    if len(visible) > 800:
        visible = visible[:400] + "\n...\n" + visible[-400:]

    def add(code, detail):
        message = (
            "[%s] %s: never settled within the ceiling of %d ticks (%.1fs); "
            "ended=%s at tick %d; %s; saw=%r"
            % (driver, code, total, total * 0.2, end_reason,
               ended_at_tick, detail, visible))
        rows.append({"code": code, "message": message,
                     "ceilingTicks": total, "endedAtTick": ended_at_tick,
                     "endReason": end_reason, "seen": visible})

    if ready_texts and ready_at is None:
        detail = "readyText %r never appeared after all sends" % ready_texts
        if ready_seen_pre_sends:
            detail += "; end-gate trap: the ready needles WERE on screen before a send, never after"
        add("NEVER-READY", detail)
    if sent < len(sends):
        stuck = sends[sent]
        needle = (stuck.get("awaitText") or stuck.get("awaitRaw")
                  or stuck.get("awaitPattern") or stuck.get("targetText")
                  or stuck.get("data", ""))
        add("UNDELIVERED-SENDS", "%d of %d sends never became due; first stuck=%r mark=%r"
            % (len(sends) - sent, len(sends), needle, stuck.get("mark")))
    if require_stable and stable_need and end_reason != "stable":
        add("NEVER-STABLE", "the grid never held byte-identical for %d consecutive ticks"
            % stable_need)
    return rows


def emit_refusals(rows):
    for row in rows:
        line = row["message"] + "\n"
        sys.stderr.write(line)
        sys.stdout.write(line)
    sys.stdout.flush()
    sys.stderr.flush()
