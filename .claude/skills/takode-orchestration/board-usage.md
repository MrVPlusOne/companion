# Work Board

The work board (`takode board show`) tracks Quest Journey v2 coordination: proposed rows, queued rows, active state, worker assignment, checkpoint waits, timing, and next action.

Active v2 states are:

`PROPOSED`, `QUEUED`, `PLANNING`, `WORKING`, `USER_CHECKPOINTING`, `MEMORY`

Legacy v1 states and phase IDs are historical-read compatibility only.

## Common Commands

Show compact board:

```bash
takode board show
```

Show full row detail:

```bash
takode board detail q-12
```

Create the default active Journey after authorization:

```bash
takode board set q-12 --worker 5 --phases alignment,work,memory --preset v2-work
```

Create a proposed approval-hold row:

```bash
takode board propose q-12 --phases alignment,work,memory --summary "Goal, key tradeoff, scheduling, and exact approval question."
takode board promote q-12 --worker 5
```

Advance from Alignment to Work:

```bash
takode board advance q-12
```

Worker-owned Work -> Memory transition with synchronized selected-target code commits:

```bash
takode board work-to-memory q-12 --work-note 3 --commits "abc1234,def5678"
```

For genuine zero-git-tracked-change Work only:

```bash
takode board work-to-memory q-12 --work-note 3 --no-code
```

For a direct approved optional checkpoint immediately before Memory, record why its skip condition is satisfied on the same guarded transition:

```bash
takode board work-to-memory q-12 --work-note 3 --no-code --skip-optional-checkpoint "Work confirmed no user-visible tradeoff."
```

Queue pre-active work on dependencies:

```bash
takode board set q-12 --status QUEUED --wait-for q-9,#14,free-worker
```

Pause active Work on a same-session user decision:

```bash
takode board set q-12 --status USER_CHECKPOINTING --wait-for-input 7
takode board set q-12 --status WORKING --clear-wait-for-input
```

## Rules

- `alignment`, `work`, `user-checkpoint`, and `memory` are the only active phase IDs.
- The default phase plan is `alignment,work,memory`.
- User Checkpoint is a pause/resume state inside Work. Link it with `--wait-for-input`; do not turn it into `QUEUED`.
- User Checkpoints are required by default. An approved phase note may mark one optional only with a concrete skip condition. A direct `[work,user-checkpoint,memory]` skip uses guarded `work-to-memory ... --skip-optional-checkpoint <reason>`; required or taken checkpoints need a later Work occurrence before Memory, so revise the suffix before entering when necessary.
- Generic `board advance` cannot skip directly from Work into Memory. It may advance or resume repeated plans into a later Work occurrence, including an approved optional skip whose destination is later Work.
- Work owns investigation, implementation, self-review, approved execution, validation, sync/push duties, iterative fixes, and structured target code evidence inside the approved envelope.
- Project-specific safety, permission, durable-data, lease, cluster/job, credential/privacy/security, external-effect, strong verification, and no-force Git rules remain authoritative.
- Memory normally stays with the same worker and completes the quest after durable closure; it may attach separate memory-repository commits but must not first-attach Work code SHAs.
- Independent review is a separate quest, not an embedded board phase.
- Do not create or revise rows with legacy v1 phase IDs such as `implement`, `code-review`, `port`, or `execute`.
- Use `takode board show --full` for full board inspection and `takode board detail q-N` for one row's timing, notes, legacy compatibility labels, and revision details.
- Do not restate current board rows in chat after updating the board; the UI already shows them live.

## Work To Memory Guard

`takode board work-to-memory` is intentionally narrower than generic board mutation. It succeeds only when the caller is the authenticated assigned worker, the quest is claimed by that worker, the row is `WORKING`, a current Work note exists, no unresolved checkpoint is linked, and the request supplies exactly one fresh evidence mode: non-empty `--commit` / `--commits` for synchronized selected-target SHAs, or `--no-code` for genuine zero-git-tracked-change Work. Do not combine the modes. Older stored commits do not replace fresh evidence for a rework occurrence.

The transition persists normalized code SHAs before entering `MEMORY` and appends only new unique values. A Work note alone is not structured evidence. Leaders can still inspect or intervene, but routine Work completion should not require leader-owned Port/review/Memory dispatch, and final Memory must route missing code evidence back to Work rather than first-attaching it.

## Correcting Invalid Work Evidence

Use the correction-only command when structured Work code evidence is already wrong; never append a valid SHA while leaving known-invalid evidence authoritative:

```bash
takode board replace-work-evidence q-12 --expected-commits "bad1234" --commits "abc1234" --reason "Correct mistyped delivery evidence"
```

The authenticated assigned worker may run it only on the active `WORKING` occurrence with no unresolved User Checkpoint. The expected ordered list must exactly match current storage. Replacement commits must resolve in the configured selected target, remain reachable from its stable branch head, contain at least as many entries as the prior list, and stay within the bounded command limit. The compare-and-swap replacement and its actor, reason, prior/replacement lists, Work occurrence, and verified target head are recorded atomically. The command does not advance the Journey; refresh the current Work note, then use the ordinary guarded `work-to-memory` transition with this occurrence's fresh synchronized code evidence.

## Historical Rows

Existing legacy rows are preserved as stored for compatibility: their phase IDs, notes, timings, statuses, and ownership remain readable and can finish their recorded Journey. New or materially revised rows must use active v2 phases only.
