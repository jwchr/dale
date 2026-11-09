// One-shot, reviewed-main capability check. Never export tokens, agency rows or raw errors.
const HOST = 'https://raildata.njtransit.com';
const DEADLINE_MS = 15_000;
// Exact code/name pairs from the official RailData V2.1 station appendix. Secaucus has two rail levels.
const STATIONS = [
  { key: 'anderson', code: 'AS', name: 'Anderson Street', line: 'PV' },
  { key: 'essex', code: 'EX', name: 'Essex Street', line: 'PV' },
  { key: 'secaucus-lower', code: 'TS', name: 'Secaucus Lower Lvl', line: 'PV' },
  { key: 'secaucus-upper', code: 'SE', name: 'Secaucus Upper Lvl', line: '' },
  { key: 'new-york-penn', code: 'NY', name: 'New York Penn Station', line: '' },
];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const present = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 128;

async function request(path, fields, maxBytes, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    const response = await fetchImpl(HOST + path, { method: 'POST', body,
      headers: { accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: controller.signal });
    if (response.status === 401 || response.status === 403) return { status: 'access-denied' };
    if (response.status === 429) return { status: 'rate-limited' };
    if (!response.ok) return { status: 'http-error' };
    if (!response.body) return { status: 'unexpected-response' };
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          void reader.cancel().catch(() => {});
          return { status: 'response-too-large' };
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value;
    try { value = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return { status: 'unexpected-response' }; }
    if (object(value) && typeof value.errorMessage === 'string') {
      return { status: /daily usage limit/i.test(value.errorMessage) ? 'rate-limited' : 'api-error' };
    }
    return { status: 'ok', value };
  } catch {
    return { status: controller.signal.aborted ? 'timed-out' : 'network-error' };
  } finally { clearTimeout(timer); controller.abort(); }
}

async function authenticate(product, credentials, fetchImpl) {
  const result = await request(`/api/${product}/getToken`, credentials, 16_384, fetchImpl);
  if (result.status !== 'ok') return result;
  const flag = result.value?.Authenticated;
  if (flag === false || (typeof flag === 'string' && flag.trim().toLowerCase() === 'false')) return { status: 'access-denied' };
  if (!(flag === true || (typeof flag === 'string' && flag.trim().toLowerCase() === 'true'))
    || typeof result.value?.UserToken !== 'string' || !result.value.UserToken.trim()) return { status: 'unexpected-response' };
  return { status: 'authenticated', token: result.value.UserToken };
}

function stationSummary(value, station) {
  if (!object(value) || value.STATION_2CHAR !== station.code || value.STATIONNAME !== station.name
    || !Array.isArray(value.ITEMS) || value.ITEMS.length > 19
    || !value.ITEMS.every(row => object(row) && present(row.TRAIN_ID) && present(row.SCHED_DEP_DATE))) {
    return { status: 'unexpected-schema' };
  }
  const rows = value.ITEMS;
  return {
    status: rows.length ? 'schema-confirmed' : 'empty-at-check', rows: rows.length,
    pvlRows: rows.filter(row => row.LINECODE === 'PV').length,
    modifiedTimeFields: rows.filter(row => present(row.LAST_MODIFIED)).length,
    gpsTimeFields: rows.filter(row => present(row.GPSTIME)).length,
    // The documented local timestamp strings do not establish a timezone or freshness.
    sourceTime: 'timezone-and-freshness-unverified',
  };
}

export async function checkRailApi(credentials, fetchImpl = globalThis.fetch) {
  if (typeof credentials?.username !== 'string' || !credentials.username.trim()
    || typeof credentials?.password !== 'string' || !credentials.password.trim()) return { status: 'configuration-missing' };
  const result = { status: 'checked', receivedAt: new Date().toISOString(), products: {}, stations: {} };
  let railToken;
  try {
    // At most one token request per product, no validation request, retry or fallback host.
    for (const product of ['TrainData', 'GTFSRT']) {
      const auth = await authenticate(product, credentials, fetchImpl);
      result.products[product] = auth.status;
      if (product === 'TrainData') railToken = auth.token;
      if (auth.status === 'rate-limited') { result.status = 'rate-limited'; return result; }
    }
    // GTFSRT entitlement is authentication-only. No full feed/systemwide download or archive.
    result.gtfsFeed = 'not-requested-coverage-unknown';
    if (!railToken) { result.stationCoverage = 'not-requested-authentication-unavailable'; return result; }
    const listed = await request('/api/TrainData/getStationList', { token: railToken }, 262_144, fetchImpl);
    if (listed.status !== 'ok') { result.stationCoverage = listed.status; return result; }
    if (!Array.isArray(listed.value) || !listed.value.every(object)) { result.stationCoverage = 'unexpected-schema'; return result; }
    result.stationCoverage = 'checked';
    for (const station of STATIONS) {
      const candidates = listed.value.filter(row => row.STATION_2CHAR === station.code || row.STATIONNAME === station.name);
      if (candidates.length !== 1 || candidates[0].STATION_2CHAR !== station.code || candidates[0].STATIONNAME !== station.name) {
        result.stations[station.key] = { status: candidates.length ? 'station-identity-unconfirmed' : 'station-not-listed' };
        continue;
      }
      const sample = await request('/api/TrainData/getTrainSchedule19Rec', { token: railToken, station: station.code, line: station.line }, 524_288, fetchImpl);
      result.stations[station.key] = sample.status === 'ok' ? stationSummary(sample.value, station) : { status: sample.status };
      if (sample.status === 'rate-limited') { result.status = 'rate-limited'; return result; }
    }
    return result;
  } finally { railToken = undefined; }
}

export async function runRailConnectionCheck(env = process.env, fetchImpl = globalThis.fetch, log = console.log) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/main'
    || env.GITHUB_REPOSITORY !== 'jwchr/dale' || env.NJT_API_CHECK_SCOPE !== 'rail'
    || env.NJT_RAIL_TOKEN_WINDOW_CONFIRMED !== 'true') {
    log('Rail check requires reviewed main, explicit rail scope and operator confirmation of no rail token check in the past 24 hours. No request sent.');
    return 2;
  }
  try {
    const result = await checkRailApi({ username: env.NJT_API_USERNAME, password: env.NJT_API_PASSWORD }, fetchImpl);
    log(JSON.stringify(result));
    log('One bounded capability sample only. Receipt is not source time; source timezone/freshness and GTFS feed coverage remain unverified. No current rail app, connection guarantee, collection or polling enabled.');
    return result.status === 'checked' && result.products.TrainData === 'authenticated' && result.products.GTFSRT === 'authenticated'
      && result.stationCoverage === 'checked' && Object.keys(result.stations).length === STATIONS.length
      && Object.values(result.stations).every(s => s.status === 'schema-confirmed' || s.status === 'empty-at-check') ? 0 : 1;
  } catch {
    log('Rail check failed unexpectedly. No response details logged.');
    return 1;
  }
}
