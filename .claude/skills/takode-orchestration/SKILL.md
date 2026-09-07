---
name: takode-orchestration
description: "Cross-session orchestration for Takode. Use when you need to interact with other sessions: listing active sessions, peeking at session activity, reading messages, sending instructions to workers, or spawning new sessions. Triggers: 'check on workers', 'send to session', 'orchestrate', 'coordinate agents', 'list sessions', 'peek at session', 'what are my sessions doing', 'check session status'."
---

# Takode -- Cross-Session CLI Reference

The `takode` CLI lets you interact with other sessions managed by the Companion server. Read-only commands work for all sessions. Mutation commands (send, rename, herd, spawn, interrupt) require the orchestrator role (`TAKODE_ROLE=orchestrator` env var).

## Environment

- `TAKODE_API_PORT` -- the Companion server port (used automatically by the CLI)
- `COMPANION_SESSION_ID` -- your own session ID
- The `takode` command is available at `~/.companion/bin/takode` (or on PATH)
- Works with both **Claude Code** and **Codex** sessions

## Sub-Skill Workflows

Read these files or invoke these skills when performing the corresponding operation:

| Workflow | When to use | Source |
|----------|------------|--------|
| **Dispatching work** | Before choosing a worker, sending a quest, or deciding a tiny follow-up qualifies as a direct worker errand | Invoke `/leader-dispatch` |
| **Quest Journey** | Advancing a quest through Quest Journey v2, including Work autonomy, checkpoint pause/resume, worker-owned Work -> Memory, final Memory, and migration behavior | [quest-journey.md](quest-journey.md) |
| **Work board** | Managing the quest board | [board-usage.md](board-usage.md) |

## Key Principles

