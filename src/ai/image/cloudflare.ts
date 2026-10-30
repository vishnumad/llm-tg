import { logger } from "../../logger";
import type { ImageProvider, ImageShape } from "./provider";

type CloudflareSettings = {
  accountId: string;
  apiToken: string;
  modelId: string;
};

// Billed per 512x512 tile, so each shape stays within four.
const SIZES: Record<ImageShape, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 768, height: 1024 },
  landscape: { width: 1024, height: 768 },
};

const TIMEOUT_MS = 60_000;
const DAILY_LIMIT_REACHED = 3036;
const OUT_OF_CAPACITY = 3040;

type RunResponse = {
  success?: boolean;
  result?: { image?: string };
  errors?: { code: number; message: string }[];
};

function describeFailure(status: number, { errors = [] }: RunResponse) {
  const has = (code: number) => errors.some((error) => error.code === code);
  if (has(DAILY_LIMIT_REACHED)) {
    return "The daily free image quota is used up. It resets at 00:00 UTC.";
  }
  if (has(OUT_OF_CAPACITY)) {
    return "Cloudflare is out of capacity right now. Try again shortly.";
  }
  return `Cloudflare Workers AI failed (HTTP ${status}): ${errors[0]?.message ?? "no details"}`;
}

/** Speaks the multipart request shape of the FLUX.2 models. */
export function createCloudflareProvider({
  accountId,
  apiToken,
  modelId,
}: CloudflareSettings): ImageProvider {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;

  return {
    name: "cloudflare",
    maxInputSide: 512,

    async generate({ prompt, shape = "square", inputs = [] }) {
      const { width, height } = SIZES[shape];
      const form = new FormData();
      form.append("prompt", prompt);
      form.append("width", String(width));
      form.append("height", String(height));
      inputs.forEach((image, index) => {
        form.append(`input_image_${index}`, new Blob([image]));
      });

      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}` },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({}))) as RunResponse;
      const image = body.result?.image;
      if (!response.ok || !body.success || !image) {
        throw new Error(describeFailure(response.status, body));
      }

      logger.info("cloudflare.image", {
        modelId,
        width,
        height,
        inputCount: inputs.length,
      });
      return Buffer.from(image, "base64");
    },
  };
}
