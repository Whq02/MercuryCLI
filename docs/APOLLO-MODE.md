# Apollo Mode

Apollo Mode is Mercury's pre-flight interview mode: a session permission mode in which
the agent interviews you until the specification is complete, writes that specification down, and
then builds a prototype from it in one autonomous run. The goal is a runnable one-shot prototype: for a game, a playable demo with
UI/UX and example animations; for other software, the equivalent runnable slice, enough
for you to decide whether the idea is worth continuing.

## The mode

`apollo` is always available, directly after implement in the Shift+Tab carousel:

```
default → implement → apollo → flow → sovereign → default
```

Each step falls through when its mode is unavailable: from apollo the carousel
lands on flow when the live flow gate allows it, else on sovereign when bypass is
available on the context, else on default. Sovereign is available in every
interactive session unless settings or policy disable it; `mercury run` reaches
it only with `--sovereign` or `--allow-sovereign`.

Presentation: title "Apollo Mode", seal `◇`, its own tint. Apollo is never a
bypass posture: the interview's spec files are its only writes; every other
write is refused in the mode's own words.

Apollo works in the terminal and through the runner door; an ACP editor answers its interview through form elicitation. `mercury run` cannot answer an interview and does not offer Apollo.

## The appendix

The Apollo instructions join the system prompt only while the live mode is
`apollo`; any other mode's prompt is byte-identical. Two laws ride that
seam:

- a mid-session switch into Apollo takes effect at the next turn's prompt build;
- the interview drives the main agent only (crewmates never compose the appendix).

The appendix interpolates two values: the spec directory for the project root and the
poll budget.

## The interview (phase 1)

The appendix directs the agent to interview with the `AskUserQuestion` tool:

- Every poll is multiple choice with exactly four authored options. The harness letters
  them A–D and adds E automatically; E is where you type your own answer, and the
  appendix forbids authoring an "Other" option.
- One question per poll by default; up to four questions batch in one call only when
  they are independent.
- Questions are plain language and name the technical choice each settles; a
  technical term appears only beside its plain meaning.
- Between polls the agent spends a turn or two developing what the answers opened, then
  polls again.
- The poll budget is the `apollo.preflightQuestions` setting, default 7;
  the appendix says to use fewer when nothing blocks and never to pad to
  the budget.
- During this phase the agent writes and edits only the spec files.

The letter grammar is fixed: A–D for authored options, E as a stable
identity for the automatic free-text option (E stays E even when fewer than
four options were authored). The letters are display-only: answers,
drafts, and re-asked-question identity never carry a letter.

## The spec (phase 2)

The completed spec is written as readable files under
`<project>/.mercury/apollo/`, one derivation of that home shared by
everything that links the files. Whatever still blocks after the budget is
named in the spec, never guessed.

## The closing review

`ApolloReview` is the interview's exit tool. The
agent calls it with a plain-English summary of the completed spec, the blocker list (empty when
nothing blocks), the spec file paths, and a run note; the call renders the closing
review card.

Wrong-context calls are refused at validation, so the consent dialog can never appear
outside a main-session Apollo interview: a crewmate's context is refused, and a
session not in mode `apollo` is refused.

Permission behaviour splits on the blocker list:

- No blockers: the tool asks "Begin the prototype build?" and the card shows
  three answers. Either yes answer completes the mode transition out of Apollo; the two yes
  tiers differ in permission breadth:
  - **Yes — begin the build**: enters the build posture (flow when Flow is open,
    implement otherwise); edit consent follows the mode.
  - **Yes — but ask me before each edit**: moves the mode to default; the build runs
    and each edit asks for confirmation.
  - **No — ask me more questions**: keeps the session in Apollo Mode. The session and drafts are
    preserved, and the tool result tells the agent to resume the interview and
    present the review afresh.
  Esc holds the review as a rejection, and the agent waits for your word.
- Blockers present: the call is informational (allow); the card presents the blockers
  without changing the mode. The agent resolves them with you through more polls or
  discussion, then calls `ApolloReview` again.

`ApolloReview` is deferred like other deferrable tools in every permission mode; on routes
that defer tool schemas the agent loads it through `ToolSearch` when it is ready to close
the interview.

## The build (phase 3)

On a clean, approved review the tool moves the session per the chosen tier: the
build posture (flow when Flow is open, implement otherwise) on a
plain yes, default on ask-first. The transition runs through the same
guarded door the carousel and a host's mode switch use, so
entering flow sets dangerous allow rules aside exactly like a Shift+Tab
entry would. If flow raced unavailable between the check
and the set, the tool falls through to implement, which is always available; neither
default nor implement entry can be refused, so an approved review can never leave the
session stranded in Apollo Mode. The output records `buildStarted` and the settled
mode (`interviewContinues` when you asked for more questions instead).

The agent then builds the prototype in one autonomous run with the completed spec as the
brief, and finishes by telling you in plain terms what was built and how to run it.
