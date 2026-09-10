# Retain review history and track a port

Use the tracking helper for new private Work. It records review refs and source/target relationships; normal Git commands still perform the rebase, squash, and cherry-pick. It never rewrites an already-landed commit or pushes a branch.

A delivery is one accepted batch ported to the selected target. Cohesive implementation, tests, and review fixes normally become one final commit. Keep independent meaningful changes as separate groups. Later fixes after an earlier port form another delivery, even in the same quest.

## 1. Retain the reviewed private range

First resolve/check the selected target using the main skill. Refresh the relevant remote knowledge for a remote-backed target. Establish the exact private base and commit range from this Work's provenance and prior port receipts. A remote-tracking ref's absence or one matching author is not proof of privacy. Do not include published, mixed-ownership, unrelated, or uncertain commits.

```bash
takode port prepare q-N --base <private-base-sha> --confirm-private
```

`--confirm-private` asserts your verified scope; it is not new user authorization. Preparation requires a clean worker tree, a linear range, and the configured target. It rejects known landed source/review commits, remote-reachable commits, mixed authors, and bypasses of an unresolved earlier preparation. Unsupported cases keep their original commits and require an explicit resolved plan.

Save the returned preparation ID. The default is one cohesive group. To retain meaningful separate final commits, pass their reviewed group tips in order:

```bash
takode port prepare q-N --base <private-base-sha> --group-tips <group-one-tip>,<group-two-tip> --confirm-private
```

The final group must end at worker HEAD. Preparation retains the original commits under create-only `refs/takode/review/<opaque-id>/...` refs in the common repository. It does not change branch history.

## 2. Rebase, review, and package

Rebase only the verified private suffix onto the selected target, in the worker checkout. Use the recorded private base rather than replaying an already-ported prefix with different cherry-picked SHAs:

```bash
git rebase --onto <target-branch> <private-base-sha>
```

Review conflict resolutions and integration changes. If the base or reviewed SHAs changed, refresh the retained series explicitly:

```bash
takode port prepare q-N --base <new-base-sha> --previous <preparation-id> --confirm-private
```

Repeat `--group-tips` with the new group tips when preserving multiple groups. Use the new returned preparation ID. Earlier review snapshots remain retained.

After review, squash each accepted cohesive group with normal Git. For one group covering the complete prepared suffix, the usual form is:

```bash
git reset --soft <prepared-base-sha>
git commit --file <commit-message-file>
```

For multiple groups, use normal interactive rebase to preserve the declared group boundaries. Never bypass commit hooks. Do not mix content changes into packaging; review any new content first. Keep authored/signature or other meaningful boundaries when squashing would misrepresent them.

Then validate the replacement commits against the retained review:

```bash
takode port seal q-N <preparation-id> --commits <final-worker-sha>,<another-final-worker-sha>
```

Sealing requires one commit per group, the expected parent chain, exact per-group resulting-tree equality, and the current target base. It retains the sealed worker commits too, so a changed cherry-pick SHA does not lose its source after cleanup.

## 3. Port and record each landing

Check the target again and perform the existing chronological cherry-picks. Immediately record each successful target SHA before any subsequent port or cleanup:

```bash
git -C <selected-target-checkout> cherry-pick <final-worker-sha>
takode port landed q-N <preparation-id> --source <final-worker-sha> --target <resulting-target-sha>
takode port status q-N <preparation-id>
```

The helper verifies target ancestry, the landed prefix, and the resulting tree. After unrelated target advancement, it may accept an already-performed port only when every changed path, file mode, and before/after blob is identical to the sealed change. This supports disjoint intervening work without using patch similarity; shared-file integration changes remain uncertain and require review. It distinguishes `retained`, `needs-rebase`, `ready-to-port`, `partial`, `landed`, `uncertain`, and `superseded`. Before sealing, remaining entries are review-group tips, not commands to cherry-pick. After sealing, they are exact prepared commits. Read the state and next action together.

A successful target write is a boundary even if validation, push, or metadata recording later fails. The original source SHA may differ from the target SHA. A missing receipt is not evidence that no write happened. If the target advanced after sealing or a partial port changed base, stop further rewriting and reconcile the actual history/receipts; this helper deliberately does not guess equivalence across that uncertainty. Do not erase a journal, discard refs, or start another preparation to bypass it. Preserve any additional worker HEAD changes before reset/cleanup.

