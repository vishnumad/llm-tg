export const MAX_MESSAGE_LENGTH = 4096;

const FENCE = "```";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Convert the markdown subset models write into Telegram's HTML dialect. */
export function markdownToTelegramHtml(markdown: string): string {
  // Code and link URLs are swapped for placeholders until the end, so the
  // formatting rules below can't reach inside them.
  const stash: string[] = [];
  const hide = (html: string) => `\0${stash.push(html) - 1}\0`;
  const restore = (text: string): string =>
    text.replace(/\0(\d+)\0/g, (_, index) => restore(stash[Number(index)]));

  const html = escapeHtml(markdown.replace(/\r\n?/g, "\n"))
    .replace(/```(?:[^\n`]*\n)?([\s\S]*?)```/g, (_, code) =>
      hide(`<pre><code>${code}</code></pre>`),
    )
    .replace(/``([\s\S]*?)``/g, (_, code) => hide(`<code>${code}</code>`))
    .replace(/`([^`\n]+)`/g, (_, code) => hide(`<code>${code}</code>`))
    .replace(
      /\[([^\]\n]+)\]\(([^()\n]*(?:\([^)\n]*\)[^()\n]*)*)\)/g,
      (_, label, url) => `<a href="${hide(url)}">${label}</a>`,
    )
    .replace(/^#{1,6}[ \t]+(.+)$/gm, (_, heading) => `<b>${heading.trim()}</b>`)
    .replace(
      /^&gt;[ \t]?.*(?:\n&gt;[ \t]?.*)*/gm,
      (quote) =>
        `<blockquote>${quote.replace(/^&gt;[ \t]?/gm, "")}</blockquote>`,
    )
    // Emphasis only opens and closes at a word boundary, so `2**10` and
    // `__init__` stay as written.
    .replace(/~~(\S|\S.*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^\w*])\*\*(\S|\S.*?\S)\*\*(?![\w*])/g, "$1<b>$2</b>")
    .replace(/(^|[^\w*])\*(\S|\S.*?\S)\*(?![\w*])/g, "$1<i>$2</i>")
    .replace(/(^|\W)_([^\s_]|[^\s_].*?[^\s_])_(?!\w)/g, "$1<i>$2</i>")
    .replace(/^([ \t]*)([-*+]|\d+\.)[ \t]+/gm, (_, indent, marker) => {
      const level = Math.floor(indent.length / 2);
      const bullet = /\d/.test(marker) ? marker : level === 0 ? "•" : "◦";
      return `${"  ".repeat(level)}${bullet} `;
    });

  return restore(html).trim();
}

/**
 * Fold rendered HTML into one expandable blockquote, so a long answer shows
 * only its first few lines until tapped. Telegram can't nest blockquotes, so
 * quotes inside it mark each line with a bar instead.
 */
export function collapseHtml(html: string): string {
  const flattened = html.replace(
    /<blockquote>([\s\S]*?)<\/blockquote>/g,
    (_, quote: string) => quote.replace(/^/gm, "▎ "),
  );
  return `<blockquote expandable>${flattened}</blockquote>`;
}

function findCut(window: string): number {
  // Only accept a break in the back half, so every chunk makes real progress.
  for (const separator of ["\n", " "]) {
    const index = window.lastIndexOf(separator);
    if (index > window.length / 2) {
      return index;
    }
  }
  return window.length;
}

/**
 * Split markdown into chunks that each fit in one Telegram message, breaking
 * at line ends or spaces where possible. A code block cut in two is closed at
 * the end of one chunk and reopened at the start of the next.
 *
 * Telegram limits the rendered text, which conversion only ever shortens, so
 * the markdown's own length is a safe bound for both HTML and the plain-text
 * fallback.
 */
export function splitMarkdown(
  markdown: string,
  limit = MAX_MESSAGE_LENGTH,
): string[] {
  const chunks: string[] = [];
  let rest = markdown.trim();

  while (rest.length > limit) {
    const window = rest.slice(0, limit - `\n${FENCE}`.length);
    const cut = findCut(window);
    let chunk = rest.slice(0, cut);
    rest = rest.slice(cut < window.length ? cut + 1 : cut);

    const fenceCount = chunk.split(FENCE).length - 1;
    if (fenceCount % 2 === 1) {
      chunk += `\n${FENCE}`;
      rest = `${FENCE}\n${rest}`;
    }
    chunks.push(chunk);
  }

  chunks.push(rest);
  return chunks;
}
