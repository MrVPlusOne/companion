import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";

/** Enter the composer before exercising its controls; compact defaults have separate interaction coverage. */
export function renderExpandedComposer(ui: ReactElement) {
  const view = render(ui);
  const textarea = view.container.querySelector("textarea");
  if (textarea) act(() => textarea.focus());
  return view;
}
