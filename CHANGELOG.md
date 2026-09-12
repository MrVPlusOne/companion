# Takode Changelog

## 2026-09-11

### Added

- **Notify Me** -- Monitor named task tabs and keep new results in a global list until acknowledged or replied to; monitoring survives viewing, tab closure, and reconnects while ordinary unread and needs-input remain independent

## 2026-08-31

### Changed

- **Session identity projection** -- Compact navigation rows take session names, claimed-quest fields, and live-only rename animation from one synchronized authority while detail, mutation, and recovery state remain separate

### Fixed

- **Build mismatch actions** -- Takode distinguishes the browser-loaded frontend, server-served frontend, and backend build; Reload is offered only for a coherent server pair, while broken or identity-less pairs request a full restart and stale probes cannot restore the wrong banner

## 2026-08-30

### Added

- **Build compatibility enforcement** -- Takode detects incompatible frontend/backend builds, shows an explicit recovery notice instead of silently keeping mixed versions, and prepares and validates replacement frontends before interrupting the current compatible pair

### Changed

- **Codex compaction accounting** -- Ordinary usage uses the provider's last total while prompt input, configured capacity, and compaction cause stay distinct; uncorrelated automatic compactions remain cause-unknown instead of receiving synthetic charged-context claims
- **Scheduled quest tabs** -- In-motion work stays ahead of queued or proposed tabs, scheduled tabs can be dismissed without changing board state, and genuine activation can resurface them safely
- **Session navigation authority** -- Compatible builds use one canonical server row across navigation surfaces, so stale REST state cannot make active sessions appear idle while first-upgrade migration and raw actions remain safe
- **Leader thread authority** -- Current-build leader tabs use one synchronized visual authority with preserved phase colors, ordering, routing, current-run fencing, and bounded persisted-tab migration
- **Browser conversation synchronization** -- Current-build browsers use one bounded server-authored history and thread path; routine full-history and unused sidecar delivery are removed while explicit recovery, routing, attachments, and replay remain intact
- **Session attention authority** -- Compact unread, needs-input, and timer visuals use one fail-closed synchronized projection across browsers while notification detail, permissions, persisted read state, and mutation remain authoritative separately

### Fixed

- **Interrupted leader continuation** -- Interrupted Codex leader work stays visibly recoverable in its thread; one safe continuation can finish missing work without replaying completed actions, and generic errors disappear only after recovery actually queues
- **Prolonged Codex outages** -- Eligible exact pending work continues low-frequency recovery beyond finite reconnect cycles without duplicate execution, persistent retry noise, or unbounded storage

## 2026-08-29

### Added

- **Inline quest feed previews** -- Chat-feed quest links remain direct while compact validated status and same-color eyes open canonical full previews with accessible keyboard and touch behavior plus fail-closed thread routing

### Changed

- **Synchronized session attention** -- Session rows, aggregates, search and cron results, reviewer badges, and hover cards begin sharing one server-authored attention value while detailed notifications and actions remain authoritative
- **Codex collapsed response phases** -- Official nullable Codex phases select collapsed final responses, commentary stays expanded-only, and genuinely unannotated history keeps a conservative fallback without exposing hidden routing or reasoning fields
- **Session navigation projections** -- Lists, groups, hover cards, links, and selected-session surfaces begin sharing bounded server-authored navigation state while established backend actions remain authoritative
- **Leader thread projections** -- Quest tabs begin using synchronized Journey and participant state with semantic phase colors while preserving existing navigation, attention, and first-upgrade migration behavior

### Fixed

- **Sidebar unread propagation** -- Unselected rows, hover cards, and Session Space totals share one server-authored unread summary, so fresh Ready counts reach other browsers before selection while stale or closed attention stays suppressed

## 2026-08-28

### Added

- **Natural explanation guidance** -- Bundled cross-agent guidance favors natural, audience-aware, fresh-reader, concept-first explanations while leaving format and workflow choices to agent judgment and narrower rules
- **Pending attachment slots** -- Explicit message images reserve ordered accessible loading tiles and become previews in place; terminal failures disappear while speculative paths remain silent

### Changed

- **Intent-first quest creation** -- Leaders preserve requested outcomes, confirmed or mandatory constraints, and hard-to-recover evidence without turning unconfirmed ideas or technical plans into binding scope
- **Codex subagent workspace** -- Native child inspection uses the full chat workspace with compact responsive navigation, oldest-to-newest paging, dismissible warnings, and no empty controls for sessions without genuine children
- **Accepted Work handoff** -- Accepted Work and its synchronized commit or explicit no-code evidence appear before mandatory Memory, while stale or missing evidence is blocked
- **Recent and Messages search** -- Universal Search's query-free Recent view shows one latest human message per destination, while scoped Messages preserves every matching message with canonical routing and evidence-backed status
- **Completed waiting tabs** -- Completed quest tabs stay visually active while their authoritative state is Thread Waiting and return to muted when the wait clears or becomes Ready

### Fixed

- **Codex turn settlement** -- Delivered stale owners drain before queued work and reconnect snapshots missing locally observed tools become actionable no-replay interruptions instead of stuck or repeated output
- **Message route restoration** -- Deliberate manual scrolling retires superseded message-route and pending-target ownership so Browser Back no longer snaps to an obsolete search target while fresh links and automatic restoration remain intact
- **Production frontend snapshots** -- Production serves validated app-owned frontend copies and uses application readiness separately from backend liveness, preserving the last good UI when replacement builds or cleanup fail
- **Quest feedback links** -- Canonical feedback links keep stable zero-based targets through reload, browser history, collapsed Journey history, and deletion tombstones
- **Native child feed isolation** -- Ordinary root chat, navigation, searches, reasoning groups, and lifecycle state exclude proven Codex child activity while canonical child audit history remains inspectable

## 2026-08-27

### Added

- **Native Codex subagent inspector** -- A server-owned registry and read-only responsive inspector show genuine child reasoning, messages, tools, results, and errors chronologically with bounded privacy-safe history and fail-closed partial or legacy coverage
- **Shared Markdown math** -- Safe accessible KaTeX rendering for dollar and stored backslash delimiters preserves exact source, copy, selection, malformed fallback, streaming, tables, and local overflow
- **HTML file browser tabs** -- Resolved HTML file links open in native new tabs with scripts and supported relative assets through capability-scoped serving without granting Takode API, session, or generic filesystem authority

### Changed

- **Quest CLI plugin workflow** -- The Codex plugin makes the existing Quest CLI the sole public Quest interface, routes mutations through live Takode authority, preserves managed sessions, and retains focused Todo, Memory, and Lease MCP tools
- **Expanded quest reconciliation** -- Same-quest design-to-build continuations require immediate title, description, and TLDR reconciliation before implementation resumes, with delivery claims gated by synchronized evidence

### Fixed

- **Leader reconnect viewport** -- Lifecycle snapshots and stale-anchor migration preserve the real selected message and offset across reconnects, reloads, and delayed hydration without weakening fresh navigation
- **Queued Codex inputs** -- Text and image messages steer or safely restart at the earliest supported point, with one owner-scoped pending state and safe Retry, Edit, and Cancel actions that prevent replay and starvation

## 2026-08-26

### Added

- **Takode Codex plugin** -- An opt-in plugin packages Takode integration for ordinary Codex tasks while managed Takode sessions retain their existing identity and lifecycle

### Changed

- **Design-to-delivery continuity** -- One intended design-and-build outcome stays in one quest through explicit checkpoint routing, preserves worker-owned closure, and requires delivery evidence before testability claims

### Fixed

- **Passive leader returns** -- Re-entering a leader session preserves the actual selected thread and stable viewport instead of letting stale layout continuity or late hydration switch the user elsewhere
- **Stale Codex recovery owners** -- Automatic-input recovery shows exact-owner testing or active state, retires provider-proven completed owners, preserves held inputs exactly once, and stops stale work from replaying across reconnect or watchdog cycles

## 2026-08-24

### Added

- **Recent asks** -- Universal Search adds a bounded global view of exact human-request bundles with canonical quest links, stable message jumps, compact expandable text, and evidence-backed response status without rendering response bodies

### Changed

- **Voice rerun offers** -- Append-to-edit and edit-to-append reruns share one compact status, action, and dismiss row while preserving the result and same-audio in-memory rerun behavior
- **Evidence-based safety scope** -- Leader and worker guidance preserves access safeguards, requires explicit direction, policy, an approved contract, or payload evidence before fidelity-changing transformations, and requires existing authority or a User Checkpoint for material scope, cost, validation, or acceptance expansion

### Fixed

- **Attached-message chronology** -- Older requests and reasoning attached to a live quest thread retain their canonical position above newer completion, quiz, and Ready content, matching refresh without duplicate tails or viewport jumps
- **Retained quest titles** -- Completed, cancelled, or board-removed leader tabs keep canonical Questmaster titles across tabs, headers, navigation, and hover instead of falling back to repeated IDs

## 2026-08-16

### Changed

- **Transcription Debug loading** -- The newest 15 records load first with older archive pages on demand, and replay transcription selection covers built-in, configured, and source-record models
- **Recurring timer history** -- Contiguous compatible firings of the same unchanged timer compact into one counted expandable row while every real timestamped firing, stable search or deep-link identity, audit detail, and work-trigger boundary remains intact

### Fixed

- **Leader quest tab surfacing** -- Queued or proposed quests reopen their leader tab when work becomes active and stay discoverable through completion or reload, while later manual closes remain respected

## 2026-08-15

### Changed

- **Worker-send activity** -- Collapsed activity labels pure `takode send` invocations as `Sent a message`, while mixed or ambiguous shell commands retain truthful command labels and full expanded detail

## 2026-08-13

### Added

- **Personal to-dos** -- A separate server-authoritative Markdown Todo/Doing/Done outline supports categories, search, active ordering, marker-first completion, date-grouped history, recoverable drafts, reversible archive, and stale-safe UI Undo, with compact CLI access, proposals and grants, and fail-closed mutation authority

### Changed

- **Mobile participant labels** -- Quest banners show full Leader and Worker labels with role icons through 320px while the selected-session TopBar keeps its compact `#N` identity
- **Work recovery authorization** -- Recoverable interruptions resume the remaining approved Work envelope instead of serial micro-handoffs, while genuine approval and safety gates remain unchanged
- **Codex reasoning selection** -- Ordinary controls show one selected effort and confirmed runtime mismatches add a compact warning, while Codex-reported effective effort remains authoritative for validation and targeted CLI or debug diagnostics
- **Leader decision communication** -- Leader decisions and material status updates lead with the problem, impact, recommendation, choices, and requested answer while incidental technical evidence stays in durable records and approval safeguards remain intact
- **Quest Journey colors** -- Active Alignment, Work, User Checkpoint, and Memory phases use distinct cyan, green, amber, and violet styling with accessible light and dark contrast
- **Codex worker multi-agent mode** -- Normal leader-created Codex workers use native multi-agent V2 by default and existing idle workers migrate through a guarded fresh-thread handoff, while leaders, reviewers, manual sessions, and archived sessions remain on V1

