# Apollo Mode

Apollo Mode is Mercury's pre-flight interview station: a session permission mode in which
the agent interviews the user until the missing spec exists, writes that spec down, and
then builds a prototype from it in one autonomous run. The stated goal is never a
finished product — it is a fully one-shot prototype: for a game, a playable demo with
UI/UX and example animations; for other software, the equivalent runnable slice, enough
for the user to decide whether the idea is worth continuing.

## The mode

`apollo` is a runtime permission mode. It joins the Shift+Tab carousel directly after
strategy — the two think-first stations sit together — and is always available:

```
default → implement → strategy → apollo → flow → sovereign → autopilot → default
```

Each step falls through when its mode is unavailable: from apollo the carousel
lands on flow when the live flow gate allows it, else on sovereign when bypass is
available on the context, else on default (autopilot sits in the cycle only while
it is armed).

Presentation: title "Apollo Mode", seal `∵`, its own tint — deliberately
distinct from strategy's in the band. Externally the mode projects as
`default`: Apollo is never a bypass posture.

Apollo is interactive-only. The headless control surface refuses
`set_permission_mode` to `apollo` in SDK/print mode — the interview needs a terminal UI.

## The appendix

The Apollo instructions join the system prompt only while the live mode is
`apollo`; any other mode's prompt is byte-identical. Two laws ride that
seam:

- a mid-session switch into Apollo takes effect at the next turn's prompt build;
- the interview drives the main agent only (subagents never compose the appendix).

The appendix interpolates two values: the spec directory for the project root and the
poll budget.

## The interview (phase 1)

The appendix directs the agent to interview with the `AskUserQuestion` tool:

- Every poll is multiple choice with exactly four authored options. The harness letters
  them A–D and adds E automatically; E is where the user types their own answer, and the
  appendix forbids authoring an "Other" option.
- One question per poll by default; up to four questions batch in one call only when
  they are independent.
- Questions are plain language, each tied to the technical choice it settles; a
  technical term appears only as a bridge beside its plain meaning.
- Between polls the agent spends a turn or two developing what the answers opened, then
  polls again.
- The poll budget is the `apollo.preflightQuestions` setting, default 7;
  the appendix says to use fewer when nothing blocks and never to pad to
  the budget.
- During this phase the agent writes and edits only the spec files.

The letter grammar is fixed: A–D for authored options, E as a stable
identity for the automatic free-text option (E stays E even when fewer than
four options were authored). The letters are display-only — answers,
drafts, and re-asked-question identity never carry a letter.

## The spec (phase 2)

The completed spec is written as readable files under
`<project>/.mercury/apollo/`, one derivation of that home shared by
everything that links the files. Whatever still blocks after the budget is
named in the spec, never guessed.

## The close — the review

`ApolloReview` is the interview's one exit seam. The
agent calls it with a layman summary of the completed spec, the blocker list (empty when
nothing blocks), the spec file paths, and a run note; the call renders the closing
review card.

Wrong-context calls are refused at validation, so the consent dialog can never appear
outside a main-session Apollo interview: an agent context (subagent) is refused, and a
session not in mode `apollo` is refused.

Permission behaviour splits on the blocker list:

- No blockers: the tool asks — "Begin the prototype build?" — and the card offers
  three answers. Every yes completes the mode transition out of Apollo; the two yes
  tiers differ in permission breadth only, never in whether the mode moves:
  - **Yes — begin the build**: the build posture (flow when the classifier gate
    allows it, implement otherwise); edit consent rides the mode.
  - **Yes — but ask me before each edit**: the mode moves to default; the build runs
    and each edit asks for confirmation.
  - **No — ask me more questions**: nothing moves. The session and drafts are
    preserved, and the tool result tells the agent to resume the interview and
    present the review afresh.
  Esc stays the plain hold: a rejection; the agent waits for the user's word.
- Blockers present: the call is informational (allow); the card presents the blockers
  and nothing changes hands. The agent resolves them with the user — more polls or
  discussion — then reviews again.

While the session is in Apollo Mode the `ApolloReview` schema is force-loaded on the
wire roster (never name-only behind tool search): the mode's entire exit funnels to
this one call, so it must not depend on a discovery round-trip.

## The build (phase 3)

On a clean, approved review the tool moves the session per the chosen tier: the
build posture (flow when the live classifier gate allows it, implement otherwise) on a
plain yes, default on ask-first. The transition runs through the same
guarded door the carousel and the SDK's `set_permission_mode` use, so
entering flow arms the classifier and strips dangerous
rules exactly like a Shift+Tab entry would. If flow raced unavailable between the check
and the set, the tool falls through to implement, which is always available; neither
default nor implement entry can be refused, so an approved review can never leave the
session stranded in Apollo Mode. The output records `buildStarted` and the settled
mode (`interviewContinues` when the user asked for more questions instead).

The agent then builds the prototype in one autonomous run with the completed spec as the
brief, and finishes by telling the user in plain terms what was built and how to run it.