- **Quests are the unit of work.** Create a quest for any non-trivial task before dispatching. A direct worker errand is a narrow exception for one-turn, context-rich, read-only follow-ups; it is not a Quest Journey state.
- **Never implement non-trivial changes yourself.** Leaders brainstorm, create quests, dispatch, steer, and review -- they do not write code. Investigation and research are also work to delegate.
- **Never run `quest claim` yourself.** Workers claim quests when dispatched. Leaders coordinate, workers claim.
- **Keep Work ownership explicit.** The worker doing the job claims the quest, owns technical Work, and performs the guarded Work -> Memory transition with synchronized selected-target code SHAs or explicit zero-code evidence. The leader owns user intent and corrections, approved scope/Journey, entry into Work, checkpoint state, and genuine Journey revisions; the leader does not become the technical Work owner or attach missing Work code SHAs during Memory.
- **Use `/quest-design` before quest creation/refinement.** Before creating a quest or refining an `idea` quest into worker-ready scope, invoke `/quest-design` to preserve quest text discipline. User confirmation is conditional: direct create/dispatch is allowed only through `/leader-dispatch`'s low-risk reversible rubric. Otherwise, when the user clearly wants a quest created and dispatched, combine quest-design with `/leader-dispatch`: prepare a concise approval packet with `Proposed Quest`, `Goal / Acceptance`, `Journey`, `Scheduling`, and only optional sections that the user needs to approve, correct, or choose. If you use a proposed board row, put that packet in the mandatory `takode board propose --summary` payload and do not repeat it as separate chat prose; the proposal UI renders the summary and Journey. If you are not using a proposed row, keep the visible chat proposal TLDR-like rather than pasting a worker-facing quest body or form. Keep the quest record intent-first and self-contained: preserve the requested outcome, user-supplied, confirmed, or mandatory constraints, and useful evidence or context a worker could not reasonably recover; leave unconfirmed leader ideas and detailed planning to Work. Quest-design-only variants should omit dispatch sections; dispatch-only variants should reference the existing quest instead of duplicating its accepted scope. Routine feedback, claims, completion, verification checks, board updates, and already-approved lifecycle transitions do not need another round.
- **Before dispatching any quest or direct worker errand, *ALWAYS* invoke `/leader-dispatch`.** It owns worker selection, direct errand eligibility, the direct-dispatch versus approval decision, durable board recording for quest-backed work, and the alignment-only dispatch template. Direct create/dispatch is allowed only for clear, low-risk, reversible repo-local work with no material ambiguity, irreversible/destructive operation, external side effect, security/privacy/global/shared-resource risk, product/policy choice, or user-level scheduling tradeoff. Direct worker errands are narrower: one-turn, context-rich, read-only drafts/lookups/translations/formatting/explanations/clarifications with no mutation, validation, external action, durable artifact, review, checkpoint, or handoff. Pre-dispatch approval remains mandatory for ambiguous, destructive, irreversible, externally consequential, expensive/long-running, global/shared-resource, security/privacy, product/policy, or user-visible tradeoff work. Use delayed approval via User Checkpoint when Work can safely start but a later decision needs user confirmation. Write the authorized Journey to the board before or with dispatch for quest-backed work. Do not mirror the full quest body, extra context, file paths, or investigation instructions into chat or the dispatch message. Put useful source pointers or hard-to-recover context in the quest, but do not pre-solve Work in the dispatch.
- **Verify promised durable actions before Ready.** After you say you will create, refine, dispatch, or advance a quest, complete and verify the durable record in that same turn: exact quest ID, board row, needs-input notification, worker send/phase dispatch, Port/push, or other external record as applicable. If the durable action is not complete, mark the thread Waiting or incomplete with what remains instead of Ready. Avoid broad mixed context dumps as the final step before setup; prefer compact targeted checks and perform the durable action once the user request is clear.
- **Persist true follow-up relationships.** When creating or refining a quest that is a true follow-up, bug fix, successor, redesign, or user-approved next quest from prior findings, include `Relationship: follow-up of [q-N](quest:q-N)` in the approval surface and persist it with `quest create ... --follow-up-of q-N` or `quest edit q-M --follow-up-of q-N`. Leave incidental mentions to auto-detected backlinks.
- **Do not split one design-and-build outcome at its checkpoint.** When accepted scope includes both, the visible checkpoint must identify same-quest implementation, design-only closure, or a separate implementation successor. If same-quest routing expands a previously design-only current quest, reconcile a design-only title and any stale description/TLDR before Work resumes; final Memory is only the backstop. Return the current quest to its assigned worker in Work after the decision: same-quest routing continues implementation, while design-only or successor routing closes the current accepted scope before Memory. Apply the complete routing rules in [quest-journey.md](quest-journey.md) and the current phase briefs.
- **Verify delivery before saying a feature is implemented, available, or ready to test.** Apply the delivery-evidence checklist in [quest-journey.md](quest-journey.md). A design selection, design-only Memory record, probe run, or generic tool output is not delivery evidence; if the checklist is not satisfied, say the feature is not delivered before attempting a test.
- **Events are push-based.** Herd events arrive as `[Herd]` user messages when idle. No polling.
- **Reference rather than duplicating.** In dispatch and phase handoffs, point to source messages instead of copying long bodies. The quest record still needs a concise local summary so it remains self-contained.
- **Workers have the same tools you do.** Give them the quest ID; they run `quest show` themselves.
- **Use direct worker errands only for tiny context-rich follow-ups.** They create no quest, board row, claim, phase note, Memory closure, completion metadata, or new lifecycle. The leader sends the exact request/source to the responsible worker and relies on ordinary session/thread history for audit. If scope expands to investigation, implementation, validation, mutation, durable state, ambiguity resolution, multiple turns, external consequences, review, or a durable handoff, fail closed and promote to a normal quest/Journey.
- **Route read-only implementation follow-ups to context-rich sources.** For active or recently completed quests, prefer a short Takode follow-up to the responsible worker or accepted Work/Memory evidence before reopening source yourself. Answer directly when the fact is already explicit in accepted durable notes, the worker is unavailable or lacks relevant context, the question is leader-owned intent/coordination/authority, urgency makes consultation impractical, or consultation would add latency without a context advantage. Do not create a quest or authorize changes for a clarification unless the user asks for new investigation, implementation, validation, or external action.
- **One task at a time per worker.** Mid-task steering is fine; unrelated new tasks queue.
- **User feedback triggers full rework when it changes accepted quest work.** When a user reports issues with a completed quest, asks for a fix/change, or adds substantive new work, record feedback, set the quest back to `refined`, and dispatch for a full quest journey. Never skip review steps for "small" fixes. New human feedback becomes the source of truth for that quest: reset the board to the earliest valid phase for the fresh cycle and do not let stale in-flight review/port completions from the older scope keep advancing it. A bounded draft/lookup/explanation errand about accepted work may stay outside Questmaster only when it passes the direct worker errand checklist. See [quest-journey.md](quest-journey.md).
- **Same-thread feedback usually belongs, but verify exceptions.** Treat the current quest thread as strong context, not absolute proof of scope. If a user message in a quest thread appears to describe a separate feature, cross-cutting redesign, or unrelated issue, propose a new quest/Journey and attach the relevant discussion there instead of mutating the current quest until the user confirms. If that separate quest is a true successor to the current quest, propose it as an explicit follow-up and persist the relationship after approval.
- **Don't echo board state as prose.** `takode board` commands display the board in the terminal with a special UI, and the user already sees the live board state in the Takode Chat UI. Never repeat current board rows as markdown tables or summaries -- just run the command and move on unless the user explicitly asks for a text summary.
- **Use quest threads as shared state.** Main is the staging area for unthreaded/global work. Quest-backed threads carry quest-specific activity, and All Threads/global inspection preserves the append-only audit stream.
- **Remind at quest setup points.** After successful quest creation, refinement, or dispatch, include a non-blocking reminder to attach clearly quest-specific prior Main discussion to `[q-N](quest:q-N)` with `takode thread attach`.
- **Apply `leader-decision-communication` before user-facing decisions or material status updates.** That focused skill owns decision-first plain language and the necessity filter; this skill keeps CLI, notification, routing, and approval mechanics.
- **Externally consequential User Checkpoints require fresh explicit approval.** A material edit alone is not approval. One fresh reply may make one exact substitution and explicitly approve the resulting packet only when its referent, every unchanged term, dependent parameters, monitor/stop conditions, safety implications, consequences, and tradeoffs remain unchanged and unambiguous, with no question or user choice left. Otherwise fail closed, republish the exact packet, keep the board in `USER_CHECKPOINTING`, and obtain fresh explicit approval before external consequences. Harmless typo-only corrections can still proceed when the exact action was explicitly approved and no ambiguity remains.
- **Checkpoint shortcuts require visible option explanations.** Before offering User Checkpoint shortcuts, publish a visible decision section that names every shortcut and explains its meaning plus relevant tradeoff. Phase notes, private packets, notification summaries, labels/buttons, and "see feedback" references do not substitute. Equivalent/no-tradeoff options should say so or be collapsed; yes/no prompts must state what yes authorizes and what no declines; multiple independent questions need matching `--question` groups; custom answers to exact packets are edits/new alternatives; revised packets need a fresh visible section and fresh notification.
- **Preserve Work after taken checkpoints.** User Checkpoints are required by default. A direct approved optional `[work,user-checkpoint,memory]` suffix may skip only through guarded `work-to-memory ... --skip-optional-checkpoint <reason>` after Work proves the concrete condition; the reason is recorded. Required or taken checkpoints must resume into later Work before Memory, so revise the suffix before checkpoint entry when needed. Generic `board advance` may reach later Work in repeated plans but must not skip directly into Memory.
- **Use the v2 active phase plan for every quest.** The active Quest Journey is `alignment -> work -> memory`, represented on the board as `PLANNING -> WORKING -> MEMORY`, with `USER_CHECKPOINTING` as a durable pause over the same Work occurrence. Alignment is a concise leader-verification read-in, not a planning report. Work owns investigation, implementation, self-review, approved execution, validation, sync/push duties when authorized, iterative rework, and attaching synchronized target code SHAs or explicit zero-code evidence before Memory. Final Memory owns non-project-tracked durable closure, separate memory-repository commit metadata, and completion; it does not first-attach Work code SHAs. Direct worker errands are not quests and do not add a phase/state. Legacy v1 phase IDs such as `implement`, `code-review`, `execute`, `outcome-review`, `port`, and `bookkeeping` are historical-read only and cannot be dispatched for new active rows.
- **Use separate review quests when needed.** Embedded review phases are not part of v2. If independent judgment materially reduces risk, create or dispatch a separate review quest with its own Alignment -> Work -> Memory flow and point it at the accepted Work note, target diff/commit range, and evidence to judge.
- **Report accepted Work before Memory closure.** When the guarded Work transition reaches `MEMORY`, first confirm tracked Work commits are already visible as structured quest metadata, then promptly publish the main accepted answer, finding, or outcome from the Work note. This accepted-Work response normally carries the substantive user-facing answer: the useful explanation, findings, uncertainty, recommendation, and next action. Then send final Memory to the normal same worker without waiting for closure. Keep the quest technically open in Memory, but treat it as downstream-unblocking unless a dependent explicitly needs a Memory-produced output. Missing code evidence returns to Work; Memory may add only separate memory-repository commits. Ordinary read-only follow-ups during Memory use accepted evidence and do not reopen the quest; substantive new work follows the normal rework lifecycle.
- **Final Memory is mandatory.** Every completed non-cancelled quest must have final Memory closure, final User review check settlement, a final debrief, a debrief TLDR, and quest metadata reconciliation so the title, TLDR, and description still match the accepted delivered scope. A quest in `MEMORY` is downstream-unblocking because substantive work is accepted and synced when applicable, but completion is incomplete until Memory settles durable state, User review checks, metadata reconciliation, and the memory statement.
- **Final Memory closure is commentary by default.** Completing Memory does not by itself justify another answer to the same IDs. Report routine durable closure with `[thread:q-N:C]`; do not repeat or compress the accepted-Work answer merely because the quest became done. Use another `:A:<ids>` answer only when Memory produced new user-relevant information that materially completes, corrects, or changes the prior response, and make that answer complementary to every earlier visible answer for those IDs. If quiz metadata exists or was updated, keep `{[(Quest Quiz: q-N)]}` out of answer prose and emit it as a separate `[thread:q-N:C]` assistant directive before any Thread Ready marker.
- **Route every visible leader message with a compact destination-and-role marker.** Use `[thread:main:C]` or `[thread:q-N:C]` for commentary. Use `[thread:main:A:u1]` or `[thread:q-N:A:u1,u2]` for a polished answer, listing the exact earlier session-scoped user-message IDs it covers. The marker is stripped from rendering and becomes server-authored route and role metadata. If one assistant output intentionally covers multiple thread tabs or roles, keep the first marker on the first line, then put a standalone `---` line immediately before each later role-bearing marker. Shell/terminal commands remain commentary and use `# thread:main` or `# thread:q-N` as their first non-empty line.
- **Use commentary and answer roles deliberately.** Commentary is chronological coordination or process detail: quest creation or refinement, approval, dispatch, Alignment, progress, status, recovery, verification, bookkeeping, waiting, User Checkpoints, and asynchronous Memory work. When the user requested a delivered implementation and implementation is still owed, creation, approval, dispatch, Alignment, and ordinary progress are commentary; they are answers only when setup or dispatch itself fully satisfies the request. Commentary cannot satisfy answer coverage. Prefer one self-contained explicit answer per user request or intentionally grouped request set. Before emitting `:A:<ids>`, retrieve or reread every listed user message and inspect every earlier visible valid answer covering any listed ID. Judge each prompt-and-answer pairing as a fresh reader: the prose must directly and adequately answer every covered request without relying on hidden history. For substantial answers, apply `explain-clearly`; lead with the answer, remain natural and self-contained, preserve material reasoning and uncertainty, and omit lifecycle detail unless it matters to the user.
- **Answer coverage authority and presentation are separate.** Every direct user message delivered to a leader has a source-envelope ID such as `u17`. A valid `:A:<ids>` answer covers only the listed earlier IDs after server validation. A later valid answer becomes current coverage authority for repeated IDs, while collapsed presentation and append-only history retain every valid answer row in source chronology. Repeat IDs only when genuinely useful information requires a complementary addition, correction, or material completion. Because collapsed presentation shows the complete answer set together, avoid repeating earlier substance; do not merely restate, compress, or administratively recap it. If an otherwise-valid answer names a thread already server-proven visibility-associated with every covered prompt instead of the single authoritative owner shared by every covered ID, Takode preserves the original append-only response row and selected-thread visibility while automatically canonicalizing coverage, supersession, pending state, and Ready authority to that owner. It does not require the leader to regenerate the prose. Unknown or invalid IDs, stale or reassigned ownership, ownerless or mixed-owner sets, incomplete associations, disallowed Main backfills, or route-control conflicts remain non-answers and receive a precise actionable diagnostic rather than guessed routing. Thread Ready remains separate and is rejected until all currently thread-owned direct user IDs have valid current coverage.
- **Never use `AskUserQuestion` or `EnterPlanMode`.** These block your turn and prevent herd event processing. Publish a blocking clarification or decision surface as `[thread:main:C]` or `[thread:q-N:C]` unless it is genuinely the finished direct answer, then call `takode notify needs-input` so the user never misses it. Do not duplicate the same prose. Include suggested replies under the notification rule below; for multiple independent questions, use `--question <prompt>` with each question's `--suggest <answer>` flags immediately after it.
- **Use `takode notify` at these moments:** `needs-input` every time you ask the user a question or need a decision before work can continue; first publish the detailed role-bearing routed question, normally as commentary, then call `takode notify needs-input` with a short summary. The visible thread text is the decision surface and must contain the complete decision context needed to answer; notification summaries, notification UI options, and `--suggest` choices are only attention/reply affordances. The visible text must name every shortcut and explain its meaning plus relevant tradeoff before notify runs. Any user wait must use `takode notify needs-input`; never represent it only with Thread Waiting or `takode notify waiting`. New blocking prompt -> new notification: existing unresolved prompts do not cover a separate approval or decision. Link the affected active board row with `--wait-for-input` when applicable. Scoped-wait rule: a pending `needs-input` blocks only its owning thread, quest, or board row; keep that affected scope paused, continue unrelated quests and herd events, and make it broader only when the visible prompt explicitly concerns global orchestration, worker-slot scheduling, shared resource safety, or another cross-quest dependency. If the user chooses to park one prompt and work elsewhere, comply unless that other work depends on the unresolved decision or the broader-blocker exception applies. Include suggested replies under the notification rule below; use `--question <prompt>` when one notification needs multiple independent answers. Use `review` only for significant non-quest deliverables that are ready for the user's eyes, not for quest completion. Use `waiting` only when a marked leader thread, quest, or board row is intentionally parked on non-user work such as a herd event, timer, resource lease, worker, reviewer, or queued dependency; it is transient status, not user attention, so it does not create notification IDs, chip counts, or resolver work.
- **Prefer plain-text inspection by default.** When using `takode info`, `takode peek`, `takode scan`, or `quest show` to read for judgment, scanability, or general situational awareness, use the normal plain-text output first. It is usually more token-efficient and easier to reason about than `--json`.
- **Use `--json` only when exact machine fields matter.** Reach for JSON when you need precise structured data such as feedback `addressed` flags, `commitShas`, version-local quest metadata from `quest history`, exact IDs, or machine-oriented filtering/branching. Compact JSON omits bulky fields by default; use `--details`, `--include <field>`, or a dedicated detail command only when those fields are truly needed.

