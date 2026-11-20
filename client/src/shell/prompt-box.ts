// ViewContext.promptBox (shell.ts): a view shows the ONE prompt box (#dispatch) inside itself.
// mountIn(host) moves that same element into `host` and marks the body (shell.css hides the empty
// docked bar); the function it returns puts the box back in the dock. The element is moved, never
// copied, so its state and listeners go with it and there is never a second prompt box.
// views/home.test.ts drives it through the real Home view and ViewHost.

import type { ViewContext } from "./views";

export const PROMPT_INLINE_CLASS = "alef-prompt-inline";

export function promptBoxHost(dock: HTMLElement, relayout: () => void): ViewContext["promptBox"] {
  return {
    mountIn(host) {
      const box = document.getElementById("dispatch");
      if (!box) return () => {};
      host.append(box);
      document.body.classList.add(PROMPT_INLINE_CLASS);
      relayout();
      return () => {
        if (box.parentElement !== dock) dock.append(box);
        document.body.classList.remove(PROMPT_INLINE_CLASS);
        relayout();
      };
    },
  };
}
