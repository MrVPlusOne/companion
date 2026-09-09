import { useMemo, useRef, useState } from "react";
import { ComposerMenus } from "../ComposerMenus.js";
import { useComposerAutocomplete } from "../use-composer-autocomplete.js";
import { Card } from "./shared.js";

export function PlaygroundContextCommands() {
  const [role, setRole] = useState("codex-leader");
  const [mode, setMode] = useState("recycle");
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isCodex = role !== "claude-leader";
  const sessionView = useMemo(
    () => ({
      isLeaderSession: role !== "codex-worker",
      slashCommands: isCodex ? [] : ["compact"],
      skills: [],
      skillMetadata: [],
      apps: [],
    }),
    [role, isCodex],
  );
  // Use production autocomplete without a session connection or send action.
  const autocomplete = useComposerAutocomplete({
    text,
    setText,
    textareaRef,
    sessionId: "playground-context-commands",
    isCodex,
    sessionView,
  });

  return (
    <Card label="Manual context commands">
      <div className="space-y-3 px-4 py-3" data-testid="playground-context-commands">
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Command demo role"
            value={role}
            onChange={(event) => {
              autocomplete.closeAutocompleteMenus();
              setText("");
              setRole(event.target.value);
            }}
            className="rounded border border-cc-border bg-cc-input-bg p-2 text-sm text-cc-fg"
          >
            <option value="codex-leader">Codex leader</option>
            <option value="codex-worker">Codex worker</option>
            <option value="claude-leader">Claude leader</option>
          </select>
          {role === "codex-leader" && (
            <select
              aria-label="Command demo automatic mode"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
              className="rounded border border-cc-border bg-cc-input-bg p-2 text-sm text-cc-fg"
            >
              <option value="recycle">Automatic recycle</option>
              <option value="compact">Automatic compact</option>
            </select>
          )}
        </div>
        <p className="text-xs text-cc-muted">
          Type / to inspect commands. /compact always compacts; /recycle is available to Codex leaders in either
          automatic mode. Neither command changes that mode. This preview does not send commands.
        </p>
        <div className="relative pt-64">
          <div className="relative">
            <ComposerMenus {...autocomplete} />
            <textarea
              ref={textareaRef}
              aria-label="Context command preview"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                autocomplete.handleAutocompleteInput(event.target.value, event.target.selectionStart);
              }}
              onSelect={autocomplete.handleAutocompleteSelectionChange}
              onKeyDown={autocomplete.handleAutocompleteKeyDown}
              className="w-full resize-none rounded-lg border border-cc-border bg-cc-input-bg p-3 text-sm text-cc-fg"
              placeholder="Type / for commands"
              rows={1}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