### Fixed

- **Copilot request retries** -- Eligible transient stream failures retry quietly with compact progress; successful recovery hides transient errors, while side-effect uncertainty or exhausted retries still fail closed
- **Recovery ownership** -- Leader escalations, repeated board stalls, and retry indicators stay tied to the exact owning turn or occurrence so later activity cannot consume, suppress, or resurrect stale recovery state
- **Collapsed leader responses** -- Substantive replies remain visible when later outcome reminders add empty or low-value rows, without changing Ready collapse, routing, needs-input priority, or expanded audit history
- **Attached thread rendering** -- Historical attached rows no longer flash phantom duplicates after remounts or thread navigation, while authoritative content and position stay unchanged
- **Empty assistant rows** -- Fully post-processed assistant messages no longer leave blank avatar or menu shells, while status footers, raw history, side effects, and visible child UI remain intact
- **Mobile composer focus** -- Narrow-touch session and thread navigation no longer auto-focuses the composer; drafts, explicit taps, and desktop focus behavior remain intact

## 2026-08-12

### Changed

- **Reasoning detail groups** -- Consecutive compatible Codex reasoning summaries collapse into one newest-summary preview with a count, while expansion preserves every original detail and chronology or ownership boundaries

### Fixed

- **Paused-input banner contrast** -- Automatic-input pause and recovery states use theme-aware text, icon, chip, border, and card colors for readable light and dark themes without changing recovery behavior
- **Leader thread outcomes** -- Fresh same-thread leader text, tool activity, or reasoning clears stale Ready/Waiting footers while preserving historical markers, unread state, and unrelated threads
- **Archived session reconciliation** -- Server-confirmed archives disappear promptly and cannot be resurrected by older in-flight active-session snapshots, while later backend state and lazy archived loading remain authoritative

## 2026-08-10

### Added

- **Role-aware session defaults** -- Settings keep separate server-backed defaults for future Leader and Worker sessions while preserving existing per-group creation choices and explicit overrides
- **Session reconnect controls** -- Codex recovery shows up to five process attempts, offers a fresh-cycle Reconnect action, and lets leaders reconnect eligible owned workers without sending task text
- **Codex reasoning details** -- Each official reasoning-summary part is stored and rendered as its own chronological expandable detail, converging live and completed updates without merged or duplicate rows while redundant root-level thinking rows stay hidden

### Changed

- **Composer model controls** -- Codex model selection uses a compact model-and-effort chip with nested Model, Effort, and capability-gated Speed controls, plus Reset to fresh role defaults
- **Codex Goal browser surface** -- The Session Info Goal editor and browser `/goal` shortcut are removed while backend and CLI Goal state remain available for automatic continuation
- **Alignment and herd context** -- Routine Alignment completion uses normal turn completion instead of an approval prompt, and structured preload or recovery bodies are bounded before leader-model injection while audit history remains available
- **Long tool activity summaries** -- Large collapsed Bash or MCP groups switch to a stable `N tool calls` label while expanded audit detail and smaller descriptive summaries remain intact

### Fixed

- **Passive disconnected sessions** -- Post-restart viewing shows a quiet recoverable-disconnected state instead of a false startup spinner without waking the backend
- **Provider recovery** -- Temporary Copilot authentication or network failures use bounded refresh and replay only provably side-effect-free turns, while unsupported models remain terminal and Claude interruption diagnostics stay out of conversation history
- **Leader activity ownership** -- An idle leader no longer inherits a running worker's route or timer in its activity chip
- **Codex stale delivery replay** -- Already-processed user and mixed herd or system payloads cannot be automatically re-delivered as fresh turns when provider or local model activity proves ownership, while genuinely undelivered user-only work still recovers
- **Cached leader thread refresh** -- Reopening a cached leader tab revalidates its authoritative window so routed worker events and leader responses cannot remain hidden in stale almost-empty history

## 2026-08-08

### Added

- **Direct worker errands** -- Leaders can route one-turn, context-rich, read-only follow-ups directly to an existing worker, while broader or stateful work fails closed to a normal quest

### Changed

- **Browsed-window reconnects** -- Capable browsers reconnect with only the bounded server-authored conversation window currently being viewed instead of passively catching up entire session histories

### Fixed

- **Leader viewport restoration** -- Saved message anchors and routed quest-thread positions survive cold hydration and tab changes, including off-window targets
- **Work Board reminder freshness** -- Delayed dispatchable reminders are tied to the live board-row revision and suppressed when the underlying wait has already changed or cleared

## 2026-08-07

### Changed

- **Selected conversation loading** -- Cold leader startup prioritizes the selected authoritative window before tree, replay, and snapshot work so mobile content appears sooner without sacrificing paging or tool-result closure

## 2026-08-06

### Changed

- **Message timestamp menus** -- Exact message times are available from the existing message menu while rail dots and stars retain their normal navigation and starring behavior
- **Herd event activity** -- Routine non-decision and board-stalled events collapse into compact worker activity while meaningful decisions and complete audit detail remain visible
- **Leader turn summaries** -- Ready leader turns auto-collapse immediately while preserving status-bearing final prose, hiding model-only reminder acknowledgements, and retaining manual expansion

### Fixed

- **Restart continuation context** -- Ordinary restart continuation stays a concise `Continue.` instead of reinjecting the Memory catalog, while new sessions and real compaction or recycle recovery still preload it
- **Completed quest queue banners** -- Completed Journey rows no longer retain stale queued-worker or free-worker wait status, while genuine active and needs-input waits remain visible

## 2026-08-05

### Added

- **Alternate voice reruns** -- A completed voice result can be rerun in append or voice-edit mode using the active in-memory audio without recording again

### Changed

- **Worker reclamation safety** -- Leader guidance treats clean behind-only worktrees as safely replaceable while preserving dirty or genuinely ahead workers and requiring fresh target-ref checks

### Fixed

- **Journey participant projection** -- Active and completed rows for the same quest no longer leave stale worker or reviewer state, and unsynced tracked work remains in Work until its evidence is settled

## 2026-08-04

### Added

- **Audited quest recovery** -- Owning leaders have a reason-required, server-authenticated fallback for exceptional stuck quest completion while normal worker completion remains the preferred path
- **External dependency wakeups** -- Leaders receive targeted board reminders when external session or quest blockers resolve, with cleared dependencies removed from the waiting row

### Changed

- **Leader and worker handoffs** -- Post-Alignment Work dispatches carry only leader-owned deltas, implementation follow-ups prefer the context-rich worker or accepted evidence, and workers report at meaningful milestones
- **Self-contained quest context** -- Refined quest records carry concise standalone background and true follow-up differences instead of depending on linked history for essential context

### Fixed

- **Leader quest tab titles** -- Quest tabs preserve their real Questmaster titles instead of degrading into repeated quest IDs
- **Memory completion Git refresh** -- Final Memory refreshes worker Git state through the server-owned path so completion sees current sync state without weakening identity checks
- **Needs-input decision panels** -- The owning thread again shows the real question, choices, custom reply field, supported voice input, and authoritative loading or retry state

## 2026-08-03

### Added

- **Codex leader compaction mode** -- Leaders can opt into Codex built-in compaction while Takode recycling remains the default and delegation stays available in either mode
- **Sessionless Takode inspection** -- Ordinary Codex contexts can read session and history state without a session identity while invalid authentication, mutations, and unrelated protected operations remain rejected
- **Compact tool activity** -- A Settings option condenses consecutive passive tool calls into categorized expandable summaries while keeping notification and approval interactions visible

### Changed

- **Quest Journey v2** -- New work uses Alignment, Work, and final Memory with User Checkpoint as a Work pause, while legacy Journey history stays readable and completion requires clean synchronized evidence
- **Checkpoint shortcut prompts** -- Notification shortcuts must be explained in the visible decision packet before they are offered, preserving exact-approval safety

### Fixed

- **Completed tool-result closure** -- Visible completed tools receive their latest matching result preview before optional support trimming so historical commands do not reappear as live during later turns

## 2026-08-02

### Added

- **Relay supervision tooling** -- An opt-in monitor-free direct-SSH supervisor package provides transactional ownership, bounded private events, trusted retries, and stale-proof readiness evidence while activation remains separately controlled

### Changed

- **Browser title attention count** -- The tab-title number represents only active unresolved and unmuted needs-input prompts across non-archived sessions, independent of other in-app attention indicators

## 2026-08-01

### Added

- **Quest reviewer identity** -- Leader quest banners show the authoritative Reviewer beside the Worker and keep that identity current through lifecycle refreshes

### Changed

- **Automatic recovery guidance** -- Recovery banners explain the sanitized cause, original pause time, required direct action, and eventual held-input outcome consistently across browsers

### Fixed

- **Historical Journey routes** -- Legitimate completed Explore-to-Implement history remains valid across later board operations while malformed phase data fails closed before provenance can be rewritten
- **Large conversation restoration** -- Mobile and desktop sessions restore through compact authoritative projections and bounded visible windows instead of showing a false-empty Main view

## 2026-07-31

### Added

- **Held-input recovery receipts** -- Automatic-pause recovery keeps durable, sanitized, exact-once outcome records across retry, restart, and ownership handoff, with bounded searchable history and no payload disclosure

### Changed

- **Edit-and-approve checkpoints** -- One fresh reply may make one exact substitution and approve the resulting packet only when every unchanged term and consequence remains unambiguous; all broader edits require a revised packet

## 2026-07-30

### Changed

- **Inbound handoff markers** -- Destination quest feeds hide redundant inbound transition rows while source threads retain the outbound breadcrumb and All Threads keeps the complete audit
- **Raw protocol recording** -- Automatic Claude, Codex, and browser payload capture is off by default while explicit environment opt-in, manual per-session capture, and existing-file inspection remain available
- **Model migration notices** -- Legacy model-identity warnings can be acknowledged across browsers and restarts without erasing audit history, and stale acknowledgements cannot hide a newer event

## 2026-07-29

### Changed

- **Replay comparison layout** -- Transcription Replay & compare starts collapsed while Raw Transcript stays visible and comparison details remain accessible on demand

### Fixed

- **Managed model identity** -- Codex routing fails closed when the selected model cannot be proven, preventing silent drift or fallback while retaining one-time legacy migration provenance

## 2026-07-28

### Added

- **GPT Transcribe voice model** -- New voice-transcription settings default to `gpt-transcribe` with bounded vocabulary and expected-language hints while preserving older and custom model compatibility
- **Transcription replay comparisons** -- Transcription Detail can re-run stored audio or raw transcripts against selected models, save comparison variants, and rediscover a privacy-bounded recording archive after restart
- **Transcription record previews** -- Transcription Debug rows show bounded single-line enhanced-first or raw-fallback excerpts, while unsafe and non-ready records remain preview-free
- **Replay difference highlighting** -- Re-transcribe and re-enhance comparisons highlight stage-correct text changes with readable bounded fallbacks for long inputs

