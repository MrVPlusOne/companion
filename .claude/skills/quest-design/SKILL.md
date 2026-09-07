---
name: quest-design
description: "Confirm quest intent before creating a new quest or refining an idea into a worker-ready quest. Invoke when a user asks to create, file, refine, scope, or prepare a quest, or before materially rewriting quest title/description/tags as part of refinement. Do not use for routine quest feedback, claiming, completion, verification checks, or other bookkeeping."
---

# Quest Design

Use this skill before creating a quest or refining an `idea` quest into a worker-ready quest.

The goal is to preserve quest text discipline: either give the user one concise chance to correct the agent's understanding before quest text is written, or explicitly identify that the work qualifies for direct low-risk create/dispatch under `/leader-dispatch`.
When the user clearly wants a quest created and dispatched, combine this with `/leader-dispatch`. If the request is clear, low-risk, reversible, repo-local, and has no material ambiguity, external side effect, security/privacy/global/shared-resource risk, product/policy choice, or user-level scheduling tradeoff, the leader may create the quest and dispatch without a user wait. Otherwise use the compact proposal shape below so one confirmation can approve quest text, Journey, and dispatch plan. In either case, the leader must write the authorized Journey to the board before or with dispatch.
After saying you will create, refine, or dispatch a quest, complete and verify the durable record in that same turn: exact quest ID, board row, needs-input notification, worker send/phase dispatch, Port/push, or other external record as applicable. If the durable action is not complete, mark the thread Waiting or incomplete with what remains instead of Ready. Avoid broad mixed context dumps as the final step before quest setup; prefer compact targeted checks and perform the durable action once the user request is clear.
After successful quest creation or refinement, include a lightweight non-blocking thread reminder when prior discussion may belong to the new quest thread: Thread reminder: attach any prior messages that clearly belong to this quest to [q-N](quest:q-N) with `takode thread attach`.

When the requested outcome includes both design or research and implementation, preserve it as one end-to-end `Goal / Acceptance` in one quest. A design-selection User Checkpoint is a pause inside that outcome, not an implicit design-only finish. The approval surface must say whether each selection authorizes same-quest implementation, design-only closure, or a separate implementation successor. Before splitting or reopening work, apply the exception and active-successor rules in `takode-orchestration/quest-journey.md`; the lifecycle guide and current phase briefs own the complete mechanics.

Before proposing quest text, explicitly check whether the new or refined quest is a true follow-up to earlier work. Use explicit follow-up relationships for true follow-ups, bug fixes, successors, redesigns, or user-approved next quests that came from prior findings. Leave incidental mentions, loose background context, copied examples, and broad references to auto-detected backlinks instead.

When a follow-up relationship is relevant, include it in the approval surface as a dedicated line such as `Relationship: follow-up of [q-1023](quest:q-1023)`. After the user confirms, persist it when creating the quest with `quest create ... --follow-up-of q-1023`, or when refining an existing quest with `quest edit q-N --follow-up-of q-1023`. If a relationship was recorded by mistake, use `quest edit q-N --clear-follow-up-of`.

The quest record itself must be self-contained enough for a future worker or user to understand the necessary background without opening every linked predecessor. Keep it concise. State the user's intended outcome, requirements and constraints the user supplied or confirmed, applicable mandatory constraints, and useful evidence or context -- especially material a worker could not reasonably recover independently. Define non-obvious terms and explain how a true follow-up differs from or builds on its predecessor. Links, screenshots, phase notes, and prior messages should enrich the record, not substitute for the minimum background needed to understand the quest.

Keep that context intent-first. Preserve leader analysis, examples, and possible approaches as non-binding context when they help the worker understand the task, but do not silently promote them into acceptance criteria. Detailed investigation, planning, technical design, validation details, and execution choices belong to Work unless the user confirmed them or an applicable requirement already fixes them.

## Scope

Use `/quest-design` before:
- `quest create`
- refining an `idea` quest with `quest edit` or `quest transition --status refined`
- materially rewriting title, description, or tags as part of quest refinement

Do not use `/quest-design` for routine quest operations:
- `quest show`, `quest list`, `quest grep`, `quest history`, or `quest tags`
- `quest claim`
- adding feedback to an existing quest
- addressing feedback
- completing a quest or checking User review checks
- verification inbox moves
- board updates
- lifecycle/status bookkeeping after an already-approved workflow

## Required Response

Before drafting a user-facing confirmation, apply `/leader-decision-communication`; it owns decision-first ordering, plain-language translation, and the material-detail necessity filter. This section keeps only quest-specific content: give the user the proposed quest, Journey, scheduling, and other facts needed to approve, correct, or choose without making them read the worker-facing quest body. Keep the quest record intent-first under the rule above: preserve the accepted outcome, user-supplied, confirmed, or mandatory constraints, and useful hard-to-recover context there, but leave unconfirmed leader ideas and detailed planning to Work. When using a proposed board row, put this approval packet in the mandatory `takode board propose --summary` payload and do not repeat it as separate chat text after running propose; the proposal UI/tool result renders the full summary and Journey. When the confirmation asks the user to choose, include the complete decision context in the thread before any `needs-input` notification; notification summaries, notification UI options, and `--suggest` choices are only attention/reply affordances. The visible text must name every shortcut and explain its meaning plus relevant tradeoff before notify runs.

Direct low-risk case: if `/leader-dispatch`'s rubric clearly allows direct create/dispatch, do not stop for confirmation. Create or refine the quest narrowly, keep any rationale compact when non-obvious, write the authorized Journey to the board, and dispatch the Alignment-only worker instruction. Do not use this shortcut for ambiguous quest text, uncertain follow-up relationships, product/user-choice decisions, user-visible tradeoffs, or risky/external/shared-resource work.