## Herd Events

Events from herded sessions are delivered automatically as `[Herd]` user messages when you go idle. No polling needed.

### Message Source Tags

- **`[User HH:MM id:uN]`** -- human operator; `uN` is the stable session-scoped ID used by answer markers and `takode read <leader-session> uN`
- **`[Herd HH:MM]`** -- automatic event summary from herded sessions
- **`[Agent #N name HH:MM]`** -- forwarded from another agent/session

### Event Types and Reactions

| Event | Meaning | Action |
|-------|---------|--------|
| `turn_end (✓)` | Worker completed successfully | Peek at output and inspect the board phase. If Work just entered `MEMORY`, confirm tracked Work commits are already structured quest metadata, report the accepted Work outcome, and send final Memory without waiting for closure; missing code evidence returns to Work. In `PLANNING`, this may contain a plain-text alignment read-in that should be reviewed and answered with normal `takode send` rather than `takode answer` |
| `turn_end (✗)` | Worker hit an error | Diagnose the issue, send recovery instructions |
| `turn_end (⊘)` | Worker was interrupted by a user, leader, or system | Check whether it is terminal; system or `recovery pending` cases may still recover |
| `permission_request` | Worker needs approval | For `AskUserQuestion`/`ExitPlanMode`, answer with `takode answer`. **Tool permissions are human-only.** If `(user-initiated)`, don't answer -- the user is handling it |
| `permission_resolved` | Worker was unblocked | No action needed |
| `session_error` | Session-level error | Investigate, decide whether to retry |
| `user_message [User]` | Human sent directly to worker | May indicate new instructions -- stay aware but don't interfere |

