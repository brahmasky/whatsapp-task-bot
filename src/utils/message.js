/**
 * Split a long string into chunks that fit within WhatsApp's message size limit.
 * Breaks at newlines first, then spaces, to avoid splitting mid-word.
 *
 * @param {string} text - The text to split
 * @param {number} maxLength - Maximum length per chunk (default 3800, safely under 4096)
 * @returns {string[]} Array of chunks
 */
export function splitMessage(text, maxLength = 3800) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Prefer breaking at a newline, fall back to a space, last resort hard-cut
    let breakPoint = remaining.lastIndexOf('\n', maxLength);
    if (breakPoint < maxLength * 0.5) {
      breakPoint = remaining.lastIndexOf(' ', maxLength);
    }
    if (breakPoint < maxLength * 0.5) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * Send a potentially long message, splitting it into chunks if needed.
 * Adds [1/N] prefix when more than one chunk is needed.
 *
 * @param {Function} replyFn - ctx.reply or equivalent async send function
 * @param {string} text - The message text
 * @param {number} maxLength - Maximum length per chunk
 */
export async function replyLong(replyFn, text, maxLength = 3800) {
  const chunks = splitMessage(text, maxLength);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ` : '';
    await replyFn(prefix + chunks[i]);
  }
}
