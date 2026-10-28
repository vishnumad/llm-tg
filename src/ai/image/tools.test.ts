import { describe, expect, mock, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { ImageProvider } from "./provider";
import { createImageTools } from "./tools";

const options = { toolCallId: "1", messages: [] } as ToolExecutionOptions;
const IMAGE = new Uint8Array([1, 2, 3]);

function fakeProvider(generate = mock(async () => IMAGE)): ImageProvider {
  return { name: "fake", generate };
}

describe("createImageTools", () => {
  test("generateImage sends the provider's image to the chat", async () => {
    const provider = fakeProvider();
    const sendImage = mock(async () => {});
    const { generateImage } = createImageTools(provider, sendImage);
    const request = { prompt: "a fox", shape: "landscape" } as const;

    const result = await generateImage.execute?.(request, options);

    expect(provider.generate).toHaveBeenCalledWith(request);
    expect(sendImage).toHaveBeenCalledWith(IMAGE);
    expect(result).toBe("The image was sent to the chat.");
  });

  test("rethrows provider errors so the model sees them", async () => {
    const sendImage = mock(async () => {});
    const { generateImage } = createImageTools(
      fakeProvider(
        mock(async () => {
          throw new Error("rate limited");
        }),
      ),
      sendImage,
    );

    await expect(
      generateImage.execute?.({ prompt: "a fox" }, options),
    ).rejects.toThrow("rate limited");
    expect(sendImage).not.toHaveBeenCalled();
  });
});