### Lifecycle Label Legend

Herd headers keep their stable event type and add short text when a boundary could otherwise resemble a restart:

- **`waiting for decision; Work preserved`** -- the worker reached a normal approval/input pause; its session and completed Work are intact.
- **`decision resolved; wait ended`** -- an approval or input gate was answered; the later turn boundary confirms whether Work actually resumed.
- **`same Work resumed after decision wait`** -- the first later user/leader turn continued that worker on the same route; this is continuation, not recovery.
- **`context compacted; same Work continued`** -- the backend performed context maintenance inside the same session; this is not a disconnect or process restart.
- **`session disconnected while idle`** -- the backend disconnected without interrupting active Work.
- **`Work interrupted` / `Work failed`** -- a genuine interruption or error boundary; inspect the attached recovery/error detail before steering.
- **`✓` / `✗` / `⊘`** -- secondary shorthand for a normal completed, failed, or interrupted turn. Trust the textual lifecycle label when one is present.

## Session Lifecycle

Three distinct operations -- never confuse them:

| Command | What it does | Session after |
|---------|-------------|---------------|
| `takode interrupt <N>` | Halts the worker's current turn (SIGTERM) | Active, idle, ready for new work |
| `takode archive <N>` | Removes session from active herd | Archived, history still readable |
| Disconnect (idle manager) | CLI process killed automatically | Disconnected (`✗`), auto-relaunches on `takode send` |

**Key rule:** When you interrupt a worker, say "interrupted" -- never "archived" or "stopped".

## Maintaining Focus

- **Respect scoped waits during herd events.** Keep the affected thread, quest, or board row waiting even if herd events arrive, but continue unrelated orchestration. Only safety/global/worker-slot/shared-resource/cross-quest prompts broaden the wait; a user-parked prompt should not block unrelated work.
- **System-interrupted worker events can be provisional.** If a `turn_end (⊘)` event says `recovery pending`, or the worker still appears connected/generating after a stuck-watchdog interruption, inspect `takode info`/`takode peek`/`takode scan` once, then apply the canonical Work leader brief at `~/.companion/quest-journey-phases/work/leader.md` before steering. That brief owns the complete recovery rule.
- **When the user is directly steering a herded worker**: stay out of it. Resume normal coordination once the user stops interacting.
- **After context compaction, refresh state.** Run `takode list` to see your herd with each worker's recent task history before making dispatch decisions.

## Leader Thread Routing

- **Commentary:** start visible operational or in-progress text with `[thread:main:C]` or `[thread:q-N:C]`. Quest creation or refinement, approval, dispatch, Alignment, progress, status, recovery, verification, and bookkeeping remain commentary while requested implementation is still owed; they may be answers only when setup or dispatch itself completes the request. Commentary remains in expanded chronology and cannot satisfy answer coverage.
- **Answer:** start polished self-contained prose with `[thread:main:A:u1]` or `[thread:q-N:A:u1,u2]`, listing every earlier user-message ID that prose answers. Prefer one self-contained answer per request or intentionally grouped request set. Follow the answer-quality rule above: reread every listed message and earlier visible same-ID answer first, apply `explain-clearly` for substantial answers, and repeat IDs only for genuinely useful complementary or corrective information without restating the visible answer set.
- **Safe owner correction:** when a route mismatch is the only defect, all covered IDs share one proven owner, and the selected thread already has a server-proven visibility association with every prompt, Takode keeps the same response row and selected-thread visibility but canonicalizes answer authority to the owner. Ambiguous or unproven cases fail closed with an actionable diagnostic; do not regenerate the long answer merely to correct its marker.
- **Coverage and Ready:** a later answer becomes current coverage authority only for IDs it repeats; all valid answers remain chronologically visible. Canonicalized coverage, supersession, pending state, and Ready authority belong only to the proven owner thread. New or reassigned user messages remain pending until explicitly answered. Thread Ready requires complete current ownership-aware coverage and rejects invalid attempts with a concise ID reminder.
- **Multiple routed sections:** keep the first compact marker on the first line, then put a standalone `---` line immediately before each later role-bearing marker. The divider and marker must begin their physical lines.
- **Shell commands:** use `# thread:main` or `# thread:q-N` as the first non-empty command line. Shell commands are commentary; they do not publish an answer.

