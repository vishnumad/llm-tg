import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { logToolCall } from "../tool-logging";
import {
  IMAGE_SHAPES,
  type ImageProvider,
  type ImageRequest,
} from "./provider";

export type SendImage = (image: Uint8Array) => Promise<unknown>;

/** The photos the user sent with this turn, each within `maxSide` pixels. */
export type LoadImages = (maxSide: number) => Promise<Uint8Array[]>;

const NO_NEGATIONS =
  "Describe only what should appear, since writing 'no X' tends to add X.";

export function createImageTools(
  provider: ImageProvider,
  sendImage: SendImage,
  loadImages?: LoadImages,
): ToolSet {
  async function draw(request: ImageRequest) {
    await sendImage(await provider.generate(request));
    return "The image was sent to the chat.";
  }

  const generateImage = tool({
    description:
      "Generate a new image and send it to the chat. Use it whenever the user asks for a picture, drawing or photo. The image model sees only your prompt, not the conversation or earlier images, so describe the whole image every time, in English. To change an existing image, the user has to send it or reply to it.",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          `What the image shows: subject, setting, style, lighting, composition. ${NO_NEGATIONS}`,
        ),
      shape: z.enum(IMAGE_SHAPES).optional(),
    }),
    execute: (request) =>
      logToolCall(
        "generate_image",
        { provider: provider.name, ...request },
        () => draw(request),
      ),
  });

  if (!loadImages) {
    return { generateImage };
  }

  const editImage = tool({
    description:
      "Edit the photos the user sent or replied to, and send the result to the chat. Use it when the user asks to change, restyle or combine them. The image model sees those photos and your prompt, numbered from image 0: the user's own photo first, then the one they replied to.",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          `The change to make, in English, e.g. 'make the sky stormy' or 'put the dog from image 1 next to the woman in image 0'. ${NO_NEGATIONS}`,
        ),
      shape: z
        .enum(IMAGE_SHAPES)
        .optional()
        .describe("The one closest to the photo's, to keep its framing."),
    }),
    execute: (request) =>
      logToolCall(
        "edit_image",
        { provider: provider.name, ...request },
        async () =>
          draw({
            ...request,
            inputs: await loadImages(provider.maxInputSide),
          }),
      ),
  });

  return { generateImage, editImage };
}
