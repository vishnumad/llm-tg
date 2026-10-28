import { GrammyError } from "grammy";
import { logger } from "../logger";

/** Shows a live preview of an answer the model is still writing. */
export type Preview = {
  /** Queue the newest text. Older text still waiting is dropped. */
  update(markdown: string): void;
  /** Drop anything still waiting, and wait for a request in flight. */
  stop(): Promise<void>;
};

function retryAfterMs(error: unknown): number | undefined {
  if (error instanceof GrammyError && error.error_code === 429) {
    return (error.parameters.retry_after ?? 1) * 1_000;
  }
  return undefined;
}

function isNotModified(error: unknown): boolean {
  return (
    error instanceof GrammyError &&
    error.description.includes("message is not modified")
  );
}

/**
 * Render the newest text at most once per `intervalMs`, one request at a
 * time. A preview is cosmetic, so a failed render is logged, never thrown.
 */
export function createPreview(
  render: (markdown: string) => Promise<void>,
  intervalMs: number,
): Preview {
  let pending: string | undefined;
  let shown: string | undefined;
  let stopped = false;
  let nextAt = 0;
  let running: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  /** Sleep until the next render is allowed, or until stopped. */
  async function pause(ms: number) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
    await promise;
    wake = undefined;
  }

  async function drain() {
    while (pending !== undefined && !stopped) {
      const wait = nextAt - Date.now();
      if (wait > 0) {
        await pause(wait);
        continue;
      }
      const markdown = pending;
      pending = undefined;
      if (markdown === shown) {
        continue;
      }
      nextAt = Date.now() + intervalMs;
      try {
        await render(markdown);
        shown = markdown;
      } catch (error) {
        const retryAfter = retryAfterMs(error);
        if (retryAfter !== undefined) {
          nextAt = Date.now() + retryAfter;
          pending ??= markdown;
        } else if (isNotModified(error)) {
          shown = markdown;
        } else {
          logger.error("reply.preview_failed", error);
        }
      }
    }
  }

  function kick() {
    running ??= drain().finally(() => {
      running = undefined;
      // Text queued after the loop's last check would otherwise sit unseen.
      if (pending !== undefined && !stopped) {
        kick();
      }
    });
    return running;
  }

  return {
    update(markdown) {
      if (!stopped) {
        pending = markdown;
        kick();
      }
    },
    async stop() {
      stopped = true;
      pending = undefined;
      wake?.();
      await running;
    },
  };
}
