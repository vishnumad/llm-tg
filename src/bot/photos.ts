import type { FilePart } from "ai";
import type { Context } from "grammy";
import type { PhotoSize } from "grammy/types";

async function download(ctx: Context, size: PhotoSize): Promise<Buffer> {
  const file = await ctx.api.getFile(size.file_id);
  if (!file.file_path) {
    throw new Error(`Telegram returned no download path for ${file.file_id}`);
  }

  const response = await fetch(
    `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`,
  );
  if (!response.ok) {
    throw new Error(`Photo download failed with status ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Photos on the message and the one it replies to. Telegram lists each one's sizes from small to large. */
function photosOf(ctx: Context): PhotoSize[][] {
  return [ctx.msg?.photo, ctx.msg?.reply_to_message?.photo].filter(
    (sizes) => sizes !== undefined,
  );
}

export function downloadPhotos(ctx: Context): Promise<FilePart[]> {
  return Promise.all(
    photosOf(ctx).map(
      async (sizes): Promise<FilePart> => ({
        type: "file",
        // Telegram re-encodes every photo it receives as JPEG.
        mediaType: "image/jpeg",
        data: (await download(ctx, sizes[sizes.length - 1])).toString("base64"),
      }),
    ),
  );
}

/** The same photos as `downloadPhotos`, at the largest size within `maxSide` pixels. */
export function downloadPhotosWithin(
  ctx: Context,
  maxSide: number,
): Promise<Uint8Array[]> {
  return Promise.all(
    photosOf(ctx).map((sizes) =>
      download(
        ctx,
        sizes.findLast(
          ({ width, height }) => Math.max(width, height) <= maxSide,
        ) ?? sizes[0],
      ),
    ),
  );
}
