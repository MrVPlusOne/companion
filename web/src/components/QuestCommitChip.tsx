import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type QuestCommitLookup } from "../api.js";
import { commitComparisonLabel, type QuestDeliveryView } from "../../shared/quest-delivery.js";
import { buildCodeCommitEntries, QuestCommitDiffView, useQuestCommitDiffState } from "./QuestCommitDiffView.js";
import type { QuestCommitEntry } from "./QuestCommitEvidence.js";

export interface QuestDeliveryClient {
  delivery: (questId: string, deliveryId: string) => Promise<QuestDeliveryView>;
  commit: (
    questId: string,
    deliveryId: string,
    sha: string,
    review: boolean,
    includeDiff: boolean,
  ) => Promise<QuestCommitLookup>;
  review: (
    questId: string,
    deliveryId: string,
    sha: string,
    snapshot: number,
  ) => Promise<{
    snapshots: Array<{ index: number; count: number; label: string }>;
    commitShas: string[];
  }>;
}

const deliveryClient: QuestDeliveryClient = {
  delivery: (...args) => api.getQuestDelivery(...args),
  commit: (...args) => api.getQuestDeliveryCommit(...args),
  review: (...args) => api.getQuestDeliveryReview(...args),
};
const pendingSummaries = new Map<string, Promise<QuestDeliveryView>>();

