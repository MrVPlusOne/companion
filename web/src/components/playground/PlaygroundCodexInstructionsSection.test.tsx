// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { api } from "../../api.js";
import { PlaygroundCodexInstructionsSection } from "./PlaygroundCodexInstructionsSection.js";

vi.mock("./shared.js", () => ({
  Section: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps the instruction fixture scoped and restores the live API on unmount", async () => {
  // Only the dedicated Playground session is mocked; unrelated selected-session requests retain their owner.
  const liveRequest = { threadId: "live-thread", capturedAt: 1, source: "generated" };
  const liveResponse = { ...liveRequest, content: "live selected-session capture" };
  const original = vi.spyOn(api, "getSessionInstructionContent").mockResolvedValue(liveResponse);
  const { unmount } = render(<PlaygroundCodexInstructionsSection />);

  expect(original).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
  expect(await screen.findByText(/This is the captured generated instruction body/)).toBeInTheDocument();
  expect(original).not.toHaveBeenCalled();
  expect(await api.getSessionInstructionContent("real-session", liveRequest)).toEqual(liveResponse);
  expect(original).toHaveBeenCalledWith("real-session", liveRequest);

  unmount();
  expect(api.getSessionInstructionContent).toBe(original);
});

it("represents unavailable captures, loading, and request failures for browser inspection", async () => {
  // Fixed fixture controls make async and legacy states inspectable without persistent or live data writes.
  render(<PlaygroundCodexInstructionsSection />);
  fireEvent.click(screen.getByRole("button", { name: /Repository instructions: .*archived-source/ }));
  expect(await screen.findByText("Captured content is unavailable for this older source.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Close instruction viewer" }));

  fireEvent.change(screen.getByRole("combobox", { name: "Instruction viewer response" }), {
    target: { value: "loading" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
  expect(screen.getByRole("status")).toHaveTextContent("Loading captured instructions…");
  fireEvent.click(screen.getByRole("button", { name: "Close instruction viewer" }));

  fireEvent.change(screen.getByRole("combobox", { name: "Instruction viewer response" }), {
    target: { value: "error" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Takode-generated instructions" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the captured instructions.");
});