## User Notifications

Tie `takode notify` calls to Quest Journey phase events:
- **`takode notify needs-input "need decision on auth approach for q-42" --suggest yes --suggest no`**: every time you ask the user a question or need a decision before work can continue. Apply `leader-decision-communication`, publish the detailed question first with the appropriate role-bearing marker—normally `[thread:main:C]` or `[thread:q-N:C]` while awaiting the answer—then call `takode notify needs-input` with a short summary so the user never misses it. The detailed visible response must be self-contained enough to answer; include suggested replies under the notification rule below while preserving complete in-thread decision context. Scope the wait to the affected thread, quest, or board row unless the question says it is global/safety/resource/cross-quest. For multiple independent questions, use `takode notify needs-input "need decisions" --question "Which worker?" --suggest reuse --suggest spawn --question "Run browser validation?" --suggest yes --suggest no`.
- **`{[(Thread Waiting: q-42 | waiting on reviewer pass)]}`**: put this strict standalone marker line in a leader assistant response when a marked leader thread is parked on a herd event, timer, lease, worker, reviewer, or queued dependency. Use it only for non-user waits; user waits require `takode notify needs-input`. Use `{[(Thread Ready: q-42 | ready for review)]}` when the thread is complete or ready. Put the marker on its own physical line as plain text, not in a code block, quote, bullet, or surrounding prose. This marker only updates thread status; it never routes the enclosing message or attached UI. Use a role-bearing `[thread:main:C]` / `[thread:q-N:C]` commentary prefix or `[thread:main:A:u1]` / `[thread:q-N:A:u1,u2]` answer prefix for message routing, or the standalone `---` plus immediate role-bearing marker split syntax for intentional multi-tab responses. Do not use inline markers for user questions.
- **Do not call `takode notify review` for quest completion**: when a work board item is completed, Takode already fires the review notification automatically. Sending another one creates duplicate quest-completion notifications.

Do not notify for routine progress or intermediate steps.

## Read-Only Commands

These commands work for any session.

### `takode list [--herd] [--active] [--all] [--json]`

List sessions. Default shows all unarchived sessions. Use `--herd` (or just `takode list` as leader) to see only your herded sessions. Use `--all` to include archived.

```bash
takode list          # leader default: herded sessions only
takode list --herd   # explicit: herded sessions only
takode list --active # all unarchived sessions
takode list --all    # include archived
```

Output shows: `#N` session number, status icon, name, role labels, quest status, branch info, last activity.

When referencing a session in chat, use `[#N](session:N)` (example: `[#5](session:5)`).

### `takode search <query> [--all] [--json]`

Search sessions by name, keyword, task title, branch, message, or path.

```bash
takode search auth
takode search jwt --all
```

### `takode info <session> [--json] [--details | --include <fields>]`

Show detailed session metadata: identity, backend, working directory, git state, worktree info, quest claim, metrics, and timestamps.

```bash
takode info 1
takode info 1 --json
takode info 1 --json --include injectedSystemPrompt
```

Human-readable output shows a structured overview with sections for identity (UUID, CLI session ID, PID), backend (type, model, version, permissions), working directory, git state (branch, ahead/behind, diff stats), roles, quest claim, metrics (turns, cost, context usage), MCP servers, and timestamps.

Prefer plain-text for normal inspection. Use compact `--json` only when you need exact structured fields for a programmatic decision. Use `--details` or `--include <field>` for opt-in bulky fields such as `injectedSystemPrompt`, task history, tools, MCP servers, or keywords.

### `takode tasks <session> [--json]`

Show the task outline (table of contents) for a session's conversation history.

```bash
takode tasks 1
```

**Tip:** Run `takode tasks` first when investigating an unfamiliar session -- it gives you a high-level map of what the agent has been working on.

### `takode scan <session> [--from N] [--until N] [--count N] [--json]`

Scan session turns as collapsed summaries. Like a table of contents for the conversation -- shows each turn's trigger (user/herd message), assistant response, message range, duration, and tool count. Scans backward from the end by default (most recent turns first). Paginated by turn number (default: 50 turns per page).

```bash
takode scan 1                       # last 50 turns (most recent)
takode scan 1 --from 0              # turns 0-49 (from the beginning)
takode scan 1 --until 100           # 50 turns ending before turn 100 (turns 50-99)
takode scan 1 --from 50 --count 20  # turns 50-69
```

Each turn shows the trigger message and the assistant's response. Compaction events appear as markers between turns:
```
Turn 42 · [821]-[827] · 18:17-18:17 (15s) · 2 tools · ✓
  user: "check how #89 is doing"
  ...
  asst: "#89 has been idle since 2:02 PM..."
── Context compacted [828] (auto) ──
Turn 43 · [829]-[835] · 18:18-18:19 (45s) · 3 tools · ✓
  user: "run the tests"
  ...
  asst: "All 142 tests passed."
```

Use this to quickly understand what a session worked on across its entire history without reading every message. Drill into interesting turns with `takode peek <session> --turn <N>`.
Prefer the plain-text scan output for this triage workflow; it is optimized for human reading. Use `--json` only if you truly need to branch on structured turn fields.

### `takode peek <session> [--from N] [--until N] [--count N] [--turn N] [--task N] [--detail --turns N] [--json]`

View session activity with progressive detail.

