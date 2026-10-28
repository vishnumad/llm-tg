import { chromium, type Page } from "playwright-core";
import type { ImageProvider, ImageRequest, ImageShape } from "./provider";

// Perchance has no public API. Its own pages call these endpoints, and they
// only answer a real browser, so each generation drives a headless Chromium.
const API_URL = "https://image-generation.perchance.org/api";
const REQUEST_TIMEOUT_MS = 120_000;

const RESOLUTIONS: Record<ImageShape, string> = {
  square: "768x768",
  portrait: "512x768",
  landscape: "768x512",
};

type GenerateResponse = { status?: string; imageId?: string };

function apiUrl(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams({
    ...params,
    __cacheBust: String(Math.random()),
  });
  return `${API_URL}/${path}?${query}`;
}

async function fetchUserKey(page: Page): Promise<string> {
  await page.goto(apiUrl("verifyUser", { thread: "0" }));
  const content = await page.content();
  const userKey = content.match(/"userKey":"([^"]+)"/)?.[1];
  if (!userKey) {
    throw new Error(
      content.includes("too_many_requests")
        ? "Perchance is rate limiting requests, try again later"
        : "Perchance didn't hand out a user key",
    );
  }
  return userKey;
}

function requestImage(
  page: Page,
  userKey: string,
  { prompt, negativePrompt = "", shape = "square" }: ImageRequest,
): Promise<GenerateResponse> {
  const requestId = `aiImageCompletion${Math.floor(Math.random() * 2 ** 30)}`;
  const url = apiUrl("generate", { userKey, requestId });
  const body = {
    generatorName: "ai-image-generator",
    channel: "ai-text-to-image-generator",
    subChannel: "public",
    prompt,
    negativePrompt,
    seed: -1,
    resolution: RESOLUTIONS[shape],
    guidanceScale: 7,
  };

  return page.evaluate(
    async ({ url, body, timeoutMs }) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return (await response.json()) as GenerateResponse;
    },
    { url, body, timeoutMs: REQUEST_TIMEOUT_MS },
  );
}

function findString(
  value: unknown,
  matches: (text: string) => boolean,
): string | undefined {
  if (typeof value === "string") {
    return matches(value) ? value : undefined;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findString(item, matches);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

/** Where to download the image from, best first. */
function downloadUrls(response: GenerateResponse, imageId: string): string[] {
  // Perchance doesn't say which field holds its proxy download, so any string
  // in the response that looks like one counts.
  const proxyPath = findString(response, (text) =>
    text.includes("downloadTemporaryImageViaProxy"),
  );
  const proxyToken = findString(
    response,
    (text) => text.startsWith("v1.") && text.length > 80,
  );
  const paths = [
    proxyPath ??
      (proxyToken && `/downloadTemporaryImageViaProxy?t=${proxyToken}`),
    `downloadTemporaryImage?imageId=${imageId}`,
  ];
  return paths
    .filter((path) => path !== undefined)
    .map((path) => new URL(path, `${API_URL}/`).href);
}

async function download(page: Page, urls: string[]): Promise<Uint8Array> {
  const result = await page.evaluate(
    async ({ urls, timeoutMs }) => {
      const failures: string[] = [];
      for (const url of urls) {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          return new Uint8Array(await response.arrayBuffer());
        }
        failures.push(`${response.status} ${url}`);
      }
      return failures.join(", ");
    },
    { urls, timeoutMs: REQUEST_TIMEOUT_MS },
  );
  if (typeof result === "string") {
    throw new Error(`Couldn't download the image from Perchance: ${result}`);
  }
  return result;
}

async function generateOnce(
  request: ImageRequest,
  executablePath: string | undefined,
): Promise<Uint8Array> {
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage();
    const userKey = await fetchUserKey(page);
    const response = await requestImage(page, userKey, request);
    if (!response.imageId) {
      throw new Error(
        `Perchance didn't generate the image: ${response.status ?? JSON.stringify(response)}`,
      );
    }
    return await download(page, downloadUrls(response, response.imageId));
  } finally {
    await browser.close();
  }
}

export function createPerchanceProvider(
  executablePath?: string,
): ImageProvider {
  let previous: Promise<unknown> = Promise.resolve();

  return {
    name: "perchance",

    // Perchance turns away a generation while the previous one is running.
    generate(request) {
      const next = previous.then(() => generateOnce(request, executablePath));
      previous = next.catch(() => {});
      return next;
    },
  };
}
