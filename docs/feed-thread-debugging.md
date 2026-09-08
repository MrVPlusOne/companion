# Feed and Thread Debugging Guardrails

This guide is for changes that touch chat feed rendering, thread projection,
thread-window hydration, notifications, attention rows, collapsed activity, or
dense leader-session history.

The main risk is not only "slow code." A small render-time loop, impossible test
fixture, or unbounded synthetic row merge can wedge one browser renderer while
the server and other sessions stay healthy. Use these guardrails before editing
the feed path and while reviewing feed changes.

## Quick Reviewer Checklist

- Manual loops in render/model code always advance, return, or fail loudly.
- Thread/feed tests use producer-shaped inputs from shared/server builders,
  captured payloads, or maintained replay fixtures.
- Main, selected quest threads, All Threads, notifications, collapsed turns,
  attachments, selected-window state, and large history are represented when the
  change can affect dense leader sessions.
- Freeze evidence is gathered from outside the renderer when browser probes
  stop returning.
- Main/thread projection invariants are explicitly covered when attachment or
  notification visibility changes.

## Manual Render Loop Progress

Avoid manual `while` loops in render paths unless they are clearly simpler than
an iterator or helper extraction. If a manual loop is needed, every branch must
do one of these before control reaches the next iteration:

- advance the loop index;
- assign the loop index to a known-larger cursor;
- return or break;
- throw in dev/test if the input violates an invariant.

This includes branches that only skip invisible rows, merge adjacent rows, or
render nothing. A `continue` that does not advance can pin the renderer even
when the input is small.

Preferred review pattern:

```ts
let i = 0;
while (i < entries.length) {
  const start = i;
  const entry = entries[i];

  if (shouldSkip(entry)) {
    i++;
    continue;
  }

  if (shouldBatch(entry)) {
    const next = findBatchEnd(entries, i);
    if (next <= i) {
      throw new Error("Feed batcher did not advance");
    }
    renderBatch(i, next);
    i = next;
    continue;
  }

  renderEntry(entry);
  i++;

  if (import.meta.env.DEV && i <= start) {
    throw new Error("Feed renderer loop did not advance");
  }
}
```

Do not rely on visual inspection alone. Add a regression test for the skipped or
batched row that caused the branch to exist. Empty assistant messages,
notification-only rows, hidden marker rows, collapsed turn rows, and synthetic
ledger rows are common skip paths.

## Producer-Shaped Fixtures

Thread/feed/window tests should model the shape the frontend actually receives.
Prefer these sources, in order:

1. Shared/server builders such as `buildThreadWindowSync`.
2. Sanitized captured browser payloads such as `history_window_sync`,
   `thread_window_sync`, or explicit `history_sync`.
3. Maintained generated fixtures such as
   `web/src/test-fixtures/large-leader-feed-fixture.ts`.

Avoid frontend-invented shapes for server-owned state. If production hides or
adds fields before the browser receives a selected window, the test should
consume that transformed shape too.

Specific examples:

- Main thread windows suppress `thread_attachment_marker` rows. Tests for Main
  attachment retention should not put visible marker rows into
  `selectedFeedWindowMessages` unless they are explicitly testing an impossible
  defensive path.
- Backfilled Main/source rows should be hydrated from raw marker facts in the
  shared/server window builder, then projected into the browser-visible window.
- Mixed-owner answer fixtures should finalize one source answer against actual
  direct-user rows before building the window. Include prompts with different
  tab associations and an unrelated pending request: visibility follows the
  union of referenced prompts' tabs, while each owner receives coverage only
  for its own referenced prompts.
- Attention and notification ledger rows are synthetic frontend rows. Tests that
  exercise selected-window bounds should include the real selected window state,
  not only an arbitrary array of visible messages.
- Captured payload fixtures must be sanitized. Do not commit raw session exports,
  private paths, keys, or user conversation text.

## Dense Leader Replay Coverage

For changes that affect feed organization, selected-thread windows, collapsed
activity, notifications, or attachment projection, a useful replay or fixture
should cover at least:

- Main thread latest-tail rendering.
- One selected quest-thread tab with copied/backfilled context.
- All Threads or another global aggregation view when the code path includes it.
- Journey or event-feed rows.
- Notification chips, including active needs-input/review notifications.
- Collapsed leader activity with dense historical tool and board rows.
- Attachment markers as raw history facts and hidden projected rows.
- Selected-window metadata: item count, total count, from item, source history
  length, older/newer availability, and browser-visible entries.
- Large history size with many irrelevant rows, so model derivation remains
  bounded to the selected window plus explicitly retained rows.

If a full browser replay harness would be substantial, do not build it as part
of a small feed fix. Instead, add a generated fixture or document the missing
coverage in the quest handoff.

## Bounded Viewport Transition Probe

