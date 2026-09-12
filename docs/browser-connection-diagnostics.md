# Browser connection transfer diagnostics

The backend logs one `browser-connection` observation for each session WebSocket,
including reconnects. Inspect it with:

```bash
takode logs --component browser-connection --since 10m --limit 100
takode logs --component browser-connection --pattern <connection-id> --json
```

Use the opaque `connectionId` to group events from one physical socket. A new
socket receives a new ID even when it views the same session. `clientPlatform`
is a coarse user-agent hint (`ios`, `android`, `other`, or `unknown`), not verified
device identity. An iPad using a desktop user agent may appear as `other`.
No user agent, client address, URL, message body, tool output, or credentials are
retained by this diagnostic.

Events follow these boundaries:

- `opened`: the backend has accepted the WebSocket. HTML/assets, API bootstrap,
  DNS, TLS, and the WebSocket handshake happened outside this timing boundary.
- `initial_sync_queued`: the first subscribe handler finished. The count includes
  initial messages, selected conversation windows, replay, projections, state,
  and any live messages interleaved on this socket before the end marker.
- `client_marker_received`: the browser acknowledged the marker queued after
  the initial state snapshot. `markerReceiptDelayMs` includes socket buffering,
  downstream delivery, browser message scheduling, and the acknowledgement's
  return trip. It is not an isolated network-latency measurement, proof that all
  prior messages applied successfully, React commit, paint, or frontend usability.
- `initial_sync_slow`: ten seconds have elapsed since socket open without the
  initial marker acknowledgement. `status` identifies whether the server is
  still awaiting subscribe, handling it, or awaiting the browser marker.
- `initial_sync_failed`: the subscribe handler failed. Existing failure behavior
  is preserved; diagnostics do not retry or recover it.
- `closed`: cumulative totals for the whole socket lifetime, including explicit
  later browsing and live updates. An early close retains the incomplete status.

`subscribeStartDelayMs` measures socket-open to first subscribe handling;
`subscribeHandlerMs` measures that handler, including awaited work.
`initialLastSeq` records the normalized initial sequence request. Zero does not
prove a cold page load. `explicitFullHistory` records a deliberately requested
full-history operation. The diagnostic does not change synchronization, replay,
retention, content selection, or model input delivery.

`acceptedPayloadBytes` is the UTF-8 byte length of serialized application payloads
accepted by the socket send API, counted once per actual recipient. It is not
JavaScript string length, compressed bytes, frame/TLS overhead, or proof of
delivery. `initialSyncAcceptedPayloadBytes` freezes that count at the initial
marker; subsequent totals continue to include live traffic. `largestMessageTypes`
reports the eight largest type buckets; `otherAcceptedPayloadBytes` accounts for
the remainder. Type inventory is capped at 32 names plus an overflow bucket.

Bun send result zero counts as dropped; a thrown send counts as failed; minus
one counts as accepted with backpressure. `peakBufferedBytes` samples Bun's
socket buffer after accepted sends. It is not the client's pending work or a
measurement of every buffering layer. The existing aggregate `/api/traffic/stats`
is a separate historical metric: its `wireBytes` is encoded payload size times
fanout, not captured wire traffic.

Warnings are diagnostic heuristics, not load budgets or evidence of a root cause:

- `large_initial_payload`: at least 2 MiB of accepted initial payload.
- `slow_initial_sync`: at least 10 seconds from accepted socket to marker receipt
  or an outstanding initial observation. Backgrounding or client suspension can
  also cause it.
- `send_not_accepted`: a send returned zero or threw.

There is at most one timeout warning per socket. State is bounded by live sockets,
with counts and capped type buckets only; close releases it. The existing async,
rotated server logger owns retention. Raw protocol recording remains independent
and off by default. The content-free probe is not persisted or replayed.

These records cover the session WebSocket, not the whole page. Correlate a phone
retry's exact time, URL/access route, selected session/view, and browser mode with
the connection ID. Use existing frontend performance entries to distinguish
parse/apply, replay flush, React commit, next paint, and long tasks. A fast server
handler cannot establish a fast usable page, and a large transfer alone cannot
establish the cause of a reported delay.