## 4. Verify, publish, and attach delivery evidence

Run the existing selected-target full gate and publication rules, then perform the normal sync/post-sync checks. Only final target commits enter normal quest code evidence; original review increments remain separate.

```bash
takode board work-to-memory q-N --work-note <index> --commits <target-sha>,<another-target-sha> --preparation <preparation-id>
```

If a specifically authorized earlier delivery is ready while Work must continue, record it without advancing the phase:

```bash
takode board record-work-delivery q-N --work-note <index> --commits <target-sha> --preparation <preparation-id>
```

Both use the guarded owner/Work-note/checkpoint/target evidence path. The later Work-to-Memory transition still requires current evidence and must include subsequent Work. Old deliveries cannot prove new changes. Do not use `--no-code` for a Work occurrence that already recorded tracked changes.

The response supplies an exact delivery ID; `quest show q-N --sections metadata` also lists recent delivery IDs for recovery. Read-only `takode port status` remains available after Work, subject to the journal’s actor/branch/target checks. Include it in the Work handoff with the ordered target SHAs. Leaders obtain stable response chips with:

```bash
quest commit-links q-N --delivery <delivery-id>
```

The optional `--commits` subset selects only commits inside that recorded delivery. The command only authors links; it never sends a message, mutates evidence, or displays today's whole mutable commit list in an old response. Never fabricate delivery IDs or backfill historical provenance.

Review and sealed refs survive worker reset/removal. They consume local disk, are not backed up by ordinary push, and have no new automatic expiry. Viewing unavailable evidence must remain honest. Never use the invalid-evidence replacement command as a normal many-to-one squash mechanism.

## Independent published targets

An explicitly approved publication may use a separate checkout and remote branches instead of the session's inherited integration target. Do not move that publication onto an unrelated leader branch or push it again to fix internal recording. Keep the publication receipts and original review history. The inherited-target preparation workflow above remains for actual ports; do not manufacture preparation receipts for an independent publication.

The assigned leader can record an already-authorized target for the current worker and Work occurrence:

```bash
takode board approve-delivery-target q-N --target-file /tmp/delivery-target.json
```

The JSON names the exact local clone, configured remote URL, and published branch heads in delivery order:

```json
{
  "checkoutPath": "/absolute/independent-checkout",
  "remote": "origin",
  "repositoryUrl": "https://example.com/team/project.git",
  "refs": [
    { "ref": "refs/heads/user/runtime", "sha": "<full lowercase commit SHA>" },
    { "ref": "refs/heads/user/consumer", "sha": "<full lowercase commit SHA>" }
  ]
}
```

This command records existing approval; it does not grant permission for new external operations. It reads the configured remote and verifies every exact published head and local commit object without fetching, pushing, switching branches, or changing session targets. Only the leader owning the unique active assignment can approve. Approval alone does not attach code evidence.

The worker supplies the returned approval ID and the exact unique SHAs in the same order:

```bash
takode board work-to-memory q-N --work-note <index> --commits <sha1>,<sha2> --delivery-target <approval-id>
```

A specifically authorized earlier delivery can use the same flags with `record-work-delivery`. Do not combine `--delivery-target` with `--preparation` or `--no-code`. Worker ownership, current Work note, checkpoint, feedback and transition guards still apply; published refs are reverified before evidence is recorded. The descriptor preserves every approved ref/head, with the final listed branch as the delivery's primary branch. An existing session can use this path immediately without rebinding its inherited target.

Recover approval IDs with `takode board delivery-targets q-N`; use `--target <approval-id>` for the complete persisted descriptor. Approvals are immutable and scoped to their leader, worker and Work occurrence. A changed assignment, new Work occurrence, different repository or changed refs requires a fresh leader approval within the existing authorized scope. Historical deliveries and their fixed links remain unchanged; old approvals do not authorize unrelated Work. This path does not repair terminal Journey routing or old live quest records automatically.

A target mismatch requires reconciling the intended repository/refs; a remote-read failure requires restoring access and repeating read-only verification. Neither means successful publication was undone. Retain the independent checkout/objects for later diffs; this path does not import, retain, or backfill private port-review refs into a separate clone. Missing objects remain honestly unavailable.
