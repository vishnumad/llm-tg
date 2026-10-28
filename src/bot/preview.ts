import { GrammyError } from "grammy";
import { logger } from "../logger";

export type Preview = {
  update(markdown: string): void;
  /** Drop any text still waiting, and wait for a render in flight. */
  stop(): Promise<void>;
};

function retryAfterMs(error: unknown): number | undefined {
  if (error instanceof GrammyError && error.error_code === 429) {
    return (error.parameters.retry_after ?? 1) * 1_000;
  }
  return undefined;
}

/**
 * Render the newest text at most once per `intervalMs`, one render at a time.
 * A preview is cosmetic, so a failed render is logged, never thrown.
 */
export function createPreview(
  render: (markdown: string) => Promise<void>,
  intervalMs: number,
): Preview {
  let latest = "";
  let shown = "";
  let nextAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rendering: Promise<void> | undefined;
  let stopped = false;

  function schedule() {
    if (!stopped && !timer && !rendering && latest !== shown) {
      timer = setTimeout(renderLatest, nextAt - Date.now());
    }
  }

  async function renderLatest() {
    timer = undefined;
    const markdown = latest;
    nextAt = Date.now() + intervalMs;
    rendering = render(markdown).then(
      () => {
        shown = markdown;
      },
      (error) => {
        const retryAfter = retryAfterMs(error);
        if (retryAfter === undefined) {
          logger.error("reply.preview_failed", error);
          shown = markdown;
        } else {
          nextAt = Date.now() + retryAfter;
        }
      },
    );
    await rendering;
    rendering = undefined;
    schedule();
  }

  return {
    update(markdown) {
      if (markdown.trim()) {
        latest = markdown;
        schedule();
      }
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await rendering;
    },
  };
}
