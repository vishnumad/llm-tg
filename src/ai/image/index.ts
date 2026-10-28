import { config } from "../../config";
import { createPerchanceProvider } from "./perchance";
import type { ImageProvider } from "./provider";

export function createImageProvider(
  settings: NonNullable<typeof config.image>,
): ImageProvider {
  switch (settings.provider) {
    case "perchance":
      return createPerchanceProvider(settings.executablePath);
  }
}

export const imageProvider = config.image && createImageProvider(config.image);
