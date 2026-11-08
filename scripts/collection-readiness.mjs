// Read-only readiness acquisition; callers retain all proof predicates.
export async function waitForReadiness(read, { clock = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = clock() + timeoutMs;
  // Attempt cap also bounds a broken/nonadvancing injected clock.
  for (let attempt = 0; attempt < Math.ceil(timeoutMs / intervalMs); attempt++) {
    const remaining = deadline - clock();
    if (remaining <= 0) return undefined;
    const result = await read(Math.max(1, Math.min(10_000, remaining)));
    if (clock() >= deadline) return undefined;
    if (result) return result;
    const rest = deadline - clock();
    if (rest <= 0) return undefined;
    await sleep(Math.min(intervalMs, rest));
  }
  return undefined;
}