**Default mode** (smart overview) -- shows collapsed recent turns + expanded last turn:
```bash
takode peek 1
```
Collapsed turns include message ranges like `Turn 5 · [42]-[58] · 14:22-14:25 (3s) · ✓ "Done"`, so you can quickly identify which messages belong to which turn.

**Expand a specific turn** -- shows all messages in turn N (0-indexed):
```bash
takode peek 1 --turn 5
```
Use this when you see an interesting collapsed turn and want its full messages without guessing message IDs.

**Range browsing** (paged history by message index):
```bash
takode peek 1 --from 500
takode peek 1 --from 500 --count 50
takode peek 1 --until 500
```

**Task browsing** -- expand messages for a specific task number:
```bash
takode peek 1 --task 3
```

**Detail mode** -- legacy full-detail view of the last N turns:
```bash
takode peek 1 --detail --turns 3
```

#### Navigation Workflow

```
1. takode info 1                          → Session metadata: backend, git, quest, metrics
2. takode tasks 1                         → Table of contents: tasks with msg ranges
3. takode scan 1                          → Turn-level scan (most recent first)
4. takode scan 1 --from 0                 → Scan from the beginning
5. takode peek 1                          → Overview: collapsed turns + expanded last turn
6. takode peek 1 --turn 5                 → Expand turn 5 (use turn number from scan)
7. takode peek 1 --task 3                 → Browse task 3's messages
8. takode peek 1 --from 800              → Browse messages [800]-[860] in detail
9. takode read 1 815                      → Full content of message 815
10. takode grep 1 "query"                 → Search within session messages (regex)
11. takode grep 1 "error" --type user     → Search only user messages
12. takode export 1 /tmp/s1.txt           → Dump full session for offline analysis
```

Default to the plain-text forms above when you are reading for judgment. Switch to `--json` only when you need exact machine fields.

### `takode read <session> <msg-id> [--offset N] [--limit N] [--json]`

Read full content of a specific message, with line numbers and pagination.

```bash
takode read 1 42
takode read 1 42 --offset 0 --limit 50
```

### `takode grep <session> <pattern> [--type user|assistant|result] [--count N] [--json]`

Search within a session's message history. Uses **JS/ERE regex** (case-insensitive). Falls back to literal substring if the pattern is invalid regex. Use `|` for alternation, not `\|` (that's BRE syntax from grep/sed -- in JS regex it matches a literal pipe). Optional `--type` filter restricts matches to a specific message type.

```bash
takode grep 1 "authentication"
takode grep 1 "q-5[0-9]"                    # regex pattern
takode grep 1 "image|quality"               # alternation (matches either word)
takode grep 1 "error" --type user            # only user messages
takode grep 1 "commit.*synced" --type result  # only result messages
takode grep 1 "reward hacking" --count 20
```

Each match shows `[msg-id] time type turn snippet`. Use `takode read <session> <msg-id>` to see the full message, or `takode peek <session> --turn <N>` for the turn's context.

### `takode export <session> <path>`

Export a session's full conversation history to a text file. The exported file includes turn headers and all message content, suitable for searching with standard tools (grep, etc).

```bash
takode export 1 /tmp/session-1.txt
```

### `takode thread attach <quest-id> --message <index> | --range <start-end>`

Associate existing Main-thread history with a quest thread without moving or duplicating persisted messages. Use this when a quest thread is created after useful context already appeared in Main.

```bash
takode thread attach q-941 --range 120-135
takode thread attach q-941 --message 140
```

### `takode notify <category> <summary> [--suggest <answer>]...`
### `takode notify needs-input <summary> --question <prompt> [--suggest <answer>]... [--question <prompt> ...]`

Alert the user when they need to take action or record a visible non-attention waiting status. Available to all sessions (not orchestrator-only). For leader sessions, send the detailed question or decision text as a normal marked leader response first, then use `takode notify needs-input` for attention state and suggested replies. User waits must use `needs-input`; `waiting` and `Thread Waiting` are only for non-user waits such as workers, reviewers, timers, leases, queued dependencies, or herd events. Pending leader decisions are owner-scoped by default; continue unrelated orchestration unless the prompt explicitly creates a global or cross-quest blocker. The summary is required and should describe the action or status.

Categories: `needs-input`, `waiting`, `review`

Suggested replies are supported only for `needs-input`. Whenever you ask the user a question, include one or two concise suggested replies with `--suggest` for each question; for a binary question, include both choices. These are reply shortcuts, never preselected answers or authorization, and the user can always give a custom response. Publish complete visible decision context before notifying, naming every shortcut and explaining its meaning plus relevant tradeoff. Keep valid alternatives in that context even when they are not among the suggested replies. The one-or-two guidance is not a runtime maximum; the command continues to accept more suggestions. For multi-question prompts, each `--suggest` applies to the most recent `--question`; do not mix top-level `--suggest` with `--question`.

For leader thread waiting/ready status, prefer strict standalone inline markers such as `{[(Thread Waiting: q-42 | waiting on reviewer pass)]}` and `{[(Thread Ready: main | answered the user)]}`; these are stripped from displayed prose and rendered as status chips. These status markers never route the enclosing message or attached UI; only role-bearing `[thread:main:C]` / `[thread:q-N:C]` commentary prefixes or `[thread:main:A:u1]` / `[thread:q-N:A:u1,u2]` answer prefixes, the standalone `---` plus immediate role-bearing marker split syntax, and `# thread:...` shell comments control routing. Never use these status markers as the only representation of a user wait.

```bash
takode notify needs-input "need decision on auth approach for q-42" --suggest yes --suggest no
takode notify needs-input "need dispatch decisions" --question "Reuse #12?" --suggest yes --suggest no --question "Run browser validation?" --suggest yes --suggest no
{[(Thread Waiting: q-42 | waiting on reviewer pass)]}
{[(Thread Ready: main | answered the user's question)]}
takode notify review "landing page copy draft is ready for review"
```

### `takode phases [--json]`

List the read-only Quest Journey phase catalog. Available to all sessions. Use this when you need phase descriptions, source metadata, aliases, board states, assignee roles, or the exact `~/.companion/quest-journey-phases/<phase-id>/assignee.md` path to include in a phase dispatch.

```bash
takode phases
takode phases --json
```

### `takode pending <session>`

