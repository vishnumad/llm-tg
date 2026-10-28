import { describe, expect, test } from "bun:test";
import { GrammyError } from "grammy";
import { createPreview } from "./preview";

function telegramError(error_code: number, description: string, retry = 0) {
  return new GrammyError(
    description,
    {
      ok: false,
      error_code,
      description,
      parameters: { retry_after: retry },
    },
    "editMessageText",
    {},
  );
}

describe("createPreview", () => {
  test("renders the first text at once and only the newest after that", async () => {
    const rendered: string[] = [];
    const preview = createPreview(async (markdown) => {
      rendered.push(markdown);
    }, 20);

    preview.update("a");
    preview.update("ab");
    preview.update("abc");
    await Bun.sleep(50);
    await preview.stop();

    expect(rendered).toEqual(["a", "abc"]);
  });

  test("runs one render at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const preview = createPreview(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Bun.sleep(5);
      inFlight -= 1;
    }, 0);

    for (const text of ["a", "b", "c", "d"]) {
      preview.update(text);
      await Bun.sleep(1);
    }
    await Bun.sleep(30);
    await preview.stop();

    expect(most).toBe(1);
  });

  test("drops waiting text on stop, without sitting out the interval", async () => {
    const rendered: string[] = [];
    const preview = createPreview(async (markdown) => {
      rendered.push(markdown);
    }, 10_000);

    preview.update("a");
    preview.update("ab");
    const startedAt = Date.now();
    await preview.stop();
    preview.update("abc");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(rendered).toEqual(["a"]);
  });

  test("retries after Telegram's rate limit", async () => {
    const rendered: string[] = [];
    let attempts = 0;
    const preview = createPreview(async (markdown) => {
      attempts += 1;
      if (attempts === 1) {
        throw telegramError(429, "Too Many Requests", 0);
      }
      rendered.push(markdown);
    }, 0);

    preview.update("a");
    await Bun.sleep(20);
    await preview.stop();

    expect(rendered).toEqual(["a"]);
  });

  test("never throws when a render fails", async () => {
    const rendered: string[] = [];
    const preview = createPreview(async (markdown) => {
      if (markdown === "a") {
        throw telegramError(400, "Bad Request: chat not found");
      }
      rendered.push(markdown);
    }, 0);

    preview.update("a");
    await Bun.sleep(5);
    preview.update("ab");
    await Bun.sleep(5);
    await preview.stop();

    expect(rendered).toEqual(["ab"]);
  });
});