### Changed

- **Composer and Questmaster density** -- The composer condenses model controls into one chip and removes branch/diff metadata, while the compact quest table drops its User review checks column
- **Expected language picker** -- Selected language hints remain visible while the searchable picker stays collapsed until requested

### Fixed

- **Session unread consistency** -- Compact lists, live updates, and selection hydration share one server-authored notification projection so read or closed-thread alerts cannot inflate counts while legitimate unread stays visible
- **Copilot authentication exhaustion** -- Codex sessions pause automatic inputs after a strictly recognized terminal API-key refresh failure while preserving manual recovery and exact-once backlog drain

## 2026-07-27

### Changed

- **Delegate task results** -- Delegate traces group Bash commands with their results, lead with the child summary, and separate task, timing, and inspection metadata from result content

### Fixed

- **Delegate task context** -- Native-fork delegates resume the expected inherited Codex context, fail closed instead of silently starting fresh, and keep pending handoff state accurate
- **Backend startup labels** -- Session creation shows launch progress for Codex, Claude Code, or Claude SDK according to the selected backend
- **Leader route splits** -- Thread routing recognizes split markers even when blank spacer lines surround them

## 2026-07-26

### Changed

- **Delegate task contract** -- The command-only delegation tool is now the general `delegate_task(task)` workflow while retaining hidden child evidence, lifecycle safeguards, and compact parent results

### Fixed

- **Codex startup recovery** -- Queued work waits for initializing or resuming adapters to become ready instead of relaunching them prematurely, and internal initialization turn-end rows stay out of leader activity

## 2026-07-25

### Added

- **Quest commit diffs** -- Leader quest tabs can open quest-recorded code commits with selected-first loading, clear zero-code states, and protection from stale background failures

### Changed

- **Message dates** -- Message timestamps stay time-only today and add compact yesterday, current-year, or prior-year date context for older history
- **Quest Journey details** -- Long phase histories are grouped and windowed so current runs stay readable while older notes remain accessible

### Fixed

- **Delegate child lifecycle** -- Completed hidden delegates leave active session lists without losing UUID-backed transcript inspection

## 2026-07-24

### Changed

- **Post-Explore routing** -- Leaders can revise a completed Explore directly to a clear low-risk Implement step while required User Checkpoints and later safeguards remain protected
- **Light theme contrast** -- Chat, quest links, attention rows, and related light-theme surfaces have clearer text and state contrast

## 2026-07-23

### Added

- **Delegated work** -- Leaders can fork bounded work into a hidden Codex child, keep raw evidence in the child transcript, and receive a compact inspectable parent result

### Changed

- **Bash result visibility** -- Codex Bash cards prefer fuller matching output, mark embedded newlines in collapsed previews, and bound retained raw output
- **Injected event details** -- Injected events show payload size metadata, and memory-catalog snapshots can be copied from their feed rows

### Fixed

- **Thread routing boundaries** -- Mid-message route splits, deep-link scroll targets, and stale ready-status chips resolve to the intended thread without repeated navigation
- **Codex tool readiness** -- Startup and delegated-child prompts wait for refreshed MCP tools and an actual callable handoff tool before proceeding

## 2026-07-22

### Added

- **Memory catalog startup context** -- Leader startup and recovery receive a visible catalog snapshot so relevant durable memory can be inspected before work continues

### Changed

- **Leader tab selection** -- Relevant quest tabs can surface in the background without automatically replacing the leader's selected thread

### Fixed

- **Thread-aware message links** -- Session and message links select the intended thread before jumping to their target
- **Codex shell environment** -- Session-scoped Codex shell tools preserve the configured home directory and its isolated session state

## 2026-07-21

### Added

- **Journey revisions** -- `takode board revise` can replace an active Journey suffix while preserving completed phase history and validating required safeguards

### Changed

- **Board proposals** -- `takode board propose --summary` creates and presents one expanded approval packet with Journey and dependency context

### Fixed

- **Thread continuation links** -- Continuation markers keep their session and quest links when rendered in collapsed feed history

## 2026-07-20

### Added

- **Questmaster local backups** -- Quest and Journey text gains retained local snapshots and mutation journals, with separately deduplicated image blobs and manual restore guidance

### Fixed

- **Needs-input retries** -- Notification retries anchor to visible prompts, deduplicate only exact active retries, and report recovered notification state more accurately
- **Quest hover previews** -- Quest links validate cached preview metadata before rendering so stale summaries do not appear under the wrong quest

## 2026-07-17

### Changed

- **Leader ready outcomes** -- Leader workflows verify promised durable actions before marking a thread Ready

### Fixed

- **All Threads status noise** -- Internal thread-status chips stay out of the combined All Threads feed

## 2026-07-15

### Changed

- **Quest reference autocomplete** -- Composer quest references use the full authoritative candidate set instead of only the currently loaded quest page

### Fixed

- **Message navigator jumps** -- User-message navigation loads off-window targets before scrolling to them
- **Internal status rows** -- Codex retry turn-end events and Thread Ready bookkeeping stay out of the visible conversation feed

## 2026-07-14

### Added

- **Leader skill preloading** -- Leader sessions preload required orchestration skills during startup and recovery so recycled or resumed leaders regain Journey guidance more reliably

### Changed

- **Needs-input suggestions** -- Needs-input prompts can carry more short suggested answers, with guidance updated to keep choices useful without an arbitrary cap
- **Checkpoint approval guidance** -- Leader and checkpoint instructions distinguish actual user decisions from corrections more explicitly before continuing work
- **Leader work summaries** -- Session summaries show waiting counts, and newly started Journeys receive clearer attention treatment

### Fixed

- **Leader preload recovery reminders** -- Recovery reminders avoid false compaction signals during resume replay and point leaders back to preload state more accurately
- **Quest Quiz directives** -- Inline quiz directives render after their quest details arrive instead of remaining unresolved in fetched history

## 2026-07-13

### Changed

- **Quest Journey routing** -- Leaders can use lighter direct dispatch for low-risk tasks, and Outcome Review is optional when the approved Journey does not need a separate acceptance pass
- **Codex launch defaults** -- Codex catalog handling disables unsupported Responses Lite options for MAI LiteLLM catalogs and gives non-leader sessions a safer auto-compact default

### Fixed

- **Quest link previews** -- Quest links show hover previews more reliably
- **Codex model switching** -- Model changes, relaunches, leader context preservation, failed compaction recovery, and recycle watermarks recover more reliably without duplicate migration loops
- **Archived session recovery** -- Archived-session relaunch and partial archive-group failures reconcile UI and server state more consistently

## 2026-07-11

### Changed

- **Codex model catalog** -- Model pickers include refreshed Codex options and runtime-setting updates, with future reasoning parameters preserved for compatible models

## 2026-07-09

### Changed

- **Archived session browsing** -- Archived sessions load in pages and open in read-only views so large archives are lighter and safer to browse

### Fixed

- **Configure Session context capacity** -- Configure Session and session info surfaces show context capacity more accurately for Codex sessions

## 2026-07-08

### Added

- **Notification row actions** -- Notification rows expose per-session actions from notification chip surfaces
- **Questmaster preview loading** -- Quest lists, hover cards, and detail panels can load compact previews before hydrating full quest records

### Fixed

- **Leader tool routing** -- Unthreaded or mixed leader tool/result rows route to the most recent relevant thread more consistently
- **Mixed tool result previews** -- Assistant messages can render mixed tool-result previews without losing surrounding context
- **Quest detail caching** -- Partial quest detail loads preserve summaries and avoid stale detail-cache state

## 2026-07-07

### Added

- **Session directory opening** -- Session info surfaces can open session directories in the local file browser

### Fixed

- **Archived worktree cleanup** -- Archived worktree cleanup retries and retry rows reconcile branch deletion failures more reliably

## 2026-07-06

### Fixed

- **Archive reconciliation** -- Sidebar archive mutations and reviewer archive markers roll back or reconcile more safely when archive operations fail

## 2026-07-02

### Changed

- **Quest Quiz guidance** -- Completion guidance makes quiz questions more useful and better grounded in agent-discovered outcomes

### Fixed

- **Thread route splitting** -- Post-quiz routes, split thread routes, and ready-thread unread views avoid cumulative append and stale read-state issues

## 2026-07-01

### Changed

- **Pushover prompts** -- Pushover input prompts use a clearer title

### Fixed

- **Reviewer sidebar chips** -- Reviewer labels fit and render consistently in sidebar chips
- **Diff syntax highlighting** -- Unified diff panels highlight syntax more reliably
- **Leader thread tabs** -- Completed leader thread tabs, active Work Board tab ordering, and ready-thread unread markers persist more predictably

## 2026-06-30

### Changed

- **Leader dispatch guidance** -- Dispatch references and generated instructions are shorter and clearer for leader workers
- **Session info context stats** -- Session hover cards and info popovers group context statistics more clearly

### Fixed

- **Quest Quiz links** -- Quest IDs in inline quiz cards link to their quest detail previews
- **Message navigation controls** -- Feed navigation controls sit higher and avoid covering surrounding controls
- **Thread-scoped pending delivery** -- Pending-delivery state stays scoped to the relevant thread tabs
- **Leader worktree port metadata** -- Spawn and port metadata carries worktree context more reliably for leader-managed ports

## 2026-06-29

### Added

- **Session configuration** -- Existing sessions can be reconfigured from session menus and info surfaces, with live backend updates when supported
- **Starred messages** -- Chat messages can be starred from message actions, searched globally, and shown with compact feed-rail markers for easier follow-up

### Changed

- **Context diagnostics CLI** -- Context diagnostics focus on `takode scan --context` and `takode peek --context`, with misleading standalone command references removed
- **Codex context display** -- Codex context window displays use clearer capacity wording across configuration, hover, info, and settings surfaces

### Fixed

- **Message link navigation** -- Links to specific chat messages load the targeted feed window, preserve main-thread routes, and highlight the jump target after navigation
- **Configure Session state** -- Reconfiguration state, live update detection, and modal placement stay consistent across sidebar, top-bar, and session-info entry points
- **Session status indicators** -- Session status dots stay visible on hover, and hover cards match the sidebar marker state more consistently
- **Starred message controls** -- Star actions avoid temporary fallback message IDs, and starred markers stay out of the main message content area
- **Unread session attention** -- Session attention indicators avoid stale unread state after notification updates

## 2026-06-28

### Added

- **Context diagnostics** -- `takode scan --context` and `takode peek --context` expose reported usage and bounded payload navigation hints for leader context-health debugging
- **Muted needs-input notifications** -- Needs-input prompts can be muted while preserving visible inbox and navigation state for unresolved items

### Changed

- **Quest CLI summaries** -- `quest show` output is more compact by default while keeping reveal paths for full descriptions, metadata, and phase notes
- **Prompt guardrails** -- Session instructions now make durable-name constraints clearer for quest IDs in code, commits, artifacts, and other lasting names

### Fixed

