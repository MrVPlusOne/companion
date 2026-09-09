import { useMemo, useState } from "react";
import { QuestCommitChip } from "../QuestCommitChip.js";
import { Card, Section, PlaygroundSectionGroup } from "./shared.js";
import {
  createDeliveryFixtureClient,
  deliveryFixture,
  laterDeliveryFixture,
  DELIVERY_FIXTURE_QUEST,
} from "../../test-fixtures/commit-delivery-fixture.js";

export function PlaygroundCommitDeliverySection() {
  const [later, setLater] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const client = useMemo(() => createDeliveryFixtureClient(unavailable), [unavailable]);
  return (
    <PlaygroundSectionGroup groupId="overview">
      <Section
        title="Commit delivery chips"
        description="Exact delivery selection, stats-first bounded titles, binary changes, retained review, and unavailable repositories."
      >
        <Card label="Recorded delivery responses">
          <div className="space-y-3">
            <p className="text-sm text-cc-fg">
              The first change is synced. These chips retain this delivery’s exact commits.
            </p>
            {deliveryFixture.commits.map((commit) => (
              <div key={commit.sha} className="min-w-0">
                <QuestCommitChip
                  questId={DELIVERY_FIXTURE_QUEST}
                  deliveryId={deliveryFixture.id}
                  sha={commit.sha}
                  client={client}
                >
                  {commit.message}
                </QuestCommitChip>
              </div>
            ))}
            {later && (
              <div className="border-t border-cc-border pt-3">
                <p className="mb-2 text-sm text-cc-fg">Later response: the empty-state issue is fixed.</p>
                <QuestCommitChip
                  questId={DELIVERY_FIXTURE_QUEST}
                  deliveryId={laterDeliveryFixture.id}
                  sha={laterDeliveryFixture.commits[0]!.sha}
                  client={client}
                >
                  Later fix
                </QuestCommitChip>
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-3 text-xs">
              <button
                type="button"
                className="rounded border border-cc-border px-3 py-2"
                onClick={() => setLater((value) => !value)}
              >
                {later ? "Hide later delivery" : "Add later delivery"}
              </button>
              <button
                type="button"
                className="rounded border border-cc-border px-3 py-2"
                onClick={() => setUnavailable((value) => !value)}
              >
                {unavailable ? "Restore repository" : "Make repository unavailable"}
              </button>
            </div>
            <p className="text-xs text-cc-muted">
              Synthetic server-shaped fixtures. Full numeric counts and titles remain in each chip’s accessible label
              and tooltip. Review evidence does not add delivered commits.
            </p>
          </div>
        </Card>
      </Section>
    </PlaygroundSectionGroup>
  );
}
