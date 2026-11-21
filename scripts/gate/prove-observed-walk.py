#!/usr/bin/env python3
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from observed_walk import ObservedWalk

walk = ObservedWalk([
    {"awaitText": "settings", "text": "\x1b"},
    {"awaitText": "Boot face", "text": "\x1b"},
    {"awaitText": "Boot face", "awaitAbsent": "selected", "text": "\x1b"},
    {"awaitText": "receipt", "text": ""},
])
r = walk.next(["Boot face"], 0)
assert r is None, f'scripts/lib/observed_walk.py step 0 fired before settings appeared: got {r!r}'
r = walk.next(["settings"], 100)
assert r is None, f'scripts/lib/observed_walk.py step 0 fired before settle window at 100ms: got {r!r}'
r = walk.next(["settings"], 500)
assert r[1]["step"] == 0, f'scripts/lib/observed_walk.py step 0 at 500ms expected step 0, got {r!r}'
r = walk.next(["Boot face selected"], 600)
assert r is None, f'scripts/lib/observed_walk.py step 1 fired before settle window at 600ms: got {r!r}'
r = walk.next(["Boot face selected"], 1000)
assert r[1]["step"] == 1, f'scripts/lib/observed_walk.py step 1 at 1000ms expected step 1, got {r!r}'
r = walk.next(["Boot face selected"], 1400)
assert r is None, f'scripts/lib/observed_walk.py step 2 fired while awaitAbsent="selected" remained: got {r!r}'
r = walk.next(["Boot face"], 1600)
assert r is None, f'scripts/lib/observed_walk.py step 2 fired before settle at 1600ms: got {r!r}'
r = walk.next(["Boot face"], 2000)
assert r[1]["step"] == 2, f'scripts/lib/observed_walk.py step 2 at 2000ms expected step 2, got {r!r}'
r = walk.next(["Boot face"], 2500)
assert r is None, f'scripts/lib/observed_walk.py step 3 fired before receipt appeared: got {r!r}'
pending_before = walk.pending()
assert len(pending_before) == 1, f'scripts/lib/observed_walk.py expected 1 pending receipt step, got {pending_before!r}'
r = walk.next(["receipt"], 3000)
assert r is None, f'scripts/lib/observed_walk.py receipt step fired before settle at 3000ms: got {r!r}'
r = walk.next(["receipt"], 3400)
assert r[1]["step"] == 3, f'scripts/lib/observed_walk.py receipt step at 3400ms expected step 3, got {r!r}'
pending_after = walk.pending()
assert pending_after == [], f'scripts/lib/observed_walk.py expected empty pending list after receipt, got {pending_after!r}'
print('[PASS] current-frame gates order all three Escs and require the receipt')
for rows in [["Alpha", "Beta"], ["Beta", "Alpha"]]:
    walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta"}])
    r = walk.next(rows, 0)
    assert r is None, f'scripts/lib/observed_walk.py row target fired at 0ms for {rows!r}: got {r!r}'
    payload, receipt = walk.next(rows, 400)
    y = rows.index("Beta") + 1
    expected_payload = ("\x1b[<0;1;%dM\x1b[<0;1;%dm" % (y, y)).encode()
    assert payload == expected_payload, f'scripts/lib/observed_walk.py row target payload={payload!r}, expected {expected_payload!r} for rows={rows!r}'
    assert receipt["screen"] == rows, f'scripts/lib/observed_walk.py receipt screen={receipt["screen"]!r}, expected {rows!r}'
walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta"}])
r = walk.next(["Beta", "Beta"], 0)
assert r is None, f'scripts/lib/observed_walk.py ambiguous rows fired at 0ms: got {r!r}'
r = walk.next(["Beta", "Beta"], 500)
assert r is None, f'scripts/lib/observed_walk.py ambiguous rows should stay refused at 500ms, got {r!r}'
print('[PASS] row targeting follows words in either order and refuses ambiguous rows')
for names in [["Alpha", "Beta"], ["Beta", "Alpha"]]:
    rows = ["Alpha in chat | STATUS & TITLE", "              | " + names[0], "              | " + names[1], "              ╰────────", "              | Beta preview"]
    walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta", "targetHeader": "STATUS & TITLE"}])
    r = walk.next(rows, 0)
    assert r is None, f'scripts/lib/observed_walk.py table target fired at 0ms for {names!r}: got {r!r}'
    payload, receipt = walk.next(rows, 400)
    y = names.index("Beta") + 2
    expected_payload = ("\x1b[<0;17;%dM\x1b[<0;17;%dm" % (y, y)).encode()
    assert payload == expected_payload, f'scripts/lib/observed_walk.py table target payload={payload!r}, expected {expected_payload!r} for {names!r}'
print('[PASS] the row scan stays inside its named table, not the adjacent chat or preview')
walk = ObservedWalk([{"awaitText": "board", "targetText": "Beta", "arrivedText": ["beta body", "Type a prompt"], "arrivedAbsent": "board"}])
r = walk.next(["board beta body Type a prompt"], 0)
assert r is None, f'scripts/lib/observed_walk.py arrivedAbsent="board" ignored at 0ms: got {r!r}'
r = walk.next(["board beta body Type a prompt"], 400)
assert r is None, f'scripts/lib/observed_walk.py arrivedAbsent="board" ignored at 400ms: got {r!r}'
r = walk.next(["beta body Type a prompt"], 500)
assert r is None, f'scripts/lib/observed_walk.py arrived frame fired before settle at 500ms: got {r!r}'
r = walk.next(["beta body Type a prompt"], 900)
assert r[0] == b'', f'scripts/lib/observed_walk.py already-entered seat expected empty bytes payload, got {r!r}'
print('[PASS] an already-entered seat needs its body and chat frame, never a board preview')
walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta", "settleMs": 0}, {"awaitText": "Beta", "targetText": "Beta"}])
r = walk.next(["Alpha", "Beta"], 0)
assert r[1]["step"] == 0, f'scripts/lib/observed_walk.py settleMs=0 step did not fire at 0ms: got {r!r}'
r = walk.next(["Alpha", "Beta"], 100)
assert r is None, f'scripts/lib/observed_walk.py default settleMs step fired early at 100ms: got {r!r}'
r = walk.next(["Alpha", "Beta"], 499)
assert r is None, f'scripts/lib/observed_walk.py default settleMs step fired early at 499ms: got {r!r}'
r = walk.next(["Alpha", "Beta"], 500)
assert r[1]["step"] == 1, f'scripts/lib/observed_walk.py default settleMs step expected step 1 at 500ms, got {r!r}'
print('[PASS] a step names its own stillness: settleMs 0 fires on the words alone, the default still waits 400 ms')