Best case: if the user clearly wants quest creation plus immediate dispatch and the request is already understood, include both:
- the proposed quest draft: title, `Goal / Acceptance`, tags when useful, and only optional sections that add non-overlapping approval value
- the proposed explicit relationship, when relevant: `Relationship: follow-up of [q-N](quest:q-N)`
- the proposed Quest Journey/scheduling draft from `/leader-dispatch`: phase sequence, concise non-standard phase reasons when useful, worker choice or fresh-spawn intent, and dispatch/queueing plan

One user confirmation can approve both the quest draft and the Journey/scheduling plan. Do not add a separate confirmation round just to restate understanding, and do not require a separate board-presentation approval ceremony. If you choose the proposed-row path, `takode board propose --summary` is that ceremony; keep surrounding chat minimal instead of duplicating the summary.

Use one source of truth for the requested work. Prefer a single `Goal / Acceptance` section that serves as both your understanding and the proposed quest's user-supplied, confirmed, or mandatory acceptance criteria. If you already wrote a concise understanding, either make that text the `Goal / Acceptance` section or replace it with one expanded `Goal / Acceptance`; do not restate the same work again as a separate quest description, `Scope` paragraph, `The worker should` list, default `Expected Output / Acceptance` section, or full quest-body paste.

Use the compact proposal shape when it fits:
- `Proposed Quest`
- `Goal / Acceptance`
- optional `Context / Evidence`
- optional `Out Of Scope`
- optional `Open Questions`
- `Journey`, only when dispatch or Journey approval is in scope
- `Scheduling`, only when dispatch or queueing is in scope

Treat that shape as a menu, not a form to fill out. Do not reproduce every heading or explanatory bullet when the decision can be made from a shorter packet. Default to a short approval packet, but preserve judgment: expand only for a real relationship, open question, unusual phase reason, user-visible boundary, queueing/capacity choice, or another fact the user needs to approve or correct.

Add separate sections only when they carry non-overlapping approval information, such as `Relationship`, `Context / Evidence`, `Out Of Scope`, `Open Questions`, `Invariants / Must Preserve`, `Journey`, non-standard phase notes, and `Scheduling`. Open questions and assumptions are optional and should only cover decisions not already implied by `Goal / Acceptance` or the user's stated facts. Omit optional sections entirely when they add no new approval value. Intent-first worker context belongs in the quest record, not in the chat approval surface; source material can inform Work without becoming binding scope.

For Journey notes, use the v2 active workflow by default: `alignment -> work -> memory`, with `user-checkpoint` only when a visible decision pause is expected inside Work. If that checkpoint selects a design, state whether each offered selection continues implementation in the same quest, closes the quest as design-only, or authorizes a separate implementation successor. Do not present a design choice as closure when the accepted `Goal / Acceptance` still includes implementation. Omit standard v2 phase notes by default; explain only unusual checkpoint needs, exceptional separate review-quest routing, or authority/safety boundaries the user must approve.

When a proposal includes multiple phase notes, format them as bullets keyed by phase, for example `- Work: ...` and `- User Checkpoint: ...`. Keep the phase list, phase notes, and scheduling plan visually separate so the approval surface is easy to scan before the user confirms.

Clarification-needed case: ask the material questions using the quest framing below. After the user clarifies and no major ambiguity remains, the next response should include both the proposed quest draft and proposed Journey/scheduling draft together. More than two confirmation rounds should happen only when new, genuine ambiguity remains.

When you only need quest text approval and dispatch is not in scope, use the same compact spirit and omit `Journey` and `Scheduling`:

### Proposed Quest

- Title, when ready.
- Tags, when useful.
- Relationship, when relevant.

### Goal / Acceptance

- Intended goal and only user-supplied, confirmed, or mandatory acceptance checks for the quest.
- Clean bullets when the request has multiple parts.

### Context / Evidence

- Optional. Include only material prior quests, source examples, screenshots, logs, user reports, or artifact paths.

### Out Of Scope

- Optional. Include only exclusions that prevent likely misunderstanding.

### Open Questions

- Ask only the highest-leverage questions that could materially change the quest.
- Omit this section entirely when nothing remains unclear.

End with:

---
Please confirm or correct.

## Waiting

After sending the confirmation, stop and wait for the user.

If you are acting as a leader/orchestrator and the confirmation asks a blocking question, send the confirmation as commentary with the correct first-line role-bearing marker (`[thread:main:C]` or `[thread:q-N:C]`), then run `takode notify needs-input "<brief summary>"` so the user notices. The confirmation text must be self-contained enough to answer, including options and tradeoffs when relevant. Include suggested replies under the `takode-orchestration` notification rule, preserving the written confirmation context. Do not use `Thread Waiting` or `takode notify waiting` as the only representation of this user wait. Normal worker and reviewer sessions should use ordinary chat.

If you are creating another approval surface while an older prompt is still unresolved, do not reuse or rely on the older notification. New blocking prompt -> new `takode notify needs-input`; after creating it, link the board row with `--wait-for-input` when applicable. `Thread Waiting` is only for non-user waits and is never a substitute for the notification.

If the user corrects the understanding and ambiguity remains, repeat the same structure with the updated understanding. If the user clarifies enough to remove the ambiguity, draft the quest and Journey/scheduling plan together instead of sending a separate restated-understanding-only round.

Only after the user confirms, or when the direct low-risk case above clearly applies, should you create or refine the quest.
When you create or refine the quest, keep subsequent quest-specific activity in `[thread:q-N:C]`; use `[thread:q-N:A:u1]` for a polished self-contained answer to the applicable earlier user-message ID or IDs. Attach clearly quest-specific prior discussion with `takode thread attach`.
