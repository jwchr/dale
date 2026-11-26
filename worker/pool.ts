/** Runs `run` over `items` with at most `limit` running at once, so archive calls never queue
 *  behind a Worker's 6 open connections while their own timeout is already counting (Flash, #304). */
export const ARCHIVE_CONNECTIONS = 2;
export async function inPool<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => { while (next < items.length) await run(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