- **Chat feed stability** -- Feed restores, Markdown renders, diff tabs, duplicate transitions, and hidden feed panes avoid redundant updates that could cause jank or loops
- **Leader quest tabs** -- Automatic tab promotion no longer loops when active quest or needs-input routing changes
- **Leader review markers** -- Review summary markers from closed tabs are filtered and guarded so session rows stay focused on active review state
- **Muted needs-input indicators** -- Muted prompts keep sidebar, Work Board, and global notification indicators consistent with their muted state

## 2026-06-27

### Fixed

- **User message navigator** -- Mobile navigator controls stay within the viewport and no longer cover surrounding chat controls
- **Context default display** -- Session hover cards, info popovers, and Settings show effective max-context defaults more accurately

## 2026-06-26

### Added

- **Session defaults** -- Settings can define default backend, model, permission, and context values for new sessions, with CLI and browser creation paths applying them consistently

### Fixed

- **New Session defaults** -- The New Session modal preserves default precedence, including Claude permission override defaults
- **User message navigator** -- The navigator centers on the current user message and respects the active thread scope
- **Needs-input quest tabs** -- Leader quest tabs promote needs-input notifications into view more reliably
- **Leader recycle labels** -- Recycled leader sessions keep useful session-number fallback labels when recovery metadata is thin

## 2026-06-25

### Added

- **User message navigator** -- Chat feeds can jump between user messages for faster conversation review

### Changed

- **Quest Quiz readability** -- Quest detail now places Quiz before TLDR, revealed answers match question sizing in full/detail contexts, and quiz guidance distinguishes human active recall from future-agent memory
- **Session list loading** -- Sidebar and related session surfaces load lighter list payloads while preserving detail hydration for selected sessions

### Fixed

- **Archived sessions** -- Archived-session list rework keeps sidebar and task-panel behavior stable
- **Leader recycle recovery** -- Interrupted direct leader work after recycle is surfaced more clearly, and recovery scan prompts are more robust
- **Composer send animation** -- Send-button animation timers clean up when the composer unmounts

## 2026-06-24

### Changed

- **Quest Quiz completion directive** -- Leader completion summaries can render a quest quiz inline with the standalone `{[(Quest Quiz: q-N)]}` directive, while directive-shaped text in code blocks stays literal

## 2026-06-23

### Added

- **Quest Quiz metadata** -- Quests can store active-recall Q/A metadata with CLI/API read-write paths and hidden-answer quiz UI in completion and Quest detail surfaces

### Changed

- **Generated quest skill docs** -- Detailed final-Memory and completion mechanics now live in an on-demand generated subfile so leaders keep essential quest guidance with less recovery context
- **Leader proposal guidance** -- Quest and dispatch proposals now read more like concise approval TLDRs while detailed grounding stays in the quest record

### Fixed

- **Active quest tabs** -- Newly active leader quest rows, including manually created idea quests, surface into the leftmost visible quest-tab slot while preserving overflow behavior
- **Tool result size labels** -- Expanded result blocks keep one compact `output bytes: N` label visible and avoid repeating size text in the `Show full result` action

## 2026-06-22

### Fixed

- **Codex Web Search details** -- Web Search tool cards render useful query and URL details across raw `web_search_call`, older `webSearch`, and progressive same-id updates, including multi-query actions
- **UI test stability** -- Aggregate Playground, UniversalSearch, and Questmaster test flakes were stabilized without deleting coverage

## 2026-06-18

### Added

- **Chat line height setting** -- Settings can adjust server-backed chat message line height for denser or airier Markdown message text
- **Codex pending delivery diagnostics** -- `takode info` and recovery state now expose Codex pending-delivery diagnostics for debugging stuck or recoverable turns

### Fixed

- **Codex herd input recovery** -- Stale Codex pending-delivery state is poked when herd inputs arrive so queued leader or board input can recover more reliably

## 2026-06-10

### Changed

- **Codex leader recycle prompts** -- Recycled leader sessions now receive cleaner recovery instructions with concise session-number Takode commands, no trigger or active-thread diagnostics in the model-facing prompt, and internal routing preserved for the injected recovery message

### Fixed

- **Empty session history** -- Sessions with delivered empty history no longer re-enter a loading state when reselected or reconnected after the server sends its authoritative snapshot
- **Worker activity status** -- Worker chat status stays neutral during direct worker turns instead of showing stale or noisy quest labels

## 2026-06-09

### Changed

- **Leader proposal guidance** -- Quest and dispatch approval guidance now favors compact decision packets for simple requests while keeping detailed worker grounding in the quest record

### Fixed

- **Codex worker recovery** -- Connected Codex workers interrupted by stuck-watchdog recovery now surface a recovery-pending state while a recoverable backend turn can still finish
- **Codex leader recycling** -- Recycled leader sessions restore the one-shot recovery prompt path for recovering context without relying on embedded transcript snippets

## 2026-06-08

### Changed

- **Leader composer destination hints** -- Desktop leader quest tabs now show a placeholder destination cue such as `Posting to q-1498 ...` while Main Thread, mobile/narrow, and non-leader composers keep the generic placeholder
- **Side Chat action controls** -- Assistant-message Side Chat, reply, and copy actions now sit behind a compact first-line `Message options` trigger that appears on desktop hover or focus and remains usable on touch devices
- **Timer visibility** -- Session lists, hover cards, Work Board rows, and the top bar now show timer status more consistently across shared session surfaces

### Fixed

- **Side Chat status** -- Side Chat panels show clearer lifecycle and send-state feedback, with native-unavailable reasons and replay confirmation kept visible without disrupting layout
- **Codex recovery and recycling** -- Active-turn steering, leader recycle interruptions, recycle boundary markers, and recycled-session labels recover and display more reliably
- **Work Board tabs** -- Closing a Work Board row keeps neighboring tabs open more predictably
- **Quest session-space evidence** -- Quests now persist session-space metadata with explicit overrides and centralized legacy fallback, so memory commit evidence resolves against the right session space more consistently

## 2026-06-05

### Changed

- **Leader prompt guidance** -- Leader needs-input prompts and routing reminders now keep the full decision context in the visible thread before notifying the user
- **Codex leader budgeting** -- Codex leader display budgets are kept separate from provider limits so leader context status is clearer

### Fixed

- **Side Chat fallback safety** -- Side Chat replay is gated behind explicit confirmation, and native-unavailable reasons stay visible when fallback replay is offered
- **Dispatch-ready advisories** -- Non-blocking Work Board dispatch nudges no longer use user-blocking needs-input notifications
- **Codex oversized-turn recovery** -- Oversized turn starts and pending inputs recover more safely instead of dropping or duplicating queued work

## 2026-06-04

### Added

- **Side Chat** -- Worker-session assistant messages can open focused Side Chat sessions for follow-up work while keeping the original conversation intact. Thanks @mike-meow for introducing the feature
- **Native Side Chat forks** -- Side Chat can use native backend fork support when available instead of relying only on replay-style context

### Changed

- **Side Chat naming** -- Slack-thread surfaces are now named Side Chat while preserving compatibility aliases for existing saved data and routes
- **Scoped leader waits** -- Leader waits and reminders are scoped more clearly to the thread, quest, or board row they actually block

### Fixed

- **Codex startup metadata** -- Codex startup retries refresh skill metadata more reliably
- **Leader approval notifications** -- Leader approval prompts are paired with the required user notification instead of silently waiting

## 2026-06-02

### Fixed

- **Disconnected session settings** -- Session setting edits can be made while a backend is disconnected and applied once the session is reachable again

## 2026-06-01

### Added

- **Codex service tier control** -- Codex sessions can choose service-tier speed behavior, with fallback state preserved when a selected tier is unavailable

### Changed

- **Leader worktree porting** -- Leader-created and replacement worker sessions keep target worktree context more reliably, and port branch checks run in a safer order

### Fixed

- **Codex leader launch guards** -- Codex leader launches preserve guard checks and context-budget safeguards more consistently
- **Safari voice recording** -- Voice recording uploads from Safari are chunked more reliably for transcription
- **Worktree leader alignment** -- Worktree leader notifications and workspace alignment behave more consistently before port operations

## 2026-05-28

### Changed

- **Codex leader recycling** -- Codex leader recycle thresholds now derive from source effective context with fixed headroom, and normal leader budget and per-model override controls are hidden
- **Codex non-leader compaction** -- Non-leader Codex sessions now rely on Codex default auto-compaction while preserving legacy settings/API compatibility and user-owned Codex config

### Fixed

- **Quest worker context** -- Board/Journey-assigned workers and reviewers now show quest banner context even when Questmaster ownership remains with another session, with stale task-history chips hidden where the banner is authoritative
- **Worker replacement display** -- Quest headers and worker chips follow the current Work Board/Journey worker after replacement, and replacement spawn updates matching active board rows or prints compact board-update guidance
- **Leader hover active quests** -- Leader hover cards hydrate exact active board rows from server snapshots and live updates, restoring active quest lists consistently across leader sessions

## 2026-05-27

### Fixed

- **Codex session catalogs** -- Session-local Codex model catalogs can synthesize or repair parser-safe selected model entries when cache data is missing or minimal
- **Session location after restart** -- Restored sessions preserve Session Space, memory-space, and leader open-tab metadata more reliably, with stale default Session Space state reconciled during list hydration
- **Quest commit diff modal** -- Quest commit diff modals keep a stable full-available footprint while switching commits, including loading, error, and unavailable states
- **Work Board tab hover** -- Work Board tab close-hover states avoid width drift

## 2026-05-26

### Added

- **Quest feedback controls** -- Quest Detail can delete user feedback, labels user-authored feedback as `user`, and shows session-submitted feedback as `on behalf of user`
- **Composer shortcut tooltip** -- The send button tooltip now shows both send and newline shortcuts while preserving the accessible `Send message` action name

### Fixed

- **Delayed Pushover cancellation** -- Resolved needs-input prompts now cancel only their own scheduled delayed Pushover push while other unresolved prompts remain scheduled
- **Needs-input resolution chips** -- Needs-input resolution notices render as collapsed special-message chips with concise expanded context and the duplicate-resolution warning preserved
- **Codex instruction isolation** -- Takode session developer instructions stay in per-session Codex homes instead of leaking into host/global Codex config
- **Codex spawn prep stalls** -- Repeated Codex worker spawn/replacement prep avoids unnecessary DotSlash scans and unchanged legacy skill migration work
- **Relaunch stale PID handling** -- Relaunch treats untracked persisted PIDs as best-effort cleanup only, preserving graceful escalation for tracked live subprocesses

### Changed

- **Takode CI policy** -- GitHub Actions now follows the repository's pinned Bun, frozen install, and no-install script execution policy

## 2026-05-25

### Added

- **Transcription debug recordings** -- Transcription debug mode can persist per-request recording folders with audio, prompts, results, timing, failure artifacts, and copy/open/delete controls

### Changed

