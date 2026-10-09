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
assert walk.next(["Boot face"], 0) is None
assert walk.next(["settings"], 100) is None
assert walk.next(["settings"], 500)[1]["step"] == 0
assert walk.next(["Boot face selected"], 600) is None
assert walk.next(["Boot face selected"], 1000)[1]["step"] == 1
assert walk.next(["Boot face selected"], 1400) is None
assert walk.next(["Boot face"], 1600) is None
assert walk.next(["Boot face"], 2000)[1]["step"] == 2
assert walk.next(["Boot face"], 2500) is None
assert len(walk.pending()) == 1
assert walk.next(["receipt"], 3000) is None
assert walk.next(["receipt"], 3400)[1]["step"] == 3
assert walk.pending() == []
print('[PASS] current-frame gates order all three Escs and require the receipt')
for rows in [["Alpha", "Beta"], ["Beta", "Alpha"]]:
    walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta"}])
    assert walk.next(rows, 0) is None
    payload, receipt = walk.next(rows, 400)
    y = rows.index("Beta") + 1
    assert payload == ("\x1b[<0;1;%dM\x1b[<0;1;%dm" % (y, y)).encode()
    assert receipt["screen"] == rows
walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta"}])
assert walk.next(["Beta", "Beta"], 0) is None
assert walk.next(["Beta", "Beta"], 500) is None
print('[PASS] row targeting follows words in either order and refuses ambiguous rows')
for names in [["Alpha", "Beta"], ["Beta", "Alpha"]]:
    rows = ["Alpha in chat | STATUS & TITLE", "              | " + names[0], "              | " + names[1], "              ╰────────", "              | Beta preview"]
    walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta", "targetHeader": "STATUS & TITLE"}])
    assert walk.next(rows, 0) is None
    payload, receipt = walk.next(rows, 400)
    y = names.index("Beta") + 2
    assert payload == ("\x1b[<0;17;%dM\x1b[<0;17;%dm" % (y, y)).encode()
print('[PASS] the row scan stays inside its named table, not the adjacent chat or preview')
walk = ObservedWalk([{"awaitText": "board", "targetText": "Beta", "arrivedText": ["beta body", "Type a prompt"], "arrivedAbsent": "board"}])
assert walk.next(["board beta body Type a prompt"], 0) is None
assert walk.next(["board beta body Type a prompt"], 400) is None
assert walk.next(["beta body Type a prompt"], 500) is None
assert walk.next(["beta body Type a prompt"], 900)[0] == b''
print('[PASS] an already-entered seat needs its body and chat frame, never a board preview')
walk = ObservedWalk([{"awaitText": "Beta", "targetText": "Beta", "settleMs": 0}, {"awaitText": "Beta", "targetText": "Beta"}])
assert walk.next(["Alpha", "Beta"], 0)[1]["step"] == 0
assert walk.next(["Alpha", "Beta"], 100) is None
assert walk.next(["Alpha", "Beta"], 499) is None
assert walk.next(["Alpha", "Beta"], 500)[1]["step"] == 1
print('[PASS] a step names its own stillness: settleMs 0 fires on the words alone, the default still waits 400 ms')