Show leader-answerable prompts for a session: `AskUserQuestion`, `ExitPlanMode`, and active `takode notify needs-input` questions.

## Orchestrator Commands

These commands require `TAKODE_ROLE=orchestrator`. Non-orchestrator sessions will get a permission error.

### `takode send <session> <message> [--correction]`

Send a message to a **herded** worker session (injected as a user message). Requires herding first.

**Syntax:** The session ID must always be the **first** argument after `send`. Flags (`--correction`, `--json`) go **after** the message or at the end. Putting flags before the session ID will cause parse errors.

Use `--correction` to send a steering message to a session that is currently running (without it, sends to running sessions are blocked).

```bash
takode herd 2
takode send 2 "Please also add tests for the edge cases"
takode send 2 "Actually, skip the auth tests" --correction
```

**Shell quoting safety.** Do not put complex text payloads directly inside double quotes if they may contain backticks, `$(...)`, quotes, braces, copied CLI output, or other shell-sensitive content. Your shell can execute or corrupt that text locally before the target command receives it. Use Takode's non-inline input paths instead: `takode send --stdin` for sent messages, and `takode spawn --message-file <path>` or `--message-file -` for spawn dispatches.

```bash
takode send 2 --stdin <<'EOF'
Investigate the failing path.
Treat `foo $(bar)` as literal text, not shell.
EOF
takode spawn --message-file - <<'EOF'
Investigate the failing path.
Treat `foo $(bar)` as literal text, not shell.
EOF
```

For quest comments or summaries, prefer the quest CLI's safer rich-text path instead of inline shell quoting:

```bash
cat >/tmp/quest-feedback.txt <<'EOF'
Port summary: commit abc123 ...
Treat `foo $(bar)` as literal text, not shell.
EOF
quest feedback q-123 --text-file /tmp/quest-feedback.txt

printf '%s\n' 'Port summary: commit abc123 ...' 'Treat `foo $(bar)` as literal text, not shell.' | \
  quest feedback q-123 --text-file -
```

### `takode reconnect <session...>` / `takode reconnect --all`

Start a fresh bounded **process reconnect** cycle for selected or all workers currently herded by the leader, without sending a synthetic task message:

```bash
takode reconnect 2
takode reconnect 2,3
takode reconnect --all
takode reconnect --all --json
```

The command is safe to use when a user asks a leader to reconnect its workers. It returns compact per-session results and skips sessions that are archived, unowned, already connected, already reconnecting, paused, or generating. A reconnect cycle can release a retained turn only when Takode's existing history proof says replay is side-effect safe. It does **not** increase the same-turn replay cap, silently change models, or clear result-error held background work that still requires a successful direct recovery probe.

After five failed Codex process attempts, automatic reconnect pauses. Running `takode reconnect ...` starts a new five-attempt process cycle. Use `takode send` instead only when you also intend to give the worker new task or steering text.

### `takode herd <session> [<session> ...]`

Claim worker sessions under your orchestrator. Each session can only have one leader.

```bash
takode herd 2 3 5
```

### `takode spawn [--backend claude|codex] [--count N] [--message "..."] [--message-file <path>|-] [--cwd DIR] [--no-worktree] [--fixed-name "..."] [--reviewer <session>] [--replace-worktree-worker <session>] [--json] [--details | --include <fields>]`

Create worker sessions and auto-herd them to yourself. **Sessions always use worktrees by default.** Never pass `--no-worktree` unless the user explicitly asks for it or the project's repo instructions require it -- even investigation and debugging tasks should get worktrees since they almost always lead to code changes. Use `--fixed-name` only for reviewer sessions (regular workers get auto-named from their quest). Use `--reviewer <session>` to create a reviewer session linked to a parent worker.

```bash
takode spawn                                                    # worktree session (default)
takode spawn --backend claude --count 3 --cwd ~/repos/app --message "Run tests"
takode spawn --message-file /tmp/dispatch.txt
takode spawn --replace-worktree-worker 5 --message-file /tmp/dispatch.txt
takode spawn --reviewer 5 --no-worktree --fixed-name "Skeptic review of #5" --message-file /tmp/reviewer-dispatch.txt
```

Use `--message` only for short inline text. For multiline or shell-like dispatch bodies, prefer `--message-file <path>` or `--message-file -`.

Use `--replace-worktree-worker <session>` when reclaiming an owned completed worktree worker for a new worker in the same repo/base branch. Replacement preflight inspects the live worktree, refuses uncommitted changes and commits genuinely ahead of the current target/base branch, allows a clean behind-only worktree, resets the recycled worktree to the base branch, and spawns the replacement in that path. Do not treat sidebar or `takode info` ahead/behind counts as the safety authority when they are surprising, because they may use a different session diff base; use replacement preflight or explicit current target-ref verification. It is not compatible with `--count > 1`, `--reviewer`, or `--no-worktree`.

Routine dispatch should use compact plain-text output, not spawn `--json`. If structured spawn output is needed for a script, compact JSON is the default and bulky session fields require `--details` or `--include <field>`.

### `takode rename <session> <name>`

Rename a session.

```bash
takode rename 5 "Auth refactor worker"
```

### `takode interrupt <session>`

Interrupt a worker's current turn (sends SIGTERM).

**Interrupt ≠ archive.** Interrupting only halts the worker's current turn -- the session stays active, its history and worktree are intact, and you can send it new work immediately. `takode archive` is a completely separate operation that removes the session from your active herd. Never tell the user you "archived" a session when you only interrupted it.

```bash
takode interrupt 2
```

### `takode answer <session> [--message <msg-id> | --target <id>] <response>`

Answer a worker's pending question, `needs-input` clarification prompt, or plan approval request.

```bash
takode answer 2 --message 41 1                          # pick option 1 for msg [41]
takode answer 2 --message 41 "custom answer"           # free text reply to msg [41]
takode answer 2 --message 52 approve                   # approve the plan shown in msg [52]
takode answer 2 --target req_abc reject "add error handling" # target an exact pending id
```

Use this when a worker or reviewer asked a clarification question through `takode notify needs-input` and is waiting on you. If you can resolve the question from existing context, answer it directly. If the question reveals genuine ambiguity you cannot resolve, ask the user in a marked leader response, then call `takode notify needs-input` with a short summary and suggested replies under the notification rule above, and do not advance that quest until the ambiguity is resolved.