- **Work Board tool-call chips** -- Collapsed Work Board tool calls now look like terminal command chips, show the raw `takode board ...` command, and keep raw/graphical toggles inside expanded content
- **Memory entry defaults** -- Opening Memory now defaults to the last viewed session's available session-space root while preserving manual cross-space selection inside Memory
- **Quest commit display** -- Quest Detail uses a collapsed-by-default `Commits` section that shows only the commit count until expanded

### Fixed

- **Completed quest board cleanup** -- Done quests, including rows stuck at Memory, leave active Work Board state while unfinished Memory rows remain active
- **Repeated error cards** -- Visually consecutive identical chat error cards group together even across hidden feed markers while visible separators still split groups
- **Quote selection cleanup** -- Quoted chat selections trim leading and trailing blank-line edges while preserving internal blank lines
- **Quest commit modal spacing** -- Quest commit diff modal headers and content spacing are tighter and more stable

## 2026-05-23

### Added

- **Sidebar changelog entry point** -- The sidebar build label now opens the in-app changelog viewer alongside the Settings entry point

### Fixed

- **Codex backend error auto-pause** -- Repeated classified Codex backend result errors now pause and coalesce automatic inputs while keeping manual recovery paths available
- **Codex auto-pause recovery** -- Queued Codex backlog and browser-origin pending inputs are swept safely during auto-pause and drained exactly once after manual success
- **Repeated error card grouping** -- Consecutive identical chat error cards collapse into counted cards without changing backend recovery behavior

### Changed

- **Takode-only changelog history** -- The active changelog now stops at the Takode `2026-04-10` baseline instead of rendering inherited upstream Companion releases

## 2026-05-22

### Added

- **Quest commit evidence** -- Quest Detail can show readable code and memory commit evidence, with commit diff access from the quest surface

### Fixed

- **Recoverable disconnects** -- Recoverable backend disconnects now appear as quieter feed and Session Info status controls with Resume/Retry actions
- **Codex queued input wakeups** -- Disconnected Codex sessions now wake for queued model-bound inputs, including leader herd events and board-stall warnings
- **Needs-input resolution delivery** -- Externally resolved needs-input notifications are delivered as deferred, model-visible notices on the next eligible direct message
- **Voice transcription context** -- Thread-scoped transcription now keeps useful older Main-thread context when recent activity is mostly tool or system noise
- **Global needs-input navigation** -- Needs-input menus include clearer destination controls and dismiss large overlays when navigation would otherwise be obscured
- **Blocking UI navigation** -- Quest and session navigation actions dismiss blocking overlays when the target session or quest is opened
- **Diff viewer stability** -- Full diff views preserve horizontal scrolling and render expanded unchanged lines without blank gaps
- **Mobile chat controls** -- Mobile thread status chips, collapsed composer controls, and chat-feed spacing fit more cleanly on narrow screens
- **Leader quest diffs** -- Leader quest tabs open the associated worker diff instead of defaulting to the leader worktree when a worker target is available

### Changed

- **Leader proposal guidance** -- Leader proposal instructions now keep chat approval surfaces concise while detailed worker grounding stays in the quest record

## 2026-05-21

### Added

- **Server-backed shortcut settings** -- Keyboard shortcut settings now persist through the server, migrate from legacy browser storage, and keep the standard search shortcut clear of browser find
- **Leader hover active quests** -- Leader session hover cards now show active quest rows and phase labels for faster orchestration triage

### Fixed

- **Needs-input voice retry** -- Failed needs-input voice answers keep their recording context and offer a compact retry/dismiss path
- **Global needs-input menu** -- Cross-session needs-input details are easier to read and stale cached notifications are reconciled before prompts stay visible
- **Leader quest tabs** -- Leader quest-thread tabs preserve order during route repair, active-row updates, and repeated route processing
- **Queued wait status** -- Active thread banners integrate queued wait status more consistently
- **Mobile feed stability** -- Mobile chat feed and Work Board overflow animations avoid layout jumps
- **Codex launch reliability** -- Codex launch and relaunch paths preserve preflight checks, timing, and intentional-relaunch state more consistently

### Changed

- **Quest Journey guardrails** -- Board and Journey tooling now enforces User Checkpoint skip rules and makes Memory, source, and TLDR handoff guidance clearer

## 2026-05-20

### Added

- **Sidebar Session Space controls** -- Sidebar Session Spaces can show configurable session counts with a "more" overflow control, and Universal Search can find sessions directly
- **Changelog viewer** -- Settings can open the repository changelog in-app from the server diagnostics section

### Fixed

- **Worker file-link routing** -- Worker file links are resolved before phase handoff text is shown to users
- **Quest Journey lifecycle rows** -- Quest tabs show Journey started and completed lifecycle rows in the owner thread
- **Quest thread wait banners** -- Quest thread banners show board wait targets, including queued sessions, quests, and user-input references
- **Server restart recovery** -- Restart recovery now reconnects sessions on demand when queued work or backend delivery needs a backend
- **Image file-link previews** -- Markdown image file links now render previews by default
- **Review and outcome notifications** -- Review notifications stay scoped to the correct tab, multi-quest review tabs clear more reliably, and thread outcome reminders preserve needs-input state
- **Codex leader recovery diagnostics** -- Exhausted Codex leader recovery now surfaces a clearer failure state instead of disappearing into generic recovery noise

### Changed

- **Landing page cleanup** -- The obsolete standalone landing site was removed from the app repository
- **Dependency security** -- The Anthropic SDK dependency was updated to remediate its advisory
- **Memory catalog output** -- `memory catalog show` output is more compact and separated for faster scanning

## 2026-05-19

### Added

- **Voice answers for needs-input** -- Needs-input prompts can be answered with voice input, including recording state and transcription progress feedback

### Fixed

- **Voice transcription delivery** -- Voice results are delivered over WebSocket more reliably, lightbox Escape no longer triggers voice shortcuts, and transcription completion state is clearer
- **Work Board stability** -- Completed quest history is preserved during cleanup, stale done rows are cleared, worker feed boundaries stay scoped, and tab hover geometry is steadier
- **Memory browsing and defaults** -- Memory spaces are backfilled for existing sessions, default routing is more consistent, and diff panes scroll horizontally

### Changed

- **Quest review checkpoints** -- User review checks and memory handoff wording are clearer across Journey phases

## 2026-05-18

### Fixed

- **Notification routing** -- Needs-input notifications keep thread ownership and fallback route inference more reliably
- **Terminal file previews** -- File-read tool previews in terminal output are easier to inspect
- **Codex orphan diagnostics** -- Orphaned custom-tool output is classified and preserved so multi-call failures are easier to recover

## 2026-05-17

### Fixed

- **Universal search event results** -- Universal Search handles event-style results more reliably
- **Offline composer tools** -- Local composer tools remain available while a session is disconnected
- **Thread status display** -- Thread status chips sit in the turn footer with tighter spacing and more reliable collapse behavior
- **Session recovery and navigation** -- Queued sends survive disconnects, startup recovery suppression has a fallback, and navigation can load older target messages
- **Needs-input attention counts** -- Sidebar and document-title needs-input counts stay aligned

## 2026-05-15

### Fixed

- **Codex resume behavior** -- User-only resume turns retry after stale disconnects, and merely opening a browser no longer triggers passive recovery
- **Memory session defaults** -- Memory defaults follow the session group more consistently when sessions are created or replaced

## 2026-05-13

### Fixed

- **Theme contrast** -- Notification chips, Quest panels, Work Board rows, and dense dark-theme surfaces have stronger contrast
- **Codex recovery limits** -- Adapter recovery limits are clearer when a recovery path is exhausted

## 2026-05-12

### Fixed

- **Work Board tab hover** -- Thread tabs stay stable when hovered
- **Needs-input collapsed previews** -- Collapsed feed previews show needs-input context more clearly

## 2026-05-11

### Added

- **Memory update diffs** -- The Memory view can inspect recent committed memory updates with file lists and inline diffs

### Changed

- **README orchestration overview** -- The README now leads with Takode orchestration, Quest Journeys, Memory, direct sessions, integrations, and updated product screenshots

### Fixed

- **Memory view chrome** -- Memory navigation and layout controls are cleaner, including a clearer sidebar icon
- **Memory session-space defaults** -- Memory CLI, spawned sessions, and replacement sessions resolve session-space defaults more consistently
- **Codex pending-turn recovery** -- Pending Codex turns recover more reliably after interrupted refreshes

## 2026-05-10

### Added

- **Final Memory Journey phase** -- Quest Journeys now include a dedicated final Memory phase for durable handoff decisions

### Fixed

- **Thread status and windows** -- Thread status chips stay in feed flow, and leader thread windows survive history refresh and session removal more reliably
- **Leader Work Board controls** -- Work Board controls and summaries are more polished and easier to scan
- **Quest session links** -- Quest detail and search links route to the right session context

## 2026-05-09

### Added

- **Shared image preview variants** -- Image attachments now have reusable preview variants and refreshed variant responses so chat and Questmaster previews load more consistently
- **Universal search quest actions** -- Universal search can surface quest actions directly, and composer-launched searches keep the current query available
- **Audited quest ownership reassignment** -- Quest ownership changes are tracked explicitly so leader handoffs and owner corrections are easier to audit
- **Diff-stat budget guards** -- Git diff metadata refreshes are bounded for large or dirty worktrees, reducing UI stalls while preserving useful status signals
- **Voice activity history** -- Voice input keeps a rolling level history for steadier recording feedback
- **Quest feedback editing and progress TLDRs** -- Quest feedback can be edited, and quest preview progress now includes TLDR context for faster scanning

### Fixed

- **Quest search ranking** -- Fresh, exact quest matches are easier to find in Questmaster search results
- **Needs-input navigation** -- Needs-input notifications include clearer source context and route to the right thread or tab more reliably
- **Leader Work Board access** -- Work Board controls, title alignment, mounted quest panels, active phase chips, and route state stay consistent across leader navigation
- **Thread status stability** -- Thread status chips, thread filters, close targets, shortcut routing, and scroll restoration survive history refreshes and tab switches more reliably
- **Voice transcription and indicators** -- Voice context includes visible leader messages, SSE transcription results resolve correctly, and level meter styling is more consistent
- **Session restart and Codex metadata recovery** -- Restart blockers recover cleanly, restart timeout success is clearer, and Codex metadata refreshes coordinate with active turns
- **Reminder and image polish** -- System reminders render as standalone chips, quest detail image previews are tighter, native select popups respect dark mode, and mobile sidebar portraits are ready sooner

### Changed

- **Takode inspection output** -- CLI and thread inspection commands preserve thread context while keeping grep, peek, and default hints explicit and compact
- **Codex session safety guidance** -- Codex metadata refresh and skill-change behavior are documented as a reusable project skill for future session-safety work

## 2026-05-08

### Added

