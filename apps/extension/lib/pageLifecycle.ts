/**
 * Ties the content script's lifetime to the extension's. When Glance is reloaded or updated under an open tab:
 * WXT's context is aborted once (which removes our shadow-root UI, unmounting React and with it every listener, and
 * stops the underliner, clearing its highlights), then a quiet refresh notice takes the orb's place. Nothing else
 * runs afterwards, and nothing is logged.
 */
import { contextAlive, onContextLost, reportContextLost, watchContext } from "./lifecycle";
import { NOTICE_TAG, showUpdatedNotice } from "./updatedNotice";

interface ScriptContext {
  readonly signal: AbortSignal;
  notifyInvalidated(): void;
  onInvalidated(cb: () => void): () => void;
}

export function installPageLifecycle(ctx: ScriptContext, win: Window = window): void {
  // A newer copy of this script (re-injection, dev reload) invalidates the old copy synchronously while it starts,
  // before reaching here, so clearing the old copy's notice at this point leaves the newer script in charge.
  win.document.querySelector(NOTICE_TAG)?.remove();

  onContextLost(() => {
    ctx.notifyInvalidated();
    showUpdatedNotice(win.document);
  });
  // WXT can also notice first (for example when it reads ctx.isInvalid). Route that through the same single path.
  ctx.onInvalidated(() => {
    if (!contextAlive()) reportContextLost();
  });
  watchContext(win);
}