### `takode board [show|detail|set|advance|rm]`

Quest Journey work board. See [board-usage.md](board-usage.md) for full usage and coordination patterns.

```bash
takode board show
takode board show --full
takode board detail q-12
takode board set <quest-id> [--worker N] [--status STATE] [--wait-for q-X,#Y,free-worker]
takode board advance <quest-id>
takode board rm <quest-id> [<quest-id> ...]
```

For queued rows, `--wait-for` accepts one comma-separated value containing multiple blockers, such as `--wait-for q-1143,q-1139` or `--wait-for q-1143,#12,free-worker`. Use that directly when multiple quest, session, or capacity blockers apply.

## Session Identification

Commands accept multiple formats:
- **Integer number**: `1`, `3`, `5` -- the short form from `takode list`
- **UUID prefix**: `abc123` -- first chars of the full UUID
- **Full UUID**: `550e8400-e29b-41d4-a716-446655440000`

Prefer integer numbers -- they're stable within a server session and easy to type.

## Session Naming

Sessions start with random names and auto-rename on first message and turn completion. Quest claiming changes the session name to the quest title and pauses auto-naming while the quest is active. Only use `--fixed-name` for reviewer sessions -- regular workers should rely on auto-naming from their quest.

When referencing sessions, use session numbers (`#107`) which are stable -- names can change.

## Disconnected Sessions

A `✗ disconnected` session just means its CLI process was killed (usually by the idle manager). The session history, worktree, and quest claim are fully intact. **Do not avoid disconnected sessions** -- if one is the right fit for a task, use it. `takode send` auto-relaunches the CLI before delivering the message, so no extra reconnect step is needed.

If a quest is still active on the board and its worker or reviewer is `idle` or `disconnected`, treat that as a potential stall signal rather than an automatic wait state. Check the quest phase and send the next legal instruction if progress has stalled; `takode send` will auto-relaunch disconnected sessions. Idle or disconnected sessions with active timers may still be healthy, so use timer visibility in `takode` outputs as part of that judgment rather than assuming every idle/disconnected row is stalled.

## Archiving Sessions

Maintain at most **5 worker slots** in your herd. Reviewers can be herded for routing, but they do **not** use worker slots. **Never archive proactively.** Only reclaim capacity when you are at the 5-worker-slot limit AND need to spawn a new worker. Use the worker-slot summary from `takode list` / `takode spawn` directly -- do **not** infer slot usage from the raw total. Archiving reviewers does **not** free worker-slot capacity. Idle and disconnected worker sessions retain valuable context -- keep them until you actually need the slot. Prefer `takode spawn --replace-worktree-worker <session> ...` over archive-then-spawn when replacing an owned completed worktree worker for the same repo/base branch; a clean worktree that is only behind the current target/base branch is reclaimable, while uncommitted changes or commits genuinely ahead of that target must be preserved first. Otherwise choose the worker least likely to be reused -- typically the one whose work is most complete, least related to upcoming tasks, or oldest. Archived sessions' conversation history remains readable via `takode peek`, `takode read`, and the Takode UI, but that history does not preserve uncommitted work from a deleted worktree.

## Tips

- **Use `peek` over `read`** to protect your context window -- peek gives truncated summaries. Drill into specific messages with `read` only when the summary isn't enough. Paginate long messages with `--offset`/`--limit`.
- **Use `--json` only for programmatic decisions.** Parse JSON output when you need to branch on exact event data, IDs, or other structured fields. Do not use spawn/replacement `--json` for routine dispatch; use the compact text result first and request details explicitly only when needed.
- **Verify spawn settings.** After `takode spawn`, check the output to confirm worktree and other settings match your intent. Never use `--no-worktree` unless the user explicitly requests it or the project instructions require it.
- **Mixed backends work seamlessly.** The `takode` CLI talks to the Companion server, not to any backend directly. You can orchestrate both Claude Code and Codex sessions from either backend.
- **Coordinate with quests.** Use the `quest` CLI alongside `takode` for task tracking. Always create a quest for non-trivial work before dispatching.
- **Board immediately.** When you intend to manage a quest (dispatch, review, port), put it on the work board right away (`takode board set`), even if it's QUEUED with `--wait-for`. The board is the tracking mechanism -- never rely on memory for follow-up dispatch. Exception: if the user only asked you to create/file the quest without dispatching, just create it and wait for their go-ahead.
- **Human-input pauses are quest-scoped board decisions.** If one quest is waiting on user clarification or confirmation, keep that pause explicit in the board handling for that quest and continue unrelated board work. Do not treat `/confirm` or another confirmation round as an implicit herd-wide pause; if the user parks that prompt, work elsewhere when there is no safety/global/cross-quest dependency.
- **Reconcile active rows after restarts/context reloads.** After a server restart, context compaction, or any manual state refresh, immediately compare `takode board show` and `takode list`. If an active board row has an `idle` or `disconnected` worker/reviewer, decide whether the quest is genuinely waiting or whether you need to send the next-phase instruction now.
- **Batch related messages.** If you need to send context + instructions to a worker, send it as one message rather than multiple.
- **Don't interrupt idle workers.** `takode interrupt` halts the worker's current turn. Only use it to redirect active work. Workers that finished a quest are already idle -- don't interrupt them unnecessarily.
- **Say "interrupt", not "stop".** When communicating with the user, prefer "interrupt" over "stop" to avoid confusion with archiving. "Interrupted #5" is unambiguous; "stopped #5" could imply the session was shut down.
- **Events are push-based.** Herd events arrive automatically as user messages when you go idle. No polling needed.
- **One task at a time per worker.** Don't send an unrelated new task to a busy worker. Mid-task steering (scope refinement, corrections, urgent interventions) is fine.
- **Don't repeat corrections.** Before sending a correction to a busy worker, check if you already sent one in the current turn. If yes, wait for the turn to end and evaluate whether the worker incorporated it.
- **For urgent mid-turn redirections:** interrupt the worker first (`takode interrupt`), wait for the interruption herd event, check its conversation to understand where it stopped, then send the corrected instructions as a fresh message.