- **Universal message search** -- A mode-scoped universal search overlay can search sessions, threads, messages, and quests, with backend message search and composer entry points
- **File-link actions** -- File links gain context-menu actions backed by a server-side resolver
- **Backend logo badges** -- Backend badges and refreshed app logo assets make active backend and app branding more legible across themes
- **Configurable voice shortcuts** -- Voice controls can be assigned through the shortcut system
- **Paused-session composer bypass** -- The composer can send through selected paused sources when a user intentionally bypasses pause state

### Fixed

- **Mobile voice progress** -- Mobile transcription shows clearer progress, timing, and retry state while recording or uploading
- **Notification source context** -- Needs-input notifications preserve source context in global menus, replies, and seeded Playground scenarios
- **Thread and injected-event routing** -- Thread status markers no longer route whole messages, interrupted outcome reminders are skipped, and injected prompts render as searchable event messages
- **Session and git refresh costs** -- New sessions avoid implicit git sync, session-list polling is decoupled from git refresh, and git metadata scans are bounded more consistently
- **Archived worktree cleanup** -- Archived worktree removal can force cleanup when normal deletion paths leave stale state behind
- **Quest and memory browsing responsiveness** -- Quest page search stalls are reduced, and memory record detail layouts are more balanced
- **Session metric recovery** -- Turn metrics are derived from history and preserved across Codex init paths more reliably

### Changed

- **Memory browsing surface** -- The memory browser was redesigned around denser navigation, clearer record details, and better use of available space
- **Search placement** -- Session search moved into the sidebar while universal search handles cross-mode discovery
- **Validation guidance** -- UI validation guidance now distinguishes worktree code changes from the shared persistent validation state

## 2026-05-07

### Added

- **Global needs-input menu** -- Pending needs-input prompts can be reviewed globally, answered in place, and delivered back to the owning thread more reliably
- **Memory view** -- The old streams surface was replaced with a memory-focused browsing view
- **Permission mode CLI commands** -- Permission mode can be inspected and changed from the Takode CLI with backend-native mode validation
- **Leader portrait pools** -- Settings include built-in leader portrait pools with picker and row display support
- **Worker replacement spawn** -- Leaders can reclaim capacity by spawning a replacement worktree worker when an existing worker slot is stuck or unavailable
- **Thread and waiting status markers** -- Threads can show inline ready/waiting status markers, and waiting notifications can be transient when they no longer need attention
- **Emergency pause mode** -- Sessions can enter an emergency pause mode that blocks normal delivery until intentionally bypassed or resumed

### Fixed

- **Codex recovery paths** -- Interrupted assistant-only turns, coalesced skill refreshes, silent command results, and disconnected refresh retries recover without leaving turns stuck
- **Mobile chat viewport** -- Mobile keyboard sizing and root viewport behavior keep the composer and connection banners visible in more cases
- **Notification targeting** -- Blue and amber nudges, hidden tab precedence, repeated outcome reminders, and visible-tab scoping behave more predictably
- **Thread tabs** -- Active quest tabs survive completion, tab scroll targets are preserved, visible tab reordering is restored, and notification surfaces stay visually neutral
- **Questmaster and search precision** -- Fuzzy quest ranking and Unicode search tokens produce more useful results
- **Memory record access** -- Memory reads handle symlinks, sibling spaces, catalog freshness, scrollable space lists, and record detail readability more safely
- **Sidebar and session polish** -- Leader portrait rows are larger, portrait rings show status, session creation labels are clearer, and Session Info controls moved into the title area

### Changed

- **Permission mode handling** -- Permission behavior now uses backend-native modes instead of translating everything through a narrower shared abstraction
- **Takode CLI compactness** -- Session JSON output, injected recovery prompts, and inspection agent labels are more compact for cross-session debugging
- **Reusable orchestration guidance** -- Orchestration and dispatch guidance now better document worker replacement, reusable phase guidance, and design-principle skills

## 2026-05-06

### Added

- **File-based memory foundation** -- Memory repositories can be scoped by server/session space, use explicit lock and commit provenance, and support global CLI options
- **Leader active chip jump** -- Leader active-phase chips can jump directly to the relevant work context
- **Refreshed app icon** -- Takode gained updated app icon assets

### Fixed

- **Sparse thread windows** -- Thread windows fill sparse histories more reliably, and thread markers stay hidden inside collapsed turns
- **Leader voice context** -- Voice transcription context is scoped to the active leader thread instead of leaking unrelated thread context
- **Needs-input replies** -- Inline needs-input replies are decoupled from notification routing so answers arrive in the intended place
- **Codex leader routing** -- Codex leader turns route to the active thread correctly and recycle leaders more safely when context is exhausted
- **Thread tab layout** -- Desktop tabs have more room before overflowing, completed tab titles are muted, and quest completion markers persist in the sidebar
- **Memory repository setup** -- Memory repos reject colliding slug renames and use simpler frontmatter and auto-init behavior

### Changed

- **Quest Journey phase delivery** -- Runtime Journey phase briefs replaced legacy phase skill aliases so phase guidance follows the active workspace
- **Leader proposal guidance** -- Orchestration guidance now avoids duplicated quest proposal scope in common dispatch flows

## 2026-05-05

### Added

- **Multi-question needs-input prompts** -- Needs-input notifications can carry multiple short questions in a single user decision surface
- **Work Board overflow menu** -- Leader Work Board tabs gain an overflow menu when active work exceeds the visible tab rail
- **Memory guardrail groundwork** -- Memory-related bookkeeping can surface cleanup candidates and active-run guardrail checks

### Fixed

- **Session names and status chips** -- Manual session renames are preserved across namers, and git status chips refresh after session switches and surface refresh failures
- **Leader thread tabs** -- New leader tabs stay leftmost, stale board tabs remain in place, and tab dragging is constrained to the rail
- **Leader feed paging** -- Large leader histories page in batches, and historical error banners anchor to the right feed position
- **Codex and herd recovery** -- Queued Codex leader events, stale terminal live state, and incomplete resumed-turn recovery no longer block later work
- **Search result routing** -- Grouped search results and threaded message routes stay connected to the correct destination
- **Questmaster copy controls** -- Compact quest copy controls align more cleanly with the surrounding table UI

### Changed

- **Shared validation state guidance** -- UI validation guidance now defaults to the shared persistent E2E state when that state is appropriate

## 2026-05-02 to 2026-05-04

### Added

