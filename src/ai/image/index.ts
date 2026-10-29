import { config } from "../../config";
import { createCloudflareProvider } from "./cloudflare";
import type { ImageProvider } from "./provider";

export function createImageProvider(
  settings: NonNullable<typeof config.image>,
): ImageProvider {
  switch (settings.provider) {
    case "cloudflare":
      return createCloudflareProvider(settings);
  }
}

export const imageProvider = config.image && createImageProvider(config.image);
