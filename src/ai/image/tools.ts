import { tool } from "ai";
import { z } from "zod";
import { logToolCall } from "../tool-logging";
import { IMAGE_SHAPES, type ImageProvider } from "./provider";

export type SendImage = (image: Uint8Array) => Promise<unknown>;

export function createImageTools(
  provider: ImageProvider,
  sendImage: SendImage,
) {
  return {
    generateImage: tool({
      description:
        "Generate a new image and send it to the chat. Use it whenever the user asks for a picture, drawing or photo. The image model sees only your prompt, not the conversation, and can't edit earlier images, so describe the whole image every time, in English.",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "What the image shows: subject, setting, style, lighting, composition.",
          ),
        negativePrompt: z
          .string()
          .optional()
          .describe(
            "Things to keep out of the image, as a plain list, e.g. 'blurry, text, watermark'. Put them here rather than writing 'no X' in the prompt.",
          ),
        shape: z.enum(IMAGE_SHAPES).optional(),
      }),
      execute: (request) =>
        logToolCall(
          "generate_image",
          { provider: provider.name, ...request },
          async () => {
            await sendImage(await provider.generate(request));
            return "The image was sent to the chat.";
          },
        ),
    }),
  };
}
