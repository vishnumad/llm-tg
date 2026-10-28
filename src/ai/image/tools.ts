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
        "Generate an image and send it to the chat. Use it whenever the user asks for a picture, drawing or photo. Describe the image in detail, in English.",
      inputSchema: z.object({
        prompt: z
          .string()
          .describe(
            "What the image shows: subject, setting, style, lighting, composition.",
          ),
        negativePrompt: z
          .string()
          .optional()
          .describe("Things to keep out of the image."),
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
