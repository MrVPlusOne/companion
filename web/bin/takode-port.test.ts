import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePort } from "./takode-port.js";
import { apiGet, apiPost } from "./takode-core.js";

vi.mock("./takode-core.js", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  err: (message: string) => {
    throw new Error(message);
  },
}));

const id = "a".repeat(32);
const status = { id, state: "retained", landed: [], remaining: ["b".repeat(40)], nextAction: "Seal after review" };
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(apiGet).mockResolvedValue(status);
  vi.mocked(apiPost).mockResolvedValue(status);
});

describe("port tracking CLI", () => {
  it("sends an explicit private range and grouping without any Git mutation command", async () => {
    await handlePort("http://fixture", [
      "prepare",
      "q-42",
      "--base",
      "a".repeat(40),
      "--confirm-private",
      "--group-tips",
      "b".repeat(40),
    ]);
    expect(apiPost).toHaveBeenCalledWith(
      "http://fixture",
      "/takode/port/q-42/prepare",
      expect.objectContaining({
        baseSha: "a".repeat(40),
        confirmPrivate: true,
        groupTips: ["b".repeat(40)],
      }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Preparation"));
  });

  it("keeps JSON compact even if a server result contains bulky/debug fields", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      ...status,
      injectedSystemPrompt: "private".repeat(10000),
      groups: new Array(500).fill("bulky"),
    });
    await handlePort("http://fixture", ["status", "q-42", id, "--json"]);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(status);
  });

  it("rejects unknown flags and ambiguous preparation identifiers before making a request", async () => {
    await expect(
      handlePort("http://fixture", ["seal", "q-42", "../journal", "--commits", "a".repeat(40)]),
    ).rejects.toThrow("exact preparation");
    await expect(handlePort("http://fixture", ["prepare", "q-42", "--force"])).rejects.toThrow("Unknown");
    expect(apiPost).not.toHaveBeenCalled();
  });
});
