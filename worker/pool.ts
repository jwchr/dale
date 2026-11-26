/** Runs `run` over `items` with at most `limit` running at once, so archive calls never queue
 *  behind a Worker's 6 open connections while their own timeout is already counting (Flash, #304). */
export const ARCHIVE_CONNECTIONS = 2;
/** The live bus poll waits for the archive turn, so each archive stops starting calls 12 s into its turn
 *  and ends every call by 20 s, however slow the agency is (Neon, #303 and #304). */
export const ARCHIVE_START_MS = 12_000, ARCHIVE_TURN_MS = 20_000;
export async function inPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => { while (next < items.length) await run(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** An HTML or XML page (a maintenance or firewall page) is never saved as agency data (Neon, #303 and #304). */
export const looksLikeMarkup = (bytes: Uint8Array): boolean => {
  let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (at < bytes.length && (bytes[at] === 0x20 || bytes[at] === 0x09 || bytes[at] === 0x0a || bytes[at] === 0x0d)) at++;
  return bytes[at] === 0x3c;
};