For an intermittent feed jump that cannot be disambiguated from a screenshot,
use the opt-in browser probe in
`web/scripts/capture-feed-viewport-transitions.js`. It records at most 200
deduplicated geometry samples and no message text or status summaries. It keeps
one initially visible ordinary message as the stable anchor and records its ID
and pixel offset together with scroll range, real/physical bottom gaps, trailing
slack, activity/reservation heights, thread-status contribution/compensation,
mounted-window identity, route, and a small metadata-only frontend-performance
tail.

Install and start it only while reproducing the symptom:

```bash
cat web/scripts/capture-feed-viewport-transitions.js | agent-browser eval --stdin
agent-browser eval 'window.__TAKODE_FEED_VIEWPORT_PROBE__.start()'
```

If more than one feed is visible, pass a unique container selector instead of
letting the probe guess. The Playground leader-return fixture uses:

```bash
agent-browser eval 'window.__TAKODE_FEED_VIEWPORT_PROBE__.start({containerSelector:"[data-testid=playground-leader-session-return] [data-testid=message-feed-scroll-container]"})'
```

After the transition, read or explicitly sample the bounded trace, then stop it:

```bash
agent-browser eval 'window.__TAKODE_FEED_VIEWPORT_PROBE__.sample("after-transition")'
agent-browser eval 'window.__TAKODE_FEED_VIEWPORT_PROBE__.read()'
agent-browser eval 'window.__TAKODE_FEED_VIEWPORT_PROBE__.stop()'
```

Interpret the fields together rather than naming a chip from correlation alone:

- changing trailing slack or physical-bottom range with a stable mounted window
  points to overlay runway or native scroll clamping;
- changing thread-status contribution with matching compensation isolates the
  in-flow footer path;
- a changed mounted-window signature or missing anchor points to window/route
  ownership instead of local chip geometry;
- a stable window with a changed content bottom points to late layout settlement
  or intentional true-bottom following.

Clear the trace between separate scenarios with `clear()`. The probe is a
diagnostic pasted into the current page; it does not enable persistent telemetry
or write to the server.

## Renderer-Freeze Triage

When the browser appears frozen, gather evidence that does not depend on the
wedged page responding. Record the exact last successful step and save artifact
paths.

Capture:

- browser open/navigation result;
- viewport command result;
- URL/eval result, including whether it timed out;
- screenshot result, including blank/dark screenshots;
- browser close result;
- backend health and Vite health;
- process list with the owned browser renderer CPU;
- console logs collected before the hang;
- server logs and isolated fixture state strategy;
- last visible UI state before probes stopped returning.

Interpretation:

- One renderer process pinned near a full core while backend/Vite stay healthy
  points to a frontend render loop or pathological render path.
- Other sessions staying responsive points away from global server-heavy work.
- A screenshot/eval timeout after a click or route transition should be treated
  as evidence even if the page cannot return in-page performance data.

## Projection Invariants

Preserve these invariants unless a product decision explicitly changes them:

- Main keeps messages that originally belonged to Main/source visible after they
  are attached to a destination quest thread.
- Destination quest threads receive the attached context.
- Source-side `thread_attachment_marker` rows remain hidden in normal Main feed
  projection.
- Future messages explicitly routed to a quest thread stay out of Main, except
  valid answers referencing Main-associated user requests. Those answers share
  one stored identity and exact prose across their referenced prompts' tab
  associations; unrelated quest content remains excluded.
- Notification chips render once in chronological context when their source row
  is visible.
- Active notification or attention rows should not duplicate as fallback ledger
  rows when the source chip is already visible.
- Collapsed turns preserve visible notification and needs-input chips even when
  dense tool activity stays unmounted.

When touching these areas, include a representative test in one of the existing
feed/window suites:

- `web/shared/thread-window.test.ts` for server/shared selected-window shape;
- `web/src/utils/feed-render-model.test.ts` for projection and ledger derivation;
- `web/src/components/MessageFeed.messagefeed-message-rendering.test.tsx` or
  adjacent `MessageFeed.*.test.tsx` suites for rendered visibility and collapsed
  activity behavior;
- `web/src/utils/feed-render-model.large-leader-budget.test.ts` for dense leader
  budget expectations.

## Follow-Up Harness Shape

A full freeze triage harness would be useful but is intentionally larger than a
normal feed bug fix. The desired version would:

- launch an isolated server and browser profile, never live default state;
- replay a sanitized dense leader session with Main, selected quest tabs,
  notifications, attachments, board/tool rows, and selected-window metadata;
- run deterministic route transitions: Main, selected quest thread, Main
  switchback, All Threads;
- record outside-renderer probes and process CPU after every transition;
- retain screenshots, server logs, Vite logs, browser logs, and fixture metadata;
- support both Claude Code and Codex-shaped messages.

Until that exists, prefer small generated fixtures plus the outside-renderer
triage checklist above.
