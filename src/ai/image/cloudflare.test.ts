import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { createCloudflareProvider } from "./cloudflare";

const provider = createCloudflareProvider({
  accountId: "account",
  apiToken: "cf-token",
  modelId: "@cf/black-forest-labs/flux-2-klein-4b",
});

let fetchSpy: Mock<typeof fetch> | undefined;

function respondWith(body: string | object, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(text, { status }),
  );
  return fetchSpy;
}

afterEach(() => fetchSpy?.mockRestore());

describe("createCloudflareProvider", () => {
  test("posts the prompt and size as a form, and decodes the image", async () => {
    const fetch = respondWith({
      success: true,
      result: { image: Buffer.from([1, 2, 3]).toString("base64") },
    });

    const image = await provider.generate({
      prompt: "a fox",
      shape: "portrait",
    });

    expect([...image]).toEqual([1, 2, 3]);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account/ai/run/@cf/black-forest-labs/flux-2-klein-4b",
    );
    expect(init.headers).toEqual({ Authorization: "Bearer cf-token" });
    const form = init.body as FormData;
    expect(["prompt", "width", "height"].map((key) => form.get(key))).toEqual([
      "a fox",
      "768",
      "1024",
    ]);
  });

  test("draws a square by default", async () => {
    const fetch = respondWith({ success: true, result: { image: "AQID" } });

    await provider.generate({ prompt: "a fox" });

    const form = (fetch.mock.calls[0][1] as RequestInit).body as FormData;
    expect([form.get("width"), form.get("height")]).toEqual(["1024", "1024"]);
  });

  test("says when the daily free quota is used up", async () => {
    respondWith(
      { success: false, errors: [{ code: 3036, message: "limited" }] },
      429,
    );

    await expect(provider.generate({ prompt: "a fox" })).rejects.toThrow(
      "The daily free image quota is used up. It resets at 00:00 UTC.",
    );
  });

  test("says when Cloudflare is out of capacity", async () => {
    respondWith(
      { success: false, errors: [{ code: 3040, message: "busy" }] },
      429,
    );

    await expect(provider.generate({ prompt: "a fox" })).rejects.toThrow(
      "out of capacity",
    );
  });

  test("passes on any other error message", async () => {
    respondWith(
      { success: false, errors: [{ code: 5007, message: "No such model" }] },
      400,
    );

    await expect(provider.generate({ prompt: "a fox" })).rejects.toThrow(
      "Cloudflare Workers AI failed (HTTP 400): No such model",
    );
  });

  test("fails cleanly on a response that isn't JSON", async () => {
    respondWith("<html>Bad gateway</html>", 502);

    await expect(provider.generate({ prompt: "a fox" })).rejects.toThrow(
      "Cloudflare Workers AI failed (HTTP 502): no details",
    );
  });
});
