---
name: app-proof
description: Prove a web application works by driving it — start the server under Mercury's Service tool, wait until it is genuinely ready, drive real pages with Mercury's Browser tool (open, click, type, waitFor, extract, screenshot), and record the verdict. Use when asked to test, verify, smoke-check, or reproduce a bug in a web app or API; not for unit tests of a single function.
when_to_use: After a frontend or API change lands, when a page "looks wrong", when a form or flow must be confirmed end to end, or when the user asks whether the app actually runs.
argument-hint: "<url or start command> [journey to check]"
---

# App proof

A claim that an app works is worth exactly the journey that was driven. Start
the real server, wait for real readiness, drive real pages, keep the evidence.

## 1. Run the server as a service

Use the `Service` tool for anything meant to stay up (dev servers, APIs, watch
builds); `Bash` is for finite commands. `Service start` returns a named
process with ordered logs; `Service wait` blocks on a readiness condition;
`Service logs` is the first thing to read when a page fails.

```bash
# Readiness is an HTTP answer, never a sleep:
node scripts/app_probe.mjs wait http://127.0.0.1:3000 --timeout-ms 60000
node scripts/app_probe.mjs page http://127.0.0.1:3000/login
```

`app_probe.mjs page` fetches a URL and reports status, title, form count,
link count, and the first error text it finds — enough to know whether to
open a browser at all.

## 2. Decide the journeys

List the two to five user paths the change touches as explicit steps with an
observable at each step ("submit → toast 'Saved' appears → row present in the
table"). A journey without an observable proves nothing. Cover:

- the happy path the change was made for;
- one failure path (bad input, missing permission, offline dependency);
- the page at a narrow width when layout changed.

## 3. Drive them

Mercury's `Browser` tool is the default driver for a journey: the engine is
bundled and already resolved — never hand-roll a headless-Chrome harness or
install a driver (`npm i puppeteer`, `npx playwright install`) for a one-off
journey. Read the page first, then act with the selector the tree hands you:

```
op:"open"       url:"http://127.0.0.1:3000/"
op:"extract"    mode:"tree"                            # rows print ready aria/ selectors
op:"type"       selector:"aria/Note[role=\"textbox\"]" text:"hello"
op:"click"      selector:"aria/Save[role=\"button\"]"  # auto-waits; covered/disabled refuse by name
op:"waitFor"    text:"Saved"                           # the observable — event-driven, bounded
op:"screenshot" label:"saves-a-note"                   # the evidence artifact
```

Acts auto-wait (present AND visible, bounded — a late-rendered element needs
no pause), `waitFor` defaults to visible and `state:"hidden"` waits a spinner
away, and a failure names its deadline or its occluder — read it before
retrying. `op:"console"` is the first read when a page misbehaves.

Playwright stays the right driver for the named cases the Browser tool
defers: a repo that already carries a committed Playwright suite (extend it
there), journeys needing multiple tabs or windows, file uploads, per-frame
(iframe) acts, and credentialed sign-in flows — Mercury refuses to type into
credential fields by design. Only for those: `npm i -D @playwright/test` and
`npx playwright install chromium` in the target repo.

For APIs, drive the endpoints with `fetch` in a test or `curl` in Bash, and
assert status, shape, and one negative case.

## 4. Record the verdict

- Run the journeys through the `Test` tool when a framework is configured so
  the result is a structured record, not a parsed terminal screen.
- Keep screenshots of failure states beside the report; name them by journey.
- Report what was driven, what passed, what failed with the exact observable
  that did not appear, and what was not covered. Never widen a narrow proof
  into "the app works".

## Common traps

- Asserting on a sleep instead of readiness; on text that appears before the
  data loads; on selectors tied to CSS classes that styling changes.
- Testing against a stale build: restart the service after a rebuild and
  confirm the version or a known change is visible.
- A green run on a machine where the browser never launched: check the
  reporter counted the expected number of tests.
