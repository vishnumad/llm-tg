import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { launchChromium } from "../../test-setup";
import { createPerchanceProvider } from "./perchance";

const API = "https://image-generation.perchance.org/api";
const IMAGE = new Uint8Array([1, 2, 3]);
const KEY_PAGE = '<pre>{"status":"success","userKey":"key-1"}</pre>';

type Route = (url: URL, init?: RequestInit) => Response | undefined;

let pageContent: string;
let route: Route;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const browser = {
  newPage: async () => ({
    goto: async () => {},
    content: async () => pageContent,
    evaluate: <A, R>(run: (arg: A) => R, arg: A) => run(arg),
  }),
  close: mock(async () => {}),
};

function generated(extra: Record<string, unknown> = {}): Route {
  return (url) => {
    if (url.pathname === "/api/generate") {
      return Response.json({ status: "success", imageId: "img-1", ...extra });
    }
    if (url.pathname === "/api/downloadTemporaryImage") {
      return new Response(IMAGE);
    }
  };
}

function requestedUrls() {
  return fetchSpy.mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
  pageContent = KEY_PAGE;
  route = generated();
  browser.close.mockClear();
  launchChromium.mockReset();
  launchChromium.mockResolvedValue(browser);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    (async (input: string | URL | Request, init?: RequestInit) =>
      route(new URL(String(input)), init) ??
      new Response("not found", { status: 404 })) as typeof fetch,
  );
});

afterEach(() => fetchSpy.mockRestore());

describe("createPerchanceProvider", () => {
  test("generates with the user key and downloads the image", async () => {
    const provider = createPerchanceProvider("/usr/bin/chromium");

    const image = await provider.generate({
      prompt: "a fox",
      negativePrompt: "blur",
      shape: "portrait",
    });

    expect(image).toEqual(IMAGE);
    expect(launchChromium).toHaveBeenCalledWith({
      executablePath: "/usr/bin/chromium",
    });
    const [[generateUrl, init]] = fetchSpy.mock.calls;
    expect(new URL(String(generateUrl)).searchParams.get("userKey")).toBe(
      "key-1",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      prompt: "a fox",
      negativePrompt: "blur",
      resolution: "512x768",
    });
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test("downloads through the proxy link the response carries", async () => {
    const token = `v1.${"t".repeat(100)}`;
    route = (url) => {
      if (url.pathname === "/downloadTemporaryImageViaProxy") {
        return new Response(IMAGE);
      }
      return generated({ download: { token } })(url);
    };

    await createPerchanceProvider().generate({ prompt: "a fox" });

    expect(requestedUrls().slice(1)).toEqual([
      `https://image-generation.perchance.org/downloadTemporaryImageViaProxy?t=${token}`,
    ]);
  });

  test("falls back to the plain download when the proxy fails", async () => {
    route = generated({ url: "/api/downloadTemporaryImageViaProxy?t=gone" });

    const image = await createPerchanceProvider().generate({ prompt: "a fox" });

    expect(image).toEqual(IMAGE);
    expect(requestedUrls().slice(1)).toEqual([
      `${API}/downloadTemporaryImageViaProxy?t=gone`,
      `${API}/downloadTemporaryImage?imageId=img-1`,
    ]);
  });

  test("lists every failed download", async () => {
    route = (url) =>
      url.pathname === "/api/generate" ? generated()(url) : undefined;

    await expect(
      createPerchanceProvider().generate({ prompt: "a fox" }),
    ).rejects.toThrow(
      `Couldn't download the image from Perchance: 404 ${API}/downloadTemporaryImage?imageId=img-1`,
    );
  });

  test("says when Perchance is rate limiting, and closes the browser", async () => {
    pageContent = '<pre>{"status":"too_many_requests"}</pre>';

    await expect(
      createPerchanceProvider().generate({ prompt: "a fox" }),
    ).rejects.toThrow("rate limiting");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test("passes on the status of a failed generation", async () => {
    route = () => Response.json({ status: "invalid_key" });

    await expect(
      createPerchanceProvider().generate({ prompt: "a fox" }),
    ).rejects.toThrow("Perchance didn't generate the image: invalid_key");
  });

  test("runs one generation at a time, even after a failure", async () => {
    const provider = createPerchanceProvider();
    const firstLaunch = Promise.withResolvers<typeof browser>();
    launchChromium.mockReturnValueOnce(firstLaunch.promise);

    const first = provider.generate({ prompt: "one" });
    const second = provider.generate({ prompt: "two" });
    await Bun.sleep(0);
    expect(launchChromium).toHaveBeenCalledTimes(1);

    firstLaunch.reject(new Error("no chromium"));
    await expect(first).rejects.toThrow("no chromium");
    expect(await second).toEqual(IMAGE);
    expect(launchChromium).toHaveBeenCalledTimes(2);
  });
});