/** A fixed delivery/commit identity stays with the authored message forever. */
export function QuestCommitChip({
  questId,
  deliveryId,
  sha,
  children,
  client = deliveryClient,
}: {
  questId: string;
  deliveryId: string;
  sha: string;
  children: ReactNode;
  client?: QuestDeliveryClient;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [delivery, setDelivery] = useState<QuestDeliveryView | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState(false);
  const selected = delivery?.commits.find((commit) => commit.sha === sha);

  useEffect(() => {
    setDelivery(null);
    setError(false);
    setOpen(false);
    let cancelled = false;
    const key = `${questId}:${deliveryId}`;
    let request = client === deliveryClient ? pendingSummaries.get(key) : undefined;
    if (!request) {
      request = client.delivery(questId, deliveryId);
      if (client === deliveryClient) {
        pendingSummaries.set(key, request);
        const current = request;
        const clear = () => {
          if (pendingSummaries.get(key) === current) pendingSummaries.delete(key);
        };
        void request.then(clear, clear);
      }
    }
    void request
      .then((value) => {
        if (cancelled) return;
        if (
          value.id !== deliveryId ||
          value.questId !== questId ||
          !value.commits.some((commit) => commit.sha === sha)
        ) {
          setError(true);
          return;
        }
        setDelivery(value);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, questId, deliveryId, sha, retry]);

  const title = selected
    ? `${selected.message}\n+${selected.additions} −${selected.deletions}${selected.binaryFiles ? `; ${selected.binaryFiles} binary files` : ""}\n${commitComparisonLabel(selected.comparison)}${selected.comparison?.baseSha ? ` ${selected.comparison.baseSha}` : ""}\n${delivery!.branch}`
    : undefined;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="commit-chip my-0.5 inline-grid max-w-full grid-cols-[max-content_minmax(0,1fr)] items-center gap-2 rounded-md border border-cc-border bg-cc-hover/60 px-2 py-1 align-middle text-left text-xs text-cc-fg hover:border-cc-primary/50 focus-visible:outline-2 focus-visible:outline-cc-primary"
        title={title}
        aria-label={
          selected
            ? `Open commit ${selected.message}, ${selected.additions} additions, ${selected.deletions} deletions, ${commitComparisonLabel(selected.comparison)}`
            : error
              ? "Retry unavailable commit details"
              : "Load commit details"
        }
        onClick={(event) => {
          event.stopPropagation();
          if (selected) setOpen(true);
          else {
            setRetry((value) => value + 1);
          }
        }}
      >
        <span
          className="flex flex-col items-end whitespace-nowrap font-mono-code tabular-nums"
          data-testid="commit-chip-stats"
        >
          {selected ? (
            <>
              <span className="flex justify-end gap-1.5">
                <span className="text-emerald-500">+{compactCount(selected.additions)}</span>
                <span className="text-red-400">−{compactCount(selected.deletions)}</span>
              </span>
              {selected.binaryFiles > 0 && (
                <span className="text-right text-[10px] text-cc-muted">{selected.binaryFiles} binary</span>
              )}
            </>
          ) : (
            <span className="text-right text-cc-muted">{error ? "Unavailable" : "…"}</span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate" data-testid="commit-chip-title">
            {selected?.message || children}
          </span>
          <span className="block text-[10px] leading-tight text-cc-muted" data-testid="commit-chip-comparison">
            {selected ? commitComparisonLabel(selected.comparison) : "Recorded commit"}
          </span>
        </span>
      </button>
      {open && delivery && selected && (
        <QuestDeliveryModal
          questId={questId}
          delivery={delivery}
          initialSha={sha}
          client={client}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

function QuestDeliveryModal({
  questId,
  delivery,
  initialSha,
  client,
  onClose,
}: {
  questId: string;
  delivery: QuestDeliveryView;
  initialSha: string;
  client: QuestDeliveryClient;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [review, setReview] = useState(false);
  const [parentSha, setParentSha] = useState(initialSha);
  const [snapshot, setSnapshot] = useState(0);
  const [reviewList, setReviewList] = useState<Awaited<ReturnType<QuestDeliveryClient["review"]>> | null>(null);
  const [reviewError, setReviewError] = useState(false);
  const entries = useMemo(
    () =>
      buildCodeCommitEntries(review ? (reviewList?.commitShas ?? []) : delivery.commits.map((commit) => commit.sha)),
    [review, reviewList, delivery],
  );
  const lookup = useCallback(
    (entry: QuestCommitEntry, includeDiff: boolean) =>
      client.commit(questId, delivery.id, entry.sha, review, includeDiff),
    [client, questId, delivery.id, review],
  );
  const state = useQuestCommitDiffState({
    questId: `${questId}:${delivery.id}:${review}:${snapshot}`,
    storedEntries: entries,
    autoOpenFirst: true,
    initialSha: review ? undefined : parentSha,
    lookup,
    preserveOrder: true,
  });
  const activeSummary = delivery.commits.find((commit) => commit.sha === state.activeCommitEntry?.sha);
  const canReview = (activeSummary?.reviewCount ?? 0) > 0 || delivery.earlierReviewCount > 0;

  useEffect(() => {
    dialogRef.current?.showModal();
    return () => dialogRef.current?.close();
  }, []);

  useEffect(() => {
    if (!review) return;
    let cancelled = false;
    setReviewList(null);
    setReviewError(false);
    void client
      .review(questId, delivery.id, parentSha, snapshot)
      .then((value) => {
        if (!cancelled) setReviewList(value);
      })
      .catch(() => {
        if (!cancelled) setReviewError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, questId, delivery.id, parentSha, snapshot, review]);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label="Recorded delivery commit"
      onCancel={onClose}
      className="m-auto h-[88dvh] max-h-[88dvh] w-[min(72rem,96vw)] max-w-[96vw] rounded-xl border border-cc-border bg-cc-card p-0 text-cc-fg shadow-2xl backdrop:bg-black/60"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cc-border px-3 py-2 text-xs">
          <span className="text-cc-muted">{delivery.branch}</span>
          {(review || canReview) && (
            <button
              type="button"
              className="rounded border border-cc-border px-2 py-1"
              aria-expanded={review}
              onClick={() => {
                if (!review) {
                  setParentSha(state.activeCommitEntry?.sha ?? initialSha);
                  setSnapshot(0);
                }
                setReview((value) => !value);
              }}
            >
              {review ? "Back to delivered commit" : "Review history"}
            </button>
          )}
          {review && reviewList && reviewList.snapshots.length > 1 && (
            <select
              aria-label="Review snapshot"
              value={snapshot}
              className="max-w-full rounded bg-cc-hover px-2 py-1"
              onChange={(event) => setSnapshot(Number(event.target.value))}
            >
              {reviewList.snapshots.map((item) => (
                <option key={item.index} value={item.index}>
                  {item.label} ({item.count})
                </option>
              ))}
            </select>
          )}
          {review && <span className="text-cc-muted">Retained review evidence</span>}
        </div>
        <div className="min-h-0 flex-1">
          {review && !reviewList ? (
            <div className="p-6 text-sm text-cc-muted">
              {reviewError ? "Review history unavailable." : "Loading review history…"}
              <button type="button" onClick={onClose} className="ml-4 underline">
                Close
              </button>
            </div>
          ) : (
            <QuestCommitDiffView
              state={state}
              onClose={onClose}
              commitLabel={review ? "Review commit" : "Delivered commit"}
            />
          )}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

function compactCount(value: number): string {
  return new Intl.NumberFormat(
    "en-US",
    value < 1_000_000 ? {} : { notation: "compact", maximumFractionDigits: 1 },
  ).format(value);
}