- **Quest Journey release blog** -- Added a concise product overview of the redesigned leader orchestration experience: [Takode's reimagined leader orchestration system](docs/release-notes/quest-journey-redesign.md)
- **Server-backed leader thread windows** -- Leader quest tabs, selected thread windows, and thread route indexes now have stronger server-side foundations so large orchestration sessions can keep focused quest conversations available across reloads and reconnects
- **Leader tab reordering** -- Quest thread tabs can be reordered, making active multi-quest sessions easier to organize

### Fixed

- **Quest-thread conversation reliability** -- Attached source messages, Main-thread notification sources, handoff markers, active output, and selected quest threads now stay visible in the right conversation more consistently
- **Leader feed performance** -- Large leader sessions avoid more cold-load hangs, dense activity bursts collapse more cleanly, and feed windows keep bounded ledgers instead of rebuilding unnecessary history
- **Journey readability** -- Long Journey timelines and hover previews are clamped, queued wait reasons are shown in quest hovers, and Journey lifecycle rows stay quieter until they matter
- **Codex tool failure recovery** -- `write_stdin` router failures and stale pending delivery states are surfaced and recovered as scoped tool failures instead of turning into whole-session failures
- **Thread viewport restoration** -- Leader threads restore saved positions more reliably after tab switches, feed remounts, and server-window updates
- **Leader thread and board edge cases** -- Thread activity indicators, repeated active phase rows, and selected-thread window retries behave more reliably

### Changed

- **Final debrief hygiene** -- Quest completion now expects final debrief metadata and TLDRs so completed work remains easier to scan later
- **Feed debugging guardrails** -- Message-feed and thread-window work now has clearer debugging rules for windowed histories, source-message attachment, and large leader-session performance
- **Validation profile guidance** -- Takode UI validation guidance now better documents profile choice, state retention, and evidence expectations

## 2026-04-25 to 2026-05-01

### Added

- **Quest Journey orchestration overhaul** -- Quest work now moves through visible, revisable Journey phases with leader-proposed plans, phase notes, active Work Board state, repeated phases, and clearer handoffs between workers, reviewers, user checkpoints, and porting
- **Focused quest threads** -- Leader sessions can keep Main as the staging and overview thread while routing detailed quest discussion, worker handoffs, reviewer updates, and relevant attached context into focused per-quest threads
- **Work Board navigation** -- The Work Board gained Journey previews, phase status, compact thread navigation, cross-thread activity markers, active wait states, and mobile-friendly quest-thread selectors
- **Quest memory and TLDR records** -- Quest records now support phase-scoped documentation, TLDR metadata for long feedback, final debrief metadata, phase documentation summaries, phase note image thumbnails, phase durations, and explicit follow-up relationships
- **Validation and coordination tooling** -- Added global resource leases, a Takode UI validation skill, optimized agent-browser screenshots, worker-stream checkpoints, and clearer orchestration guidance for long-running multi-session work
- **Questmaster browsing improvements** -- Questmaster gained compact table sorting, paged browsing, relevance search fixes, richer hover previews, leader attribution, and lower-friction new-quest drafting
- **Session and settings polish** -- Added custom transcription model support, persisted new-session defaults, scrollable model dropdowns, and clearer session-space creation flows

### Fixed

- **Leader and notification routing** -- Needs-input waits, notification chips, suggested answers, review notifications, and herd events now stay better scoped to the owning leader thread and survive restarts more reliably
- **Quest thread projection stability** -- Thread markers, moved-message counts, routed notifications, attachment sources, hidden activity markers, and source handoff markers now preserve context without creating confusing gaps in Main
- **Questmaster reliability** -- Live quest-store migration, snapshot freshness checks, claim/list performance, completed Journey status, compact statuses, TLDR keyboard access, and mobile quest detail layouts were hardened
- **Codex leader reliability** -- Codex leader sessions handle wrapper homes, model catalogs, auth/cache seeding, recycle thresholds, transient init recovery, session auth freshness, and stale post-compaction relaunch state more consistently
- **Restart and recovery behavior** -- Restart-interrupted sessions, queued work, sidebar notification state, stale attention markers, recovered leaders, and in-flight herd delivery recover with fewer duplicated or lost signals
- **Journey proposal safety** -- Active Journey proposals reject invalid promotions, preserve note rebasing semantics, block unsafe active rewrites, and keep runtime phase briefs aligned with the session workspace
- **UI readability** -- Quest hovers, thread tabs, quest banners, Work Board banners, phase notes, completed quest tabs, and compact reminder rendering were tightened for dense orchestration views

### Changed

- **Phase guidance and workflow docs** -- Journey guidance now treats Alignment, Explore, review, Execute, Outcome Review, User Checkpoint, Bookkeeping, and Port as explicit orchestration stages with clearer ownership and documentation expectations
- **Project skill organization** -- Project skills were consolidated into the `.agents` runtime path for Codex-facing sessions, legacy aliases were preserved where needed, and obsolete Playwright E2E guidance was replaced by the Takode UI validation workflow
- **Quest verification model** -- Quest verification moved into the done/review flow, with human-checkable verification items and debrief records replacing older separate verification surfaces

## 2026-04-24

### Added

- **Configurable app shortcuts** -- Settings now includes shortcut presets, custom recordable bindings, and per-action `Off` states for app navigation
- **Session Info editor actions** -- Session Info can open the active working directory in the configured editor, with long worktree/base paths kept scrollable and copyable
- **Leader needs-input reminders** -- Leader sessions are reminded about unresolved same-session needs-input notifications before handling new direct user messages

### Fixed

- **Archived session cleanup** -- Archived sessions without worktree tracker mappings can now be deleted cleanly
- **Shortcut navigation reliability** -- Search, session switching, terminal navigation, and terminal-to-thread returns now follow visible sidebar state and preserve thread viewport more consistently
- **Session preview and Questmaster polish** -- Session message previews, quest deep-link scrolling, and oversized MessageFeed test coverage were repaired and reorganized
- **Codex recovery and replay costs** -- Codex orphaned tool-preview recovery now waits for the watchdog window, and persisted replay buffers are sanitized to avoid hot-tail and metric memory spikes

## 2026-04-23

### Added

- **Codex status command support** -- Codex sessions now support `/status` turns without leaving stale active-turn state behind
- **Interactive session model controls** -- Session info now includes model and reasoning-effort selectors, with worker sessions inheriting leader model choices
- **Session search improvements** -- Multi-word search, assistant text response search, and search-data-only archived restore make older context easier to find
- **Takode read pairing** -- Tool call results are paired with their inputs in `takode read` for clearer cross-session inspection

### Fixed

- **Codex safety and MCP handling** -- Restored safe heredoc auto-approval patterns, MCP elicitation approvals, Codex config model defaults, and committed user-message IDs
- **Permission approval routing** -- Plan approvals, sensitive auto-approval bypasses, oversized staged-file checks, and stale pending permission state now behave more reliably
- **VS Code context sync** -- Editor selection context now survives restarts, forwarded URLs, closed panels, background updates, and mobile composer layout constraints
- **Herd and reconnect reliability** -- Archived sessions are skipped during restart bootstrap, reviewer sessions detach cleanly, and stale pending permissions are cleared across reconnect paths
- **Questmaster workflow reliability** -- Quest search state, commit metadata, rich-text inputs, and summary guidance are preserved more consistently across navigation and status transitions

## 2026-04-22

### Added

- **Stable message links** -- Chat messages can be copied as stable links for easier handoff and review
- **Self-managed notifications** -- Sessions can resolve their own Takode notifications, reducing stale attention signals
- **Playground section navigation** -- Playground examples now support route-safe section navigation

### Fixed

- **Attachment send reliability** -- Uploaded attachments are not resent, image attachments are preprocessed before send, and Codex draft image state is restored
- **Herd and notification cleanup** -- Delivered needs-input notifications resolve correctly, herded notification chips stay scoped to their owning leader, and stale board stall injections are reduced
- **Quest and CLI rich text safety** -- Quest feedback, spawn inputs, and copied CLI text preserve shell-sensitive content literally
- **Board and plan flow reliability** -- Dispatch reminders, resolved wait conditions, pending plan rejection, and plan rejection rendering behave more consistently
- **Dev and wrapper startup** -- Dev-start services stay alive after bootstrap, global CLI wrappers are simpler, and server ownership of wrappers is isolated
- **Mobile and composer polish** -- Mobile user-turn controls, footer layout, selection-menu behavior, and voice transcription responsiveness were improved

### Changed

- **Refactor verification guardrail** -- Refactor work now documents the full typecheck, test, and format verification gate
- **Architecture documentation** -- Server architecture notes were updated to match the post-refactor code structure

## 2026-04-21

### Fixed

- **Worktree archive/creation timeouts** -- Worktree setup and archive operations no longer block the event loop on NFS, preventing cascading WebSocket disconnects
- **Voice mode persistence** -- Voice mode preference persists across sessions without hydration races
- **Image upload ordering** -- Attachments are now uploaded before the message is sent
- **Stale Codex recovery state** -- Cleared stale queued recovery state that could block Codex turn delivery

### Changed

- **Module boundary refactors** -- Oversized server, bridge, composer, message feed, and store modules were split into focused files without changing user-facing behavior

## 2026-04-20

### Added

- **Timer event cards** -- Timer messages render as collapsed event cards in the chat feed instead of plain text rows
- **Composer autocomplete for refs** -- Typing `q-` or `#` in the composer autocompletes quest IDs and session numbers

### Fixed

- **False "server unreachable" banner** -- Suppressed spurious unreachable banner that appeared while the chat was actively connected and streaming
- **Transcription upload feedback** -- Upload and acknowledgement phases now show progress before speech-to-text completes
- **Notification chip layout** -- Per-type chip counts, flattened layout, and compact mobile inbox review rows
- **Worktree diff totals** -- Cleared stale diff totals for worktrees that are not ahead of their base branch
- **Codex image follow-ups during streaming** -- Queued image follow-ups are no longer dropped during active streaming
- **Worktree settings preservation** -- Tracked Claude settings files are preserved in worktrees
- **Timer event row layout** -- Flattened timer event rows to prevent misaligned cards in the chat feed

## 2026-04-19

### Added

- **Grep-style quest search** -- `quest grep` provides ripgrep-style search across all quest content with match highlighting
- **Pushover event filters** -- Pushover push notifications can be filtered by event type (e.g. only needs-input, only review-ready)
- **Stalled board row warnings** -- The work board warns when queued rows appear stalled, helping leaders spot stuck workers
- **Table viewer overlay** -- Markdown table viewer uses a wider overlay for better readability

### Fixed

- **Mobile composer and navigation** -- Reply composer stays expanded on mobile, status chips no longer overlap the mobile nav bar, and WebSocket reconnect sockets recover correctly on mobile
- **Voice mode on mobile** -- Mobile composer stays open while recording (q-282)
- **Codex image attachments** -- Hardened the full image attachment flow: send stages are visible, queued follow-ups survive overlap, and image send status shows in the purring chip
- **Markdown numbered lists** -- Numbered lists continue correctly across interleaved bullet sublists
- **Codex compaction with VS Code context** -- Fixed compaction failing when the Codex session included VS Code context blocks
- **Compaction recovery prompts** -- Force-compact no longer drops recovery prompts; improved recovery prompt wording after compaction
- **Herd wakeup delivery** -- Fixed replay-deferred herd wakeups not being delivered after session reconnect
- **Duplicate Codex relaunch** -- Prevented double relaunch when injected prompts arrived on a dead Codex socket
- **Link result previews** -- Takode links now show result previews for successful (not just failed) tool calls
- **Board queued dependents** -- Restored queued dependents are now correctly preserved when board state is recovered

### Changed

- **Active timers page** -- The scheduled-messages page has been repurposed to show active session timers with live countdown chips
- **Timer sidebar icons** -- Idle sessions with active timers show a timer icon; icon state syncs with timer lifecycle
- **Board docked state** -- The docked work board remembers its open/closed state across page loads
- **Session-group creation defaults** -- The session-group creation dialog remembers your last-used defaults (backend, model, etc.)
- **Removed legacy linear session view** -- The old linear session list in the sidebar has been removed in favor of the grouped view
- **Questmaster copy IDs** -- Quest IDs can now be copied directly from quest detail views
- **Editor selection chip UX** -- Improved the backend/model selector chip interaction in the composer

## 2026-04-18

### Added

- **History windowed sections** -- Long message history sections are windowed on demand to reduce rendering cost
- **Quest commit diff totals** -- Quest detail views show synced commit diff totals for at-a-glance change size
- **Work board ordering and columns** -- Board items are now ordered by status and dependencies, with reordered columns and clearer status labels
- **Cross-linked quest and session hovers** -- Quest and session hover cards are cross-linked for faster navigation
- **Orchestration visibility improvements** -- Improved board output, scan probe, and message-link hover rendering
- **Work board original command** -- Board rows now show the original board command used to create them

### Fixed

- **Markdown wide tables** -- Wide tables now expand properly instead of being clipped
- **Quest images** -- Quest images open in a lightbox modal instead of navigating away
- **Board resolved deps** -- Cleared resolved wait-for dependencies that were persisting incorrectly
- **Board status labels** -- Inline status labels are now properly formatted
- **Codex stall disconnects** -- Surfaced Codex stall disconnects to orchestration so leaders can react
- **Worktree detailed diffs** -- Anchored worktree detailed diffs to the correct base
- **Todo list rendering** -- New task lists now appear immediately without requiring a refresh

### Changed

- **Completed row timestamps** -- Completed board rows now show when they were completed

## 2026-04-17

### Added

- **Terminal inspector drag and resize** -- The terminal/tool inspector panel is now draggable and resizable
- **Session search category filters** -- Search results can be filtered by category (messages, tools, quests, etc.)
- **Herd event session chip links** -- Session chips in herd events are now clickable, linking directly to the session
- **Timer indicator on session chips** -- Sidebar session chips show a timer indicator when the session has active timers

### Fixed

- **Diff viewer for new files** -- Content-only new file edits now render correctly in the diff viewer
- **Codex view_image tool blocks** -- Raw `view_image` tool blocks are now surfaced in the chat feed
- **Quest session numbers** -- Session numbers are now shown in quest detail views
- **Quest lifecycle naming** -- Quest lifecycle naming order is preserved in the bridge

### Changed

- **Journey status labels** -- Questmaster journey status labels are now styled distinctly

## 2026-04-16

### Added

- **Negated quest search** -- Quest search supports negated filters (e.g. `-tag:ms` to exclude a tag)
- **Quest summary comments** -- Quest verification now enforces a summary comment before submission
- **Quest synced commits on verification** -- Verification handoffs automatically attach synced commit SHAs
- **Browser perf collector** -- Client-side performance metrics are collected for debugging render bottlenecks

### Fixed

- **Markdown single newlines** -- Single newlines are now respected in the shared Markdown renderer
- **Codex message delivery after restart** -- Unblocked stuck Codex message delivery after server restart (q-385)
- **Codex image send order** -- Image send order is preserved for multi-image messages
- **Quest title auto-renames** -- Leaders can no longer accidentally rename quest titles
- **Spurious restart interruptions** -- Suppressed spurious restart interruptions in the WebSocket bridge
- **Mobile transcription timeout** -- Extended mobile transcription timeout to avoid premature cutoffs
- **Composer re-render churn** -- Reduced composer re-renders during rapid session churn
- **Diagnostics section visibility** -- Task panel diagnostics section stays visible when it should

### Changed

- **Codex continued turn merging** -- Codex continued assistant turns are now merged in the chat feed
- **Leader archive confirmation** -- Archiving a leader with an active herd now requires confirmation
- **Reviewer-groom guardrails** -- Tightened reviewer-groom workflow guardrails for more consistent reviews

## 2026-04-15

### Added

- **Timer titles and descriptions** -- Session timers now support separate titles and descriptions
- **Force herd reassignment** -- Leaders can forcibly reassign a herded session to a different worker
- **Bell urgency coloring** -- The notification bell icon color reflects the highest-urgency unread notification
- **Herd event activity compression** -- Repetitive tool-use activity in herd events is compressed to reduce noise

### Fixed

- **Compaction recovery** -- Suppressed false Claude compaction recovery and replayed compaction recovery noise (q-317)
- **Codex image transport** -- Restored native localImage transport for image messages (q-322)
- **Worktree branch on archive/unarchive** -- Worktree branches are archived as lightweight refs and restored correctly on unarchive (q-329)
- **Re-render reduction** -- Reduced unnecessary re-renders from polling and event floods across sidebar, composer, and shell store (q-334)
- **Codex disconnect recovery** -- Hardened disconnect recovery and diagnostics for Codex sessions
- **Subagent state on history sync** -- Reset stale subagent state when history is re-synced from the server
- **Quest comment composer** -- Quest comment composer stays visible when scrolling
- **Codex config on relaunch** -- Global Codex config is refreshed on session relaunch
- **Codex denied-plan guard** -- Preserved denied-plan fresh-turn guard across session state changes
- **False notify chips** -- Eliminated false notification chips that appeared without real events

### Changed

- **Reviewer-groom workflow** -- Reworked reviewer-groom workflow for more consistent reviews
- **Mobile log viewer** -- Improved mobile log viewer usability with fully collapsible filters (q-330)

## 2026-04-14

### Added

- **FolderPicker redesign** -- Rebuilt with breadcrumb navigation, inline filter, and full keyboard navigation (q-315)
- **Production logging system** -- Server-side production logging with a mobile-friendly log viewer (q-299)
- **Auto-collapse plan file writes** -- Plan-file tool writes are auto-collapsed in the chat feed to reduce noise (q-314)
- **AskUserQuestion send button** -- The "Other" free-text input in AskUserQuestion now has a send button (q-319)
- **Edit and delete agent feedback** -- Questmaster feedback entries from agents can now be edited or deleted inline

### Fixed

- **Streaming lag from Composer re-renders** -- Narrowed Composer store selectors to prevent lag during streaming (q-265)
- **Notification and timer chip alignment** -- Notification and timer chips are now on the same line (q-309)
- **Horizontal scroll in chat** -- Prevented horizontal scrolling in the chat feed (q-313)
- **Stuck session detection** -- Robust detection and recovery of stuck sessions with extracted shared threshold constant (q-307)
- **Permission mode across SDK init** -- `permissionMode` is now preserved across SDK `session_init` events (q-316)
- **Diff base branch persistence** -- Worktree diff base branch survives server restarts (q-318)

### Changed

- **Review chip checkbox** -- Review notification chips now show a checkbox affordance (q-302)

## 2026-04-13

### Added

- **Session rollback / revert** -- Codex sessions now support reverting to a previous message, safely exposed via the UI (q-289)
- **Session message size hover card** -- Session details popover shows message history size in the hover card so users can gauge API limit proximity (q-291)
- **Pending session timers** -- `takode list` and the sidebar show active timers on sessions, giving leaders visibility into scheduled work
- **Notification chips in collapsed turns** -- Collapsed assistant turns show notification chip counts so important events stay visible (q-277)
- **Token-efficient scan/peek format** -- `takode scan`/`peek` JSON output is optimized for lower token usage (q-287)
- **Takode timer enforcement** -- System prompt enforces `takode timer` over `sleep`/`ScheduleWakeup` for waits over 1 minute (q-303)
- **Mandatory notify summary** -- `takode notify` now requires a summary argument (q-304)

### Fixed

- **Herd event pending delivery** -- Unblocked herd-event pending delivery (q-275)
- **Codex image transport** -- Switched to path-only image transport (q-298)

## 2026-04-12

### Added

- **Notification inbox** -- Per-session notification inbox collects `takode notify` events into a persistent, browsable popover with message links, hover previews, and done/active sections (q-235, q-242)
- **Work board completed history** -- Board items now move to a collapsible "Completed" section instead of being deleted, preserving work history (q-238)
- **Archive Group** -- One-click context menu action to archive an entire orchestration group (leader + workers + reviewers) (q-231)
- **Message history size** -- Session details popover now shows message history size in MB/KB for visibility into API limit proximity (q-236)
- **Compaction events in scan/peek** -- Compaction markers now appear in `takode scan`/`peek` output and are indexed for session search (q-247)
- **Pre-submission checklist** -- Workers must now address all human feedback, add a summary comment, and only include human-verification items before submitting quests (q-248)
- **Leader notification trigger rules** -- Explicit guidance on when to use `takode notify` for needs-input and review-ready events (q-246)
- **Quest journey enforcement** -- Leader guardrails now prohibit skipping review/groom stages regardless of change size (q-241)
- **Leader "wait for user answer" rule** -- Leaders persist the rule to wait for user answers across compaction (q-240)
- **Leader "no blocking tools" rule** -- Leaders are prevented from using AskUserQuestion/EnterPlanMode which would stall herd event processing (q-234)

### Fixed

- **Stale context usage after compaction** -- Context usage percentage no longer shows a stale pre-compaction value; removed incorrect `pre_tokens` context update from all three compact_boundary handlers (q-250)
- **Stuck reviewer sessions** -- Fixed reviewer sessions showing as "generating" indefinitely after completing their skeptic review (q-237)
- **Duplicate compaction markers** -- Fixed /compact after revert producing two separate compaction markers with different summaries (q-227)
- **Grep BRE warning** -- `takode grep` now warns when `\|` BRE alternation syntax returns zero results, suggesting JS/ERE `|` instead (q-229)

### Changed

- **Cleaner chat timestamps** -- Removed centered minute marks and moved generation duration inline with message text (q-249)
- **Unified quest detail modal** -- Replaced lightweight in-chat quest modal with the full Questmaster detail view everywhere (q-239)
- **Image compression on ingest** -- PNG screenshots are now converted to JPEG q85 when stored, reducing image size by ~22% with no visible quality loss (q-232)
- **Improved herd event formatting** -- Cleaner turn_end summaries with quoted content, separate tool lines, and restored permission icons (q-245)
- **Image reading rule** -- Sessions now try reading images directly first and only resize on failure (q-243)

## 2026-04-11

### Added

- **Session-message deep links** -- Deep-link to specific messages within sessions with auto-expand of collapsed containers and scroll-to-reveal with amber highlight (q-201)
- **User message Markdown** -- User messages now render with a conservative Markdown subset (code fences, bold/italic, lists, links) instead of plain text (q-216)
- **CamelCase fuzzy search** -- Searching "plan mode" now matches "ExitPlanMode" by splitting CamelCase tokens across all search surfaces (q-224)
- **Leader-dispatch dedicated skill** -- Extracted leader dispatch workflow into a dedicated skill so critical dispatch rules survive compaction (q-214)
- **Plan content in herd events** -- ExitPlanMode herd events now include the full plan text so leaders can review plans inline (q-215)
- **Session number in system prompt** -- Sessions receive their Takode session number for self-referencing during orchestration (q-197)
- **Session info after herding** -- `takode herd` now prints full session metadata after herding (q-192)
- **Pending permission markers** -- `takode list --herd` shows a visible indicator next to sessions with unresolved permission requests (q-222)
- **Board --wait-for session numbers** -- Work board's `--wait-for` flag now accepts `#N` session numbers in addition to `q-N` quest IDs (q-219)

### Fixed

- **Unified image handling** -- Both WS and SDK backends now send user images as file path annotations instead of inline base64, reducing API request size (q-223)
- **Session stalls after restart** -- Fixed SDK and WebSocket sessions stalling after server restart due to generation lifecycle tracking issues (q-220)
- **History sync on reconnect** -- Fixed browser receiving no history on WebSocket reconnect by falling back to full history delivery on frozen hash mismatch (q-212)
- **Stale running state after relaunch** -- Fixed UI showing 'running' state after a WS session turn completes on relaunch (q-213)
- **Permission routing to leader** -- Fixed permission requests from herded WebSocket sessions not being delivered as herd events to the leader (q-205)
- **WS auto-approval in ask=off mode** -- Fixed WebSocket sessions not auto-approving permission requests in `ask=off` mode (q-204)
- **Stale worktree guardrails** -- Fixed stale `.claude/CLAUDE.md` worktree guardrails conflicting with dynamic system prompt injection (q-211)
- **Context usage double-counting** -- Fixed incorrect context usage percentage for WS and Codex sessions by consolidating cache-detection logic (q-208)
- **Reverted messages reappearing** -- Prevented stale reverted messages from resurfacing after server restart (q-225)
- **WS interrupt error suppression** -- Fixed spurious error side-effects during WebSocket session interruption (q-202)
- **Herd event chip overflow** -- Constrained herd event chip width to prevent horizontal scroll (q-226)
- **Clickable tool result images** -- Tool result image previews now open in a lightbox modal (q-199)
- **Diff expand between hunks** -- Enabled expand buttons to reveal collapsed code between diff hunks in unified-diff view (q-122)
- **Peek/scan output formatting** -- Improved readability with tool call prefixes and multi-line continuation symbols (q-203)
- **Queued message flush on resume** -- Deferred queued message flush until --resume replay completes (q-209)
- **Leader prompt lifecycle** -- Fixed stale file references after leader-dispatch skill split (q-218)
- **Selection menu regression** -- Fixed text selection context menu and repositioned to not block selected text (q-174)

## 2026-04-10

### Added

- **Leader session naming** -- Leader sessions are now auto-named "Leader N" with a persistent counter instead of the autonamer (q-188)
- **Standalone file-tool chips** -- Edit/Write/Read tool calls now render as standalone chips with smart-truncated file paths and always-visible Open File button (q-184)
- **Random memory ideas skill** -- New skill for capturing random ideas, notes, and references to Notion

### Fixed

- **System prompt injection for SDK 0.2.101+** -- Fixed system prompt injection for new Agent SDK versions via initialize control_request (both SDK and WebSocket paths)
- **Reviewer sessions in tree view** -- Fixed reviewer sessions not appearing in sidebar tree view herd expansion (q-185)
- **Duplicate notification chips** -- Fixed `takode notify` showing two notification chips instead of one (q-187)
- **Text selection menu** -- Fixed regression and repositioned selection context menu (q-174)
- **Tree view styling** -- Extended accent bar over full herd container, moved status dots to right side, rendered reviewer sessions as inline chips (q-185)

### Changed

- **Agent SDK bump** -- Upgraded `@anthropic-ai/claude-agent-sdk` from 0.2.63 to 0.2.101
- **Removed cron-scheduling skill** -- Replaced by the Takode timer mechanism
- **Collapsed turn timestamps** -- Removed centered minute markers from collapsed turn view for cleaner layout (q-172)
