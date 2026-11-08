import { AppHeader } from './AppHeader';
import { changeFavoriteStops } from '../domain/cityStops';
import { CommutePicker, type CommutePickEnd } from './CommutePicker';
import { SignText } from './SignText';
import { DepartureTimes } from './DepartureTimes';
import { ARRIVAL_KEY, observedDestinationArrival, readLastArrival, saveLastArrival } from '../domain/destinationArrival';
import { ArrivalResult } from './DestinationArrival';
import { useEffect, useId, useMemo, useRef, useState, type Ref } from 'react';
import { demoDataset, demoUsualGates } from '../data/demo';
import { parseDataset } from '../domain/dataset';
import { checkDirection, destinationsFrom, returnLeg, searchStops } from '../domain/direction';
import { addFavorite, isGeneratedFavoriteLabel, loadFavorites, moveFavorite, removeFavorite, renameFavorite, saveFavorites, setLeavePlan, type Favorite } from '../domain/favorites';
import { ARRIVE_BY_WINDOW_MS, arriveByDeadline, arriveByPick, canWalkTo, earliestArrival, leaveAdvice, MAX_CUSHION_MIN, MAX_WALK_MIN, type LeaveOption, type LeavePlan } from '../domain/leaveBy';
import { nextExpress } from '../domain/nextExpress';
import { fareBetween } from '../domain/fare';
import { gateFor, type GateAnswer } from '../domain/gate';
import { isNjtHoliday } from '../domain/holidays';
import { createBusSession, reduceBusSession, type BusSession, type BusSessionEvent } from '../domain/busLock';
import { forgetLock, loadLock, saveLock, type SavedLock } from '../domain/lockStore';
import { clearHistory, pruneHistory, recordSession, summarize, type PastReport } from '../domain/reportHistory';
import { departuresOn, nextDepartures, tripArrivalAt, tripStopTimes } from '../domain/schedule';
import { addDays, clockChangeBetween, formatTime12, localYmd, weekdayIndex, zonedWallTime } from '../domain/time';
import type { Dataset, Departure, Stop } from '../domain/types';
import type { RescueOption } from '../domain/rescue';
import { strings, type Lang, type Strings } from './i18n';
import { BoardingCheck } from './BoardingCheck';
import { boardingInfo, destinationGroups } from '../domain/stopInfo';
import { StopChoice } from './StopChoice';
import { StopSign } from './StopSign';
import { TourGuide } from './TourGuide';
import { NearMe } from './NearMe';
import { Rescue } from './Rescue';
import { PennGuide, useJourneyChecklist, type JourneyModel } from './PennGuide';
import { TravelModeSelector } from './TravelModeSelector';
import { RiderGuide } from './RiderGuide';
import { TicketGuide } from './TicketGuide';
import { SKINS, SkinBackdrop, type Skin } from './SkinBackdrop';
import { BusLockPanel } from './BusLockPanel';
import { liveApiUrl } from '../domain/liveBus';
import { loadLiveSchedule } from '../data/liveSchedule';
import { useLiveBus } from './useLiveBus';
import { LiveBusStatus } from './LiveBusStatus';
import { useLiveDepartures } from './useLiveDepartures';
import { departureEvidence, departureKey, requestFor, type DepartureEvidence } from '../domain/liveDepartures';
import { upcomingCandidates, selectUpcoming, type UpcomingSet } from '../domain/upcoming';
import { LastReturnCard } from './LastReturnCard';
import { PastReports } from './PastReports';

type Theme = 'system' | 'light' | 'dark';
interface Settings { lang: Lang; theme: Theme; count: 3 | 5; skin: Skin; liveMotion: boolean }
interface Leg { fromStopId: string; toStopId: string; routeIds: string[] }
interface ActiveLock { dep: Departure; leg: Leg; session: BusSession }
type Screen =
  | { name: 'home' }
  | { name: 'search' }
  | { name: 'commute'; favoriteId: string; reversed: boolean; end: CommutePickEnd; level: 'city' | 'stop' }
  | { name: 'timetable'; leg: Leg; title: string; date?: string }
  | { name: 'departure'; dep: Departure; leg: Leg }
  | { name: 'settings' }
  | { name: 'guide' }
  | { name: 'penn'; railOnly?: boolean }
  | { name: 'boarding'; dep: Departure; leg: Leg }
  | { name: 'rescue'; fromStopId: string; homeStopId: string; usualRouteId?: string; label: 'home' | 'other' };

const rawStore = (() => { try { return window.localStorage; } catch { return undefined; } })();
const LIVE_API = liveApiUrl(import.meta.env.VITE_LIVE_API_URL);
const sourceParams = new URLSearchParams(location.search);
const liveMode = !sourceParams.has('demo') && (sourceParams.has('live') || (!sourceParams.has('printed') && (() => {
  try { return rawStore?.getItem('arriba.source.v1') === 'live'; } catch { return false; }
})()));
try {
  if (sourceParams.has('live') && LIVE_API) rawStore?.setItem('arriba.source.v1', 'live');
  if (sourceParams.has('printed')) rawStore?.setItem('arriba.source.v1', 'printed');
} catch { /* A blocked preference never prevents opening a source explicitly. */ }
// The rider confirms current GTFS stops when first using live mode. Never rewrite printed favorites/locks.
const storageKey = (key: string) => liveMode && ['arriba.favorites.v1', 'arriba.lock.v1', ARRIVAL_KEY].includes(key) ? key + '.g2' : key;
const store = rawStore ? {
  getItem: (key: string) => rawStore.getItem(storageKey(key)),
  setItem: (key: string, value: string) => rawStore.setItem(storageKey(key), value),
  removeItem: (key: string) => rawStore.removeItem(storageKey(key)),
} : undefined;
function sourceHref(live: boolean): string {
  const url = new URL(location.href);
  url.searchParams.delete('demo'); url.searchParams.delete(live ? 'printed' : 'live');
  url.searchParams.set(live ? 'live' : 'printed', '1');
  return url.pathname + url.search;
}

const readSettings = (): Settings => {
  try {
    const s = JSON.parse(store?.getItem('arriba.settings.v1') ?? '{}') as Partial<Settings>;
    return { lang: s.lang === 'es' ? 'es' : 'en', theme: s.theme ?? 'system', count: s.count === 5 ? 5 : 3, liveMotion: s.liveMotion !== false, skin: SKINS.includes(s.skin as Skin) ? s.skin as Skin : 'garden' };
  } catch { return { lang: 'en', theme: 'system', count: 3, skin: 'garden', liveMotion: true }; }
};

/** `?now=2026-11-04T07:50` pins the clock (New York wall time) for demos and tests. */
function useNow(tz: string, intervalMs = 30_000): number {
  const pinned = useMemo(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(new URLSearchParams(location.search).get('now') ?? '');
    return m ? zonedWallTime(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz) : undefined;
  }, [tz]);
  const [now, setNow] = useState(() => pinned ?? Date.now());
  useEffect(() => {
    if (pinned !== undefined) return;
    let id: ReturnType<typeof setInterval> | undefined;
    const visible = () => {
      clearInterval(id);
      document.documentElement.dataset.pageVisible = document.visibilityState === 'hidden' ? 'false' : 'true';
      if (document.visibilityState === 'hidden') return;
      setNow(Date.now());
      id = setInterval(() => setNow(Date.now()), intervalMs);
    };
    document.addEventListener('visibilitychange', visible); visible();
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', visible); };
  }, [pinned, intervalMs]);
  return pinned ?? now;
}

type DatasetState =
  | { status: 'loading' }
  | { status: 'error' }
  /** `fromCache` when the service worker answered from its saved copy; `savedAt` (ms) when it knows when that copy was saved. */
  | { status: 'ready'; ds: Dataset; fromCache?: boolean | undefined; savedAt?: number | undefined };

/** The app gives up on a load after this long even without a service worker (first visit, slow tunnel). */
const LOAD_TIMEOUT_MS = 15_000;

/**
 * Loads the published schedule. The invented demo is used only with `?demo` or when no real dataset is
 * published (404); a slow or failed load is an error with a retry, never silently the demo.
 */
function useDataset(): [DatasetState, () => void] {
  const demo = useMemo(() => new URLSearchParams(location.search).has('demo'), []);
  const [state, setState] = useState<DatasetState>(demo ? { status: 'ready', ds: demoDataset } : { status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (demo) return;
    let live = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LOAD_TIMEOUT_MS);
    setState({ status: 'loading' });
    if (liveMode) {
      loadLiveSchedule(LIVE_API, ctl.signal).then((s) => { if (live) setState({ status: 'ready', ...s }); })
        .catch(() => { if (live) setState({ status: 'error' }); }).finally(() => clearTimeout(timer));
      return () => { live = false; ctl.abort(); clearTimeout(timer); };
    }
    fetch(`${import.meta.env.BASE_URL}data/corridor.json`, { signal: ctl.signal })
      .then(async (r): Promise<DatasetState> => {
        if (r.status === 404) return { status: 'ready', ds: demoDataset };
        if (!r.ok) throw new Error(String(r.status));
        const d = parseDataset(await r.json());
        const fromCache = r.headers.get('x-arriba-from-cache') === '1';
        // Copies saved by older service workers have no x-arriba-saved-at; the server's Date header is the next best.
        const raw = r.headers.get('x-arriba-saved-at');
        const at = raw ? Number(raw) : Date.parse(r.headers.get('date') ?? '');
        return { status: 'ready', ds: d, fromCache, savedAt: fromCache && Number.isFinite(at) && at > 0 ? at : undefined };
      })
      .then((s) => { if (live) setState(s); })
      .catch(() => { if (live) setState({ status: 'error' }); })
      .finally(() => clearTimeout(timer));
    return () => { live = false; ctl.abort(); clearTimeout(timer); };
  }, [demo, attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

/** Shared appearance/language preferences also apply before schedule data is available. */
function useSettings() {
  const [settings, setSettings] = useState<Settings>(readSettings);
  useEffect(() => {
    try { store?.setItem('arriba.settings.v1', JSON.stringify(settings)); } catch { /* ignore */ }
    document.documentElement.lang = settings.lang;
    if (settings.theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.skin = settings.skin;
    document.documentElement.dataset.liveMotion = settings.liveMotion ? 'on' : 'off';
  }, [settings]);
  return [settings, setSettings] as const;
}

type AvailableGuide = 'guide' | 'penn';
export function App() {
  const [data, retry] = useDataset();
  const [guide, setGuide] = useState<AvailableGuide | undefined>();
  const journey = useJourneyChecklist(sourceParams.has('demo') || (data.status === 'ready' && !!data.ds.meta.demo));
  const returning = useRef(false);
  useEffect(() => {
    if (returning.current && !guide && data.status === 'ready') {
      const target = document.querySelector<HTMLElement>('main h1, main button');
      if (target) { if (target.tagName === 'H1') target.tabIndex = -1; target.focus(); }
      returning.current = false;
    }
  }, [guide, data.status]);
  if (data.status !== 'ready' || guide) return <LoadScreen status={data.status} onRetry={retry} guide={guide}
    journey={journey} onGuide={(value) => { if (value === 'penn') journey.selectMode('train'); setGuide(value); }} onBack={() => { returning.current = true; setGuide(undefined); }} />;
  return <Main ds={data.ds} fromCache={data.fromCache} savedAt={data.savedAt} journey={journey} />;
}

function LoadScreen({ status, onRetry, guide, onGuide, onBack, journey }: {
  status: DatasetState['status']; onRetry: () => void; guide?: AvailableGuide;
  onGuide: (guide: AvailableGuide) => void; onBack: () => void; journey: JourneyModel;
}) {
  const [settings, setSettings] = useSettings();
  const t = strings[settings.lang];
  const content = useRef<HTMLElement>(null);
  const lastGuide = useRef<AvailableGuide | undefined>(undefined);
  const busButton = useRef<HTMLButtonElement>(null), pennButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (guide) {
      const heading = content.current?.querySelector('h1');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    } else if (lastGuide.current) {
      (lastGuide.current === 'penn' ? pennButton : busButton).current?.focus();
    }
    lastGuide.current = guide;
  }, [guide]);
  return (
    <div className="app">
      <SkinBackdrop skin={settings.skin} />
      <AppHeader>
        {guide ? <button className="icon-btn" aria-label={t.back} onClick={onBack}>‹</button>
          : <span className="wordmark" role="img" aria-label="Dale!">DALE<span className="bang" aria-hidden="true">!</span></span>}
        <div className="choice-list">
          <button className="chip" lang="en" aria-pressed={settings.lang === 'en'} onClick={() => setSettings({ ...settings, lang: 'en' })}>English</button>
          <button className="chip" lang="es" aria-pressed={settings.lang === 'es'} onClick={() => setSettings({ ...settings, lang: 'es' })}>Español</button>
        </div>
      </AppHeader>
      <main ref={content}>
        <TravelModeSelector mode={guide === 'penn' ? 'train' : 'bus'} t={t} trainRef={pennButton}
          onChange={(mode) => { if (mode === 'train') onGuide('penn'); else onBack(); }} />
        {liveMode && <p><a className="link" href={sourceHref(false)}>{t.live.backup}</a></p>}
        <div className="warn">
          <p role={status === 'error' ? 'alert' : 'status'}>{status === 'error' ? t.loadFailed : status === 'ready' ? t.scheduleReady : t.loading}</p>
          {status === 'error' && <button className="primary" onClick={onRetry}>{t.retry}</button>}
          {status === 'ready' && <button className="primary" onClick={onBack}>{t.returnToSchedule}</button>}
        </div>
        {!guide && <section className="card"><h1>{t.offlineHelp}</h1><p>{t.offlineHelpNote}</p>
          <div className="choice-list">
            <button ref={busButton} onClick={() => onGuide('guide')}>{t.guide.title}</button>
          </div>
        </section>}
        {guide === 'guide' && <RiderGuide t={t} />}
        {guide === 'penn' && <PennGuide t={t} model={journey} railOnly />}
      </main>
    </div>
  );
}

function Main({ ds, fromCache, savedAt, journey }: { ds: Dataset; fromCache?: boolean | undefined; savedAt?: number | undefined; journey: JourneyModel }) {
  const tz = ds.meta.timezone;
  const [activeLock, setActiveLock] = useState<ActiveLock | undefined>();
  /** A lock saved on this phone before a refresh or close, offered back (never resumed silently). */
  const [resumable, setResumable] = useState<SavedLock<Leg> | undefined>();
  const [demoAdvanceMs, setDemoAdvanceMs] = useState(0);
  const [keepAwake, setKeepAwake] = useState(true);
  // Every 10 s at least, so a leave-by countdown is never a minute optimistic for long (issue #54).
  const now = useNow(tz, activeLock ? 1000 : 10_000);
  const lockNow = now + (ds.meta.demo ? demoAdvanceMs : 0);
  const [settings, setSettings] = useSettings();
  const [favorites, setFavorites] = useState<Favorite[]>(() => loadFavorites(store));
  // A short history: Back returns to the screen the rider came from; going home starts over.
  const [stack, setStack] = useState<Screen[]>([{ name: 'home' }]);
  const screen = stack[stack.length - 1]!;
  const pickerFocus = useRef<{ favoriteId: string; end: CommutePickEnd; level: 'city' | 'stop' } | undefined>(undefined);
  useEffect(() => {
    if (screen.name !== 'home' || !pickerFocus.current) return;
    const { favoriteId, end, level } = pickerFocus.current;
    const endpoint = document.querySelector(`[data-favorite-id="${CSS.escape(favoriteId)}"] [data-end="${end}"]`);
    (endpoint?.querySelector<HTMLButtonElement>(`.${level === 'city' ? 'city-control' : 'stop-control'}`)
      ?? endpoint?.querySelector<HTMLButtonElement>('.city-control'))?.focus();
    pickerFocus.current = undefined;
  }, [screen.name]);
  const setScreen = (s: Screen) => setStack((st) => {
    if (s.name === 'home') return [s];
    const top = st[st.length - 1]!;
    // Tapping Settings (or search, or the guide) again while already there does not stack copies.
    if (top.name === s.name && ['settings', 'search', 'guide', 'penn'].includes(s.name)) return st;
    // Keep the history short, but never drop home at the bottom: Back must always lead home.
    return st.length >= 20 ? [st[0]!, ...st.slice(2), s] : [...st, s];
  });
  const back = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));
  /** Update the current screen's entry (for example the timetable's chosen day) without adding history. */
  const updateTop = (s: Screen) => setStack((st) => [...st.slice(0, -1), s]);
  // The phone's or browser's own Back steps back inside Dale instead of leaving it mid-ride. Only a
  // marker goes into the browser history; no stop, trip or location is put in the URL or state.
  const depth = useRef(stack.length);
  depth.current = stack.length;
  // Our own history.back() (consuming the marker on the way home) must not pop a screen the rider
  // opens before its popstate arrives.
  const ownPop = useRef(false);
  useEffect(() => {
    if (stack.length > 1 && !history.state?.dale) history.pushState({ dale: true }, '');
    if (stack.length === 1 && history.state?.dale) { ownPop.current = true; history.back(); }
  }, [stack.length]);
  useEffect(() => {
    const onPop = () => {
      if (ownPop.current) { ownPop.current = false; if (depth.current > 1 && !history.state?.dale) history.pushState({ dale: true }, ''); return; }
      if (depth.current > 1) back();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [reversedIds, setReversedIds] = useState<Set<string>>(() => new Set());
  const toggleReversed = (id: string) => setReversedIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const t = strings[settings.lang];

  // Offer a lock saved before the app was closed; keep the current lock saved on this phone as it changes.
  useEffect(() => { setResumable(loadLock<Leg>(store, ds, now)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // An offer left on screen expires like a saved lock does (and is cleared from the phone then).
  useEffect(() => { if (resumable && !loadLock<Leg>(store, ds, now)) setResumable(undefined); }, [now]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (activeLock) saveLock(store, ds, activeLock, now); }, [activeLock]); // eslint-disable-line react-hooks/exhaustive-deps
  const lockOnScreen = screen.name === 'departure' && activeLock?.dep.tripInstanceId === screen.dep.tripInstanceId && activeLock.dep.stopIndex === screen.dep.stopIndex;
  const lockEvent = (event: BusSessionEvent) => setActiveLock((current) => current ? { ...current, session: reduceBusSession(current.session, event) } : current);
  const [lastArrival, setLastArrival] = useState(() => ds.meta.demo ? undefined : readLastArrival(store, Date.now()));
  const savedArrival = useRef('');
  // Runs after the complete feed packet (including cancellations/skips) has updated the session.
  useEffect(() => {
    setActiveLock(current => {
      if (!current) return current;
      const index = current.dep.pattern.stopIds.indexOf(current.leg.toStopId, current.dep.stopIndex + 1);
      const arrival = observedDestinationArrival(ds, current.session, index, lockNow);
      return arrival ? { ...current, session: reduceBusSession(current.session, { type: 'destination_arrival', arrival, now: lockNow }) } : current;
    });
  }, [activeLock?.session, lockNow, ds]);
  useEffect(() => {
    const value = activeLock?.session.destinationArrival;
    if (!value || ds.meta.demo) return;
    const key = `${value.tripInstanceId}/${value.stopId}/${value.at}`;
    if (savedArrival.current === key) return;
    savedArrival.current = key; if (saveLastArrival(store, value)) setLastArrival(value);
  }, [activeLock?.session.destinationArrival, ds.meta.demo]);
  const liveBus = useLiveBus(ds, activeLock?.session, LIVE_API, lockNow, lockEvent);
  useEffect(() => {
    setActiveLock((current) => {
      if (!current) return current;
      const session = reduceBusSession(current.session, { type: 'tick', now: lockNow });
      return session === current.session ? current : { ...current, session };
    });
  }, [lockNow]);

  // The rider's own reports, kept on this phone across rides (issue #57); never for the demo.
  const [pastReports, setPastReports] = useState<PastReport[]>(() => pruneHistory(store, Date.now()));
  useEffect(() => {
    if (!activeLock || ds.meta.demo) return;
    setPastReports((h) => { const next = recordSession(store, ds, activeLock.session, lockNow); return next.length === h.length ? h : next; });
  }, [activeLock?.session.reports]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => saveFavorites(store, favorites), [favorites]);


  // Never show a stop's internal code: a stop this dataset doesn't have reads as "a stop not in this schedule".
  const stopName = (id: string) => ds.stops.find((s) => s.id === id)?.name ?? t.unknownStop;
  const ctx: Ctx = { ds, tz, now, t, lang: settings.lang, stopName, fromCache, savedAt };

  return (
    <div className="app">
      <SkinBackdrop skin={settings.skin} />
      <AppHeader>
        {screen.name !== 'home' ? (
          <button className="icon-btn" onClick={back} aria-label={t.back}>‹</button>
        ) : <span className="wordmark" role="img" aria-label="Dale!">DALE<span className="bang" aria-hidden="true">!</span></span>}
        <span className="top-version" title={versionLine(t, settings.lang, tz)}><span className="sr-only">{t.versionLabel} </span>{(() => { const [v, when] = versionShort(settings.lang, tz); return <><span className="nowrap">{v}</span>{when && <> <span className="nowrap">· {when}</span></>}</>; })()}</span>
        <button className="icon-btn" onClick={() => setScreen({ name: 'settings' })} aria-label={t.settings}>⚙</button>
      </AppHeader>
      {ds.meta.demo && <div className="demo-banner" role="note">{t.demoBanner}{demoInAddress() && <> <a className="link demo-leave" href={leaveDemoHref()}>{t.leaveDemo}</a></>}</div>}
      <FeedStatus ctx={ctx} />
      {ds.meta.transcribed && isNjtHoliday(localYmd(now, tz)) && <p className="status-line" data-level="warn" role="note">{t.holidayToday}</p>}
      <main>
        {(screen.name === 'home' || (screen.name === 'penn' && screen.railOnly)) && <div className="home-toolbar"><TravelModeSelector
          mode={screen.name === 'penn' ? 'train' : 'bus'} t={t} onChange={(mode) => {
            if (mode === 'train') { journey.selectMode('train'); setScreen({ name: 'penn', railOnly: true }); }
            else if (screen.name === 'penn') back();
          }} /><button className="find-stop" onClick={() => setScreen({ name: 'search' })}>{t.findStop}</button></div>}
        {resumable && !activeLock && <aside className="lock-return" role="note">
          <p>{t.busLock.resumePrompt(formatTime12(resumable.dep.departs, tz, settings.lang), resumable.dep.route.shortName, stopName(resumable.dep.pattern.stopIds[resumable.dep.stopIndex]!))}</p>
          <div className="row-between">
            <button className="primary" onClick={() => { setActiveLock({ dep: resumable.dep, leg: resumable.leg, session: resumable.session }); setScreen({ name: 'departure', dep: resumable.dep, leg: resumable.leg }); setResumable(undefined); }}>{t.busLock.resumeYes}</button>
            <button onClick={() => { forgetLock(store); setResumable(undefined); }}>{t.busLock.resumeNo}</button>
          </div>
        </aside>}
        {activeLock && !lockOnScreen && <aside className="lock-return">
          <button className="primary wide" onClick={() => setScreen({ name: 'departure', dep: activeLock.dep, leg: activeLock.leg })}>
            {t.busLock.resume} · {activeLock.dep.route.shortName} · {formatTime12(activeLock.dep.departs, tz, settings.lang)}
          </button>
        </aside>}
        {liveBus && activeLock && lockOnScreen && <LiveBusStatus state={liveBus.state} hasStopChanges={!!activeLock.session.stopChanges?.indices.length} skippedKnown={activeLock.session.stopChanges?.indices.includes(activeLock.dep.stopIndex)} lockStatus={activeLock.session.lock.status} snapshot={liveBus.snapshot} dep={activeLock.dep} now={lockNow} t={t} lang={settings.lang} tz={tz} />}
        {screen.name === 'penn' && <PennGuide t={t} demo={ds.meta.demo} model={journey} railOnly={screen.railOnly} />}
        {screen.name === 'home' && (
          <Home ctx={ctx} favorites={favorites} count={settings.count} setFavorites={setFavorites} reversedIds={reversedIds} toggleReversed={toggleReversed}
            onGuide={() => setScreen({ name: 'guide' })}
            onChoose={(favoriteId, reversed, end, level) => { pickerFocus.current = { favoriteId, end, level }; setScreen({ name: 'commute', favoriteId, reversed, end, level }); }}
            onAllDay={(leg, title) => setScreen({ name: 'timetable', leg, title })}
            onDeparture={(dep, leg) => setScreen({ name: 'departure', dep, leg })}
            onRescue={(leg, label, usualRouteId) => setScreen({ name: 'rescue', fromStopId: leg.fromStopId, homeStopId: leg.toStopId, label, ...(usualRouteId ? { usualRouteId } : {}) })} />
        )}
        {screen.name === 'home' && lastArrival && <details className="card last-arrival">
          <summary>{t.arrival.last}</summary><ArrivalResult value={lastArrival} t={t} lang={settings.lang} tz={tz} />
          <button type="button" onClick={() => { saveLastArrival(store, undefined); setLastArrival(undefined); }}>{t.arrival.dismiss}</button>
        </details>}
        {screen.name === 'home' && !ds.meta.demo && (liveMode || LIVE_API) && <details className="card live-mode">
          <summary>{t.selection.about}</summary>
          {liveMode && <><p>{t.live.intro}</p><p className="small">{t.live.privacy}</p><p className="small">{t.live.limits}</p></>}
          <a className="link" href={sourceHref(!liveMode)}>{liveMode ? t.live.backup : t.live.open}</a>
        </details>}
        {screen.name === 'search' && (
          <Search ctx={ctx} onSave={(f) => { setFavorites((l) => addFavorite(l, f)); setScreen({ name: 'home' }); }} />
        )}
        {screen.name === 'commute' && (() => {
          const favorite = favorites.find(f => f.id === screen.favoriteId), leg = favorite && legFor(ds, favorite, screen.reversed);
          return favorite && leg ? <CommutePicker ds={ds} t={t} lang={settings.lang} initialFrom={leg.fromStopId} initialTo={leg.toStopId} routeIds={favorite.routeIds} end={screen.end} level={screen.level} onCancel={back}
            onSave={(from, to) => {
              const updated = changeFavoriteStops(ds, favorite, from, to, screen.reversed);
              if (!updated) return false;
              setFavorites(list => list.map(f => f.id === favorite.id ? updated : f));
              setReversedIds(ids => { const next = new Set(ids); next.delete(favorite.id); return next; });
              setScreen({ name: 'home' }); return true;
            }} /> : <p className="warn">{t.noReturnStop}</p>;
        })()}
        {screen.name === 'timetable' && (
          <Timetable ctx={ctx} leg={screen.leg} title={screen.title} date={screen.date} onDate={(date) => updateTop({ ...screen, date })}
            onDeparture={(dep) => setScreen({ name: 'departure', dep, leg: screen.leg })} />
        )}
        {screen.name === 'departure' && (
          <DepartureDetail ctx={ctx} dep={screen.dep} leg={screen.leg} pastReports={pastReports}
            busSession={lockOnScreen ? activeLock?.session : undefined} anotherLock={!!activeLock && !lockOnScreen}
            lockNow={lockNow} keepAwake={keepAwake} onKeepAwake={setKeepAwake} onLockEvent={lockEvent}
            onAdvanceDemo={(minutes) => { if (ds.meta.demo) setDemoAdvanceMs((value) => value + minutes * 60_000); }}
            onLock={() => { if (!activeLock) { setResumable(undefined); setActiveLock({ dep: screen.dep, leg: screen.leg, session: createBusSession(screen.dep, lockNow) }); } }}
            onReturn={(dep, leg) => setScreen({ name: 'departure', dep, leg })}
            onPenn={() => setScreen({ name: 'penn' })}
            onBoarding={() => setScreen({ name: 'boarding', dep: screen.dep, leg: screen.leg })}
            onOpenBackup={(o) => setScreen({ name: 'departure', dep: o.dep, leg: { fromStopId: o.boardStopId, toStopId: o.alightStopId, routeIds: [] } })}
            onRescue={() => setScreen({ name: 'rescue', fromStopId: screen.leg.fromStopId, homeStopId: screen.leg.toStopId, usualRouteId: screen.dep.route.id,
              label: ds.stops.find((s) => s.id === screen.leg.toStopId)?.terminal ? 'other' : 'home' })}
            onUnlock={() => { setActiveLock(undefined); if (!ds.meta.demo) forgetLock(store); setDemoAdvanceMs(0); }} />
        )}
        {screen.name === 'settings' && <SettingsScreen ctx={ctx} settings={settings} setSettings={setSettings} onGuide={() => setScreen({ name: 'guide' })}
          historyCount={pastReports.length} onClearHistory={() => { const ok = clearHistory(store, Math.min(lockNow, Date.now())); if (ok) setPastReports([]); return ok; }} />}
        {screen.name === 'guide' && <RiderGuide t={t} />}
        {screen.name === 'boarding' && (
          <BoardingCheck ds={ds} dep={screen.dep} toStopId={screen.leg.toStopId} t={t} lang={settings.lang}
            gate={(() => { const g = departureGate(ds, screen.dep); return g && gateLine(t, g); })()} />
        )}
        {screen.name === 'rescue' && (
          <Rescue ds={ds} t={t} lang={settings.lang} now={now} fromStopId={screen.fromStopId} homeStopId={screen.homeStopId} usualRouteId={screen.usualRouteId} label={screen.label}
            gateText={(o) => { const g = departureGate(ds, o.dep); return g && gateLine(t, g); }}
            badge={(routeId) => <RouteBadge ds={ds} routeId={routeId} />}
            onOpen={(o) => setScreen({ name: 'departure', dep: o.dep, leg: { fromStopId: o.boardStopId, toStopId: o.alightStopId, routeIds: [] } })} />
        )}
      </main>
      <footer className="foot">
        <p>{t.notAffiliated}</p>
        <p>{dataNotice(ds, t)}</p>
        <p className="version-line">{versionLine(t, settings.lang, tz)}</p>
      </footer>
    </div>
  );
}

/** YYYYMMDD as month/day/year in English and day/month/year in Spanish, as each reader expects. */
const fmtYmd = (d: string, lang: Lang) =>
  lang === 'es' ? `${+d.slice(6, 8)}/${+d.slice(4, 6)}/${d.slice(0, 4)}` : `${+d.slice(4, 6)}/${+d.slice(6, 8)}/${d.slice(0, 4)}`;

/** Cents as dollars; a range when the zone count is uncertain. Same format in both languages. */
const money = (c: { min: number; max: number }) => {
  const d = (n: number) => `$${(n / 100).toFixed(2)}`;
  return c.min === c.max ? d(c.min) : `${d(c.min)}–${d(c.max)}`;
};

interface Ctx { ds: Dataset; tz: string; now: number; t: Strings; lang: Lang; stopName: (id: string) => string; fromCache?: boolean | undefined; savedAt?: number | undefined }

/** Offline state and schedule validity, so a stale or expired feed is never mistaken for "no buses". */
function FeedStatus({ ctx }: { ctx: Ctx }) {
  const { ds, t, now, tz, lang, fromCache, savedAt } = ctx;
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    addEventListener('online', up);
    addEventListener('offline', down);
    return () => { removeEventListener('online', up); removeEventListener('offline', down); };
  }, []);
  const validThrough = Object.values(ds.calendars).reduce((m, c) => [c.end, ...c.added].reduce((a, b) => (b > a ? b : a), m), '00000000');
  const expired = localYmd(now, tz) > validThrough;
  const built = Date.parse(ds.meta.builtAt);
  if (!Object.keys(ds.calendars).length) return null;
  if (expired) return <p className="status-line" data-level="warn" role="alert">{t.feedExpired(fmtYmd(validThrough, lang))}</p>;
  if (!online) return <p className="status-line" data-level="warn" role="status">{t.offline(fmtYmd(Number.isNaN(built) ? validThrough : localYmd(built, tz), lang))}</p>;
  // Online as far as the browser knows, but the service worker gave up on a slow or failed network and used its saved copy.
  if (fromCache) {
    const line = savedAt !== undefined ? t.savedCopy(fmtYmd(localYmd(savedAt, tz), lang), formatTime12(savedAt, tz, lang)) : t.savedCopyUnknown;
    return <p className="status-line" data-level="warn" role="status">{line}</p>;
  }
  return null;
}

function RouteBadge({ ds, routeId }: { ds: Dataset; routeId: string }) {
  const r = ds.routes.find((x) => x.id === routeId);
  return <span className="route-badge" data-express={r?.shortName.endsWith('T') ? 'true' : undefined}>{r?.shortName ?? '?'}</span>;
}

function minutesUntil(now: number, at: number) { return Math.round((at - now) / 60_000); }

/** "7:20 AM", or "~7:20 AM" when the time is Dale's estimate rather than one NJ Transit published; screen readers hear "estimated" instead of the "~". */
function TimeText({ ctx, at, estimated }: { ctx: Ctx; at: number; estimated: boolean }) {
  const s = formatTime12(at, ctx.tz, ctx.lang);
  if (!estimated) return <>{s}</>;
  return <><span aria-hidden="true">~</span>{s}<span className="sr-only">, {ctx.t.estimatedWord}</span></>;
}

/** True when the rider asked for the demo in the address (not when it is shown because no schedule is published). */
const demoInAddress = () => location.search.slice(1).split('&').some((p) => p === 'demo' || p.startsWith('demo='));

/** The same address without `?demo`, so the rider gets the real schedule back. */
function leaveDemoHref(): string {
  // Only the `demo` part goes; the rest of the address stays as typed.
  const rest = location.search.slice(1).split('&').filter((p) => p && p !== 'demo' && !p.startsWith('demo=')).join('&');
  return location.pathname + (rest ? `?${rest}` : '') + location.hash;
}

/** "Dale 0.2.0 (abc1234) · updated 11/4/2026, 3:42 PM": which build this is and when it was made, in New York time. */
/** "v0.3.157 · 11/5 7:42 AM": the short form for the top bar, so the rider always sees which Dale they have. */
function versionShort(lang: Lang, tz: string): [string, string] {
  const built = Date.parse(__DALE_BUILT_AT__);
  if (!Number.isFinite(built)) return [`v${__DALE_VERSION__}`, ''];
  const d = localYmd(built, tz);
  const day = lang === 'es' ? `${+d.slice(6, 8)}/${+d.slice(4, 6)}` : `${+d.slice(4, 6)}/${+d.slice(6, 8)}`;
  return [`v${__DALE_VERSION__}`, `${day} ${formatTime12(built, tz, lang)}`];
}

function versionLine(t: Strings, lang: Lang, tz: string): string {
  const built = Date.parse(__DALE_BUILT_AT__);
  const when = Number.isFinite(built) ? `${fmtYmd(localYmd(built, tz), lang)}, ${formatTime12(built, tz, lang)}` : '?';
  return t.version(__DALE_VERSION__, __DALE_COMMIT__, when);
}

/** NJ Transit developer terms: the data came from NJ Transit via Dale's own server and may not be real time. The demo is not NJ Transit data. */
function dataNotice(ds: Dataset, t: Strings): string {
  return ds.meta.demo || ds.meta.transcribed ? t.notRealTime : `${t.dataObtained} ${t.notRealTime}`;
}

function arrivalAt(ds: Dataset, d: Departure, stopId: string): { at: number; estimated: boolean } | undefined {
  const i = d.pattern.stopIds.indexOf(stopId);
  const trip = ds.trips.find(x => x.id === d.tripId), at = trip && i > d.stopIndex ? tripArrivalAt(ds, trip, d.serviceDate, i) : undefined;
  return at === undefined ? undefined : { at, estimated: ds.meta.demo || ds.meta.transcribed ? !!trip?.estimated?.includes(i) : false };
}

function legFor(ds: Dataset, f: Favorite, reversedView: boolean): Leg | undefined {
  if (!reversedView) return { fromStopId: f.fromStopId, toStopId: f.toStopId, routeIds: f.routeIds };
  // Return trip: board where we got off, or across the street; get off at home or its twin.
  const back = returnLeg(ds, f.fromStopId, f.toStopId, f.routeIds);
  return back ? { ...back, routeIds: f.routeIds } : undefined;
}

function Home({ ctx, favorites, count, setFavorites, reversedIds, toggleReversed, onGuide, onChoose, onAllDay, onDeparture, onRescue }: {
  ctx: Ctx; favorites: Favorite[]; count: number; setFavorites: (fn: (l: Favorite[]) => Favorite[]) => void;
  reversedIds: Set<string>; toggleReversed: (id: string) => void;
  onChoose: (favoriteId: string, reversed: boolean, end: CommutePickEnd, level: 'city' | 'stop') => void;
  onGuide: () => void; onAllDay: (leg: Leg, title: string) => void; onDeparture: (d: Departure, leg: Leg) => void;
  onRescue: (leg: Leg, label: 'home' | 'other', usualRouteId?: string) => void;
}) {
  const { t, ds, now } = ctx;
  const [editing, setEditing] = useState(false);
  const models = useMemo(() => favorites.map(f => {
    const leg = legFor(ds, f, reversedIds.has(f.id));
    return { leg, set: leg ? upcomingCandidates(ds, { stopId: leg.fromStopId, toStopId: leg.toStopId, routeIds: leg.routeIds }, now, count) : { ahead: [], candidates: [] } };
  }), [favorites, reversedIds, ds, now, count]);
  // One browser batch/poll for all cards; the private relay still fetches NJ Transit globally once.
  const requests = models.flatMap(m => m.leg ? m.set.candidates.map(d => requestFor(d, m.leg!.toStopId)) : []);
  const live = useLiveDepartures(ds, requests, LIVE_API, now);
  const reports = new Map(live?.batch?.items.map(item => [departureKey(item.query), item]));
  const evidence = (d: Departure, toStopId: string): DepartureEvidence | undefined => !live ? undefined
    : live.state !== 'available' ? { kind: live.state === 'checking' ? 'checking' : 'unavailable' }
    : departureEvidence(live.batch, reports.get(departureKey(requestFor(d, toStopId))), now);
  if (!favorites.length) {
    return (
      <section className="card hero-empty">
        <h1>{t.noFavoritesTitle}</h1>
        <p>{t.noFavoritesBody}</p>
        <p><button className="ghost" onClick={onGuide}>{t.guideOpen}</button></p>
        <TourGuide t={t} lang={ctx.lang} />
      </section>
    );
  }
  return (
    <>
      <ol className="fav-list">
        {favorites.map((f, i) => (
          <li key={f.id}>
            <FavoriteCard ctx={ctx} fav={f} count={count} model={models[i]!.set} liveEnabled={!!live} evidence={evidence} editing={editing} rev={reversedIds.has(f.id)} onReverse={() => toggleReversed(f.id)} first={i === 0} last={i === favorites.length - 1}
              onMove={(dlt) => setFavorites((l) => moveFavorite(l, f.id, dlt))}
              onRemove={() => setFavorites((l) => removeFavorite(l, f.id))}
              onRename={(name) => setFavorites((l) => renameFavorite(l, f.id, name))}
              onLeavePlan={(plan) => setFavorites((l) => setLeavePlan(l, f.id, reversedIds.has(f.id) ? 'back' : 'out', plan))}
              onAllDay={onAllDay} onDeparture={onDeparture} onRescue={onRescue} onChoose={(end, level) => onChoose(f.id, reversedIds.has(f.id), end, level)} />
          </li>
        ))}
      </ol>
      <div className="row-between favorites-tools">
        <button className="ghost" onClick={() => setEditing((e) => !e)}>{editing ? t.done : t.edit}</button>
      </div>
      <button className="ghost" onClick={onGuide}>{t.guideOpen}</button>
      <TourGuide t={t} lang={ctx.lang} />
    </>
  );
}

// Only remove the dataset's trailing direction hint, never place names or other parentheses.
const stopPlace = (name: string): string => name.replace(/\s+\(to [^)]+\)$/i, '');

// The printed dataset explicitly uses "Town (landmark) - stop"; other sources keep their full place name.
function commutePlace(stop: Stop | undefined, name: string, printed: boolean, t: Strings, verifiedCities: boolean): { name: string; detail: string } {
  if (stop?.terminal === 'PABT') return { name: t.commuteNewYork, detail: t.commutePabt };
  const place = stopPlace(name);
  if (verifiedCities && stop?.city) return { name: stop.city, detail: place };
  const split = printed ? place.indexOf(' - ') : -1;
  if (split < 1) return { name: place, detail: '' };
  const town = place.slice(0, split);
  const landmark = /^(.+?)\s+(\([^()]+\))$/.exec(town);
  return { name: landmark?.[1] ?? town, detail: `${landmark ? `${landmark[2]} · ` : ''}${place.slice(split + 3)}` };
}

/** City and stop retain separate sign faces and the original visible/source text. */
function HighwayPlace({ place, label, end, t, onCity, onStop }: { place: { name: string; detail: string }; label: string; end: 'from' | 'to'; t: Strings; onCity?: () => void; onStop?: () => void }) {
  const city = <><span className="highway-label">{label}</span><strong className="highway-name"><SignText text={place.name} /></strong></>;
  const stop = <span className="commute-stop-name"><SignText text={place.detail} /></span>;
  return <div className="commute-place" data-end={end}>
    {onCity ? <button type="button" className="highway-sign city-control" onClick={onCity}>{city}<span className="sr-only"> {t.cityPicker.city}</span><span className="sign-caret" aria-hidden="true">⌄</span></button> : <div className="highway-sign">{city}</div>}
    {place.detail && (onStop ? <button type="button" className="commute-stop stop-control" title={t.cityPicker.stop} onClick={onStop}>{stop}</button> : <p className="commute-stop">{stop}</p>)}
  </div>;
}

/** Saved commute presentation preserves the selected direction, departure and existing trip actions. */
function FavoriteCard({ ctx, fav, count, model, liveEnabled, evidence, editing, rev, onReverse, first, last, onMove, onRemove, onRename, onLeavePlan, onAllDay, onDeparture, onRescue, onChoose }: {
  ctx: Ctx; fav: Favorite; count: number; model: UpcomingSet; liveEnabled: boolean; evidence: (d: Departure, toStopId: string) => DepartureEvidence | undefined; editing: boolean; rev: boolean; onReverse: () => void; first: boolean; last: boolean;
  onMove: (d: -1 | 1) => void; onRemove: () => void; onRename: (s: string) => void; onLeavePlan: (p: LeavePlan | undefined) => void;
  onAllDay: (leg: Leg, title: string) => void; onDeparture: (d: Departure, leg: Leg) => void;
  onRescue: (leg: Leg, label: 'home' | 'other', usualRouteId?: string) => void;
  onChoose: (end: CommutePickEnd, level: 'city' | 'stop') => void;
}) {
  const { ds, t, now, stopName } = ctx;
  const leg = legFor(ds, fav, rev);
  // More than the shown rows, so leave-by and arrive-by can look past them.
  const ahead: LeaveOption[] = leg ? model.ahead.map((d) => { const arrives = arrivalAt(ds, d, leg.toStopId); return arrives ? { dep: d, arrives } : { dep: d }; }) : [];
  const deps = leg && liveEnabled ? selectUpcoming(model, d => evidence(d, leg.toStopId), now, count) : ahead.slice(0, count).map(o => o.dep);
  const rows = deps.map(d => ({ d, arr: leg ? arrivalAt(ds, d, leg.toStopId) : undefined, live: leg ? evidence(d, leg.toStopId) : undefined }));
  const evidencePrefix = useId();
  const plan = fav.leave?.[rev ? 'back' : 'out'];
  const express = leg ? nextExpress(ds, { stopId: leg.fromStopId, toStopId: leg.toStopId, routeIds: leg.routeIds }, deps, now, plan?.walkMin) : undefined;
  const [planning, setPlanning] = useState(false);
  // After the form closes, focus returns to the control that opened it.
  const planButton = useRef<HTMLButtonElement>(null);
  const closedForm = useRef(false);
  const reverseButton = useRef<HTMLButtonElement>(null);
  const restoreReverseFocus = useRef(false);
  // Changing direction resets the boarding-sign panel and remounts its controls.
  // Restore only the initiating button's focus; do not steal focus from other actions.
  const reverseTrip = () => {
    restoreReverseFocus.current = document.activeElement === reverseButton.current;
    onReverse();
  };
  useEffect(() => {
    if (restoreReverseFocus.current) reverseButton.current?.focus();
    restoreReverseFocus.current = false;
  }, [rev]);

  useEffect(() => { if (!planning && closedForm.current) planButton.current?.focus(); closedForm.current = planning; }, [planning]);
  const soonest = liveEnabled ? undefined : earliestArrival(ahead.slice(0, count), now, plan);
  const anyEstimated = rows.some((r) => r.d.estimated || r.arr?.estimated);
  const title = leg ? `${stopName(leg.fromStopId)} → ${stopName(leg.toStopId)}` : '';
  const customName = !isGeneratedFavoriteLabel(ds, fav);
  const fromId = leg?.fromStopId ?? (rev ? fav.toStopId : fav.fromStopId);
  const from = ds.stops.find((s) => s.id === fromId);
  const to = leg && ds.stops.find((s) => s.id === leg.toStopId);
  const verifiedCities = ds.meta.stopCities?.state === 'verified';
  const origin = commutePlace(from, stopName(fromId), !!ds.meta.transcribed, t, verifiedCities);
  const destination = leg && commutePlace(to, stopName(leg.toStopId), !!ds.meta.transcribed, t, verifiedCities);
  const fullLeg = title || `${stopName(fromId)} → ${stopName(rev ? fav.fromStopId : fav.toStopId)}`;
  // Saved from the real schedule but opened on the demo (or the schedule changed): say which, plainly.
  const missing = !ds.stops.some((s) => s.id === fav.fromStopId) || !ds.stops.some((s) => s.id === fav.toStopId);
  if (missing && !editing) {
    return (
      <article className="card fav fav-missing" aria-label={t.savedCommute}>
        <h2>{fav.label}</h2>
        <p className="warn" role="note">{ds.meta.demo ? t.commuteNotInDemo : t.commuteNotInSchedule}</p>
        {ds.meta.demo && demoInAddress() && <a className="link" href={leaveDemoHref()}>{t.leaveDemo}</a>}
      </article>
    );
  }
  return (
    <article className="card fav" data-favorite-id={fav.id} aria-label={customName ? `${fav.label}: ${fullLeg}` : fullLeg}>
      <div className="commute-header">
        {editing ? (
          <div className="commute-edit">
            <label className="rename">{t.rename}
              <input defaultValue={fav.label} onBlur={(e) => onRename(e.currentTarget.value)} />
            </label>
          </div>
        ) : <>
          {customName ? <div className="commute-sign"><h2 className="commute-led">{fav.label}</h2></div>
            : <h2 className="sr-only">{fullLeg}</h2>}
          <div className="commute-places">
            <HighwayPlace place={origin} label={t.commuteFrom} end="from" t={t} onCity={leg ? () => onChoose('from', 'city') : undefined} onStop={leg ? () => onChoose('from', 'stop') : undefined} />
            {destination && <HighwayPlace place={destination} label={t.commuteToLabel} end="to" t={t} onCity={() => onChoose('to', 'city')} onStop={() => onChoose('to', 'stop')} />}
          </div>
        </>}
        {/* Keep edit height stable when blur saves a new name, so Done does not move mid-tap. */}
        {editing && leg && <p className="leg">{title}</p>}
        {/* One compact row of actions, so the next buses sit right under the signs. */}
        {!editing && leg && from && to ? <StopSign key={`${from.id}-${to.id}`} ds={ds} from={from} to={to} routeIds={leg.routeIds} now={now} t={t}
          actions={trigger => <div className="commute-controls">
            {!plan && !planning && <button ref={planButton} className="chip leave-set" onClick={() => setPlanning(true)}><span aria-hidden="true">⏱ </span>{t.leave.set}</button>}
            <button className="chip rescue-chip" onClick={() => onRescue(leg, to.terminal ? 'other' : 'home', leg.routeIds.length === 1 ? leg.routeIds[0] : undefined)}>{to.terminal ? t.rescue.otherWays : t.rescue.title}</button>
            <div className="commute-sign-actions">
              <button ref={reverseButton} className="chip commute-reverse" aria-pressed={rev} onClick={reverseTrip}><span aria-hidden="true">⇄ </span>{t.reverse}</button>
              {trigger}
            </div>
          </div>} /> : <div className="commute-controls">
            <button ref={reverseButton} className="chip commute-reverse" aria-pressed={rev} onClick={reverseTrip}><span aria-hidden="true">⇄ </span>{t.reverse}</button>
          </div>}
      </div>
      {!leg && !editing ? <p className="warn" role="alert">{t.noReturnStop}</p> : editing ? (
        <div className="edit-row">
          <button onClick={() => onMove(-1)} disabled={first}>↑ {t.moveUp}</button>
          <button onClick={() => onMove(1)} disabled={last}>↓ {t.moveDown}</button>
          <button className="danger" onClick={onRemove}>{t.remove}</button>
        </div>
      ) : (
        <>
          {leg && (planning
            ? <LeavePlanForm ctx={ctx} plan={plan} onDone={(p) => { if (p !== 'cancel') onLeavePlan(p); setPlanning(false); }} />
            : plan && <LeaveBy ctx={ctx} plan={plan} options={ahead} onEdit={() => setPlanning(true)} editRef={planButton} />)}
          {!leg ? null : deps.length === 0 ? <p className="muted">{t.noMoreToday}</p> : (
            <ul className="deps">
              {rows.map(({ d, arr, live }, i) => {
                const shown = live?.boarding?.at ?? d.departs;
                const arrivalPlace = to?.terminal === 'PABT' ? t.commutePabt : to?.name ?? t.unknownStop;
                const reasonId = `${evidencePrefix}-${d.tripInstanceId}`;
                const reason = live && homeArrivalReason(ctx, d, live);
                const observedAt = live?.boarding?.observedAt ?? live?.arrival?.observedAt;
                return <li key={d.tripInstanceId} data-arrival-kind={live?.kind ?? 'scheduled'} data-trip-instance={d.tripInstanceId}>
                  <button className={`dep ${live ? 'dep-has-live' : ''} ${i === 0 ? 'dep-next' : ''}`} aria-describedby={live ? reasonId : undefined} onClick={() => onDeparture(d, leg)}>
                    <RouteBadge ds={ds} routeId={d.route.id} />
                    <span className="dep-main">
                      <DepartureTimes evidence={live ?? { kind: 'unavailable' }} boarding={d.departs} boardingEstimated={d.estimated} arrival={arr} destination={arrivalPlace} countdown={live?.kind === 'cancelled' ? t.live.rows.cancelledShort : shown < now && live ? t.live.rows.timePassed : t.inMin(minutesUntil(now, shown))} t={t}
                        time={(at, estimated) => <><TimeText ctx={ctx} at={at} estimated={estimated} />{localYmd(at, ctx.tz) !== localYmd(now, ctx.tz) && <span className="dep-date">{fmtYmd(localYmd(at, ctx.tz), ctx.lang)}</span>}</>} />
                      {!live && soonest?.index === i && <span className="tag tag-first">{t.leave.arrivesFirst}</span>}
                      {plan && !canWalkTo({ dep: { ...d, departs: shown } }, now, plan) && <span className="dep-toosoon">{t.leave.tooSoon}</span>}
                      {(() => { const g = departureGate(ds, d); return g && <span className="dep-gate" data-status={g.status}>{gateLine(t, g)}</span>; })()}
                    </span>
                  </button>
                  {live && <p id={reasonId} className="dep-evidence">{observedAt !== undefined && <span className="dep-source">{t.live.rows.sourceAge(Math.max(0, Math.floor((now - observedAt) / 1000)))}</span>}{live.kind !== 'live' && <span className="dep-reason">{reason}</span>}{live.gpsObservedAt && ['no-prediction', 'passed', 'stale', 'unavailable'].includes(live.kind) && <> {t.live.rows.gpsHint}</>}</p>}
                </li>;
              })}
            </ul>
          )}
          {express && <p className="next-express" data-testid="next-express">
            <span>{t.nextExpress}</span><span className="express-mini">165T</span>
            <span><TimeText ctx={ctx} at={express.departs} estimated={express.estimated} />
              {localYmd(express.departs, ctx.tz) !== localYmd(now, ctx.tz) && <> · {new Intl.DateTimeFormat(ctx.lang, { timeZone: ctx.tz, month: 'short', day: 'numeric' }).format(express.departs)}</>}
              {' · '}{t.inMin(minutesUntil(now, express.departs))}{' · '}{t.scheduledOnly}
            </span>
          </p>}
          {soonest && rows[soonest.index] && <p className="small leave-why">{t.leave.arrivesFirstWhy(
            rows[soonest.index]!.d.route.shortName,
            `${rows[soonest.index]!.d.estimated ? '~' : ''}${formatTime12(rows[soonest.index]!.d.departs, ctx.tz, ctx.lang)}`, soonest.laterMin, soonest.earlierMin, soonest.estimated)}</p>}
          {anyEstimated && <p className="muted small">{t.estimatedNote}</p>}
          {leg && <div className="row-between card-foot">
            <button className="link" onClick={() => onAllDay(leg, title)}>{t.allDay} →</button>
            {deps.length > 0 && <span className="muted small tap-hint">{t.tapHint}</span>}
          </div>}
        </>
      )}
    </article>
  );
}

function homeArrivalReason(ctx: Ctx, dep: Departure, evidence: DepartureEvidence): string {
  const l = ctx.t.live.rows;
  if (evidence.kind === 'no-prediction') {
    const trip = ctx.ds.trips.find(t => t.id === dep.tripId)!;
    const starts = tripStopTimes(ctx.ds, dep)[0]?.at;
    if (trip && starts && starts > ctx.now) return l.notStarted(formatTime12(starts, ctx.tz, ctx.lang) + (localYmd(starts, ctx.tz) !== localYmd(ctx.now, ctx.tz) ? ' · ' + fmtYmd(localYmd(starts, ctx.tz), ctx.lang) : ''));
  }
  return l.reasons[evidence.kind];
}

/** Leave-by countdown and arrive-by line for one direction of a saved commute (issue #54). Scheduled times only. */
function LeaveBy({ ctx, plan, options, onEdit, editRef }: { ctx: Ctx; plan: LeavePlan; options: LeaveOption[]; onEdit: () => void; editRef: Ref<HTMLButtonElement> }) {
  const { t, now, tz, lang } = ctx;
  const l = t.leave;
  const clock = (at: number, estimated = false) => `${estimated ? '~' : ''}${formatTime12(at, tz, lang)}`;
  const advice = leaveAdvice(options, now, plan);
  const deadline = plan.arriveBy ? arriveByDeadline(now, plan.arriveBy, tz) : undefined;
  const pick = deadline !== undefined && deadline - now <= ARRIVE_BY_WINDOW_MS ? arriveByPick(options, now, plan, deadline) : undefined;
  return (
    <div className="leave-by">
      <div className="row-between">
        <p className="leave-count"><strong>{advice.kind === 'leave_in' ? l.leaveIn(advice.minutes) : advice.kind === 'leave_now' ? l.leaveNow : l.none}</strong></p>
        <button ref={editRef} className="ghost" onClick={onEdit}>{l.edit}</button>
      </div>
      {advice.kind === 'leave_in' && <p className="small">{l.forBus(clock(advice.dep.departs, advice.dep.estimated), plan.walkMin, plan.cushionMin)}</p>}
      {advice.kind === 'leave_now' && <p className="small">{l.spareLeft(clock(advice.dep.departs, advice.dep.estimated), advice.spareMin, plan.cushionMin)}</p>}
      {pick && <p className="small leave-arrive">{pick.kind === 'pick'
        ? pick.leaveNow
          ? l.arrivePickNow(clock(pick.deadline), clock(pick.option.dep.departs, pick.option.dep.estimated), clock(pick.option.arrives.at, pick.option.arrives.estimated))
          : l.arrivePick(clock(pick.deadline), clock(pick.leaveAt, pick.option.dep.estimated), clock(pick.option.dep.departs, pick.option.dep.estimated), clock(pick.option.arrives.at, pick.option.arrives.estimated))
        : pick.kind === 'none_in_time' ? l.arriveNone(clock(pick.deadline)) : l.arriveUnknown(clock(pick.deadline))}</p>}
      <p className="muted small">{l.note}</p>
    </div>
  );
}

function LeavePlanForm({ ctx, plan, onDone }: { ctx: Ctx; plan?: LeavePlan; onDone: (p: LeavePlan | undefined | 'cancel') => void }) {
  const l = ctx.t.leave;
  const [walk, setWalk] = useState(String(plan?.walkMin ?? 5));
  const [cushion, setCushion] = useState(String(plan?.cushionMin ?? 2));
  const [by, setBy] = useState(plan?.arriveBy ?? '');
  const [bad, setBad] = useState(false);
  const errorId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  function save() {
    const w = Number(walk), c = Number(cushion);
    const ok = (v: number, max: number) => walk.trim() !== '' && Number.isInteger(v) && v >= 0 && v <= max;
    if (!ok(w, MAX_WALK_MIN) || cushion.trim() === '' || !ok(c, MAX_CUSHION_MIN)) { setBad(true); return; }
    onDone({ walkMin: w, cushionMin: c, ...(/^\d{2}:\d{2}$/.test(by) ? { arriveBy: by } : {}) });
  }
  return (
    <div className="leave-form">
      <h3 tabIndex={-1} ref={heading}>{l.formTitle}</h3>
      <label>{l.walk}<input type="number" inputMode="numeric" min={0} max={MAX_WALK_MIN} value={walk} aria-invalid={bad || undefined} aria-describedby={bad ? errorId : undefined} onChange={(e) => setWalk(e.currentTarget.value)} /></label>
      <label>{l.cushion}<input type="number" inputMode="numeric" min={0} max={MAX_CUSHION_MIN} value={cushion} aria-invalid={bad || undefined} aria-describedby={bad ? errorId : undefined} onChange={(e) => setCushion(e.currentTarget.value)} /></label>
      <label>{l.arriveBy}<input type="time" value={by} onChange={(e) => setBy(e.currentTarget.value)} /></label>
      {bad && <p className="warn small" role="alert" id={errorId}>{l.invalid}</p>}
      <p className="muted small">{l.help}</p>
      <div className="edit-row">
        <button className="primary" onClick={save}>{l.save}</button>
        {plan && <button className="danger" onClick={() => onDone(undefined)}>{l.clear}</button>}
        <button className="ghost" onClick={() => onDone('cancel')}>{l.cancel}</button>
      </div>
    </div>
  );
}

function Search({ ctx, onSave }: { ctx: Ctx; onSave: (f: Favorite) => void }) {
  const { ds, t, stopName } = ctx;
  const [q, setQ] = useState(''), [stop, setStop] = useState<Stop>(), [dest, setDest] = useState<string>();
  const [saveError, setSaveError] = useState(false), submitted = useRef(false), destinationHeading = useRef<HTMLHeadingElement>(null);
  const results = useMemo(() => searchStops(ds, q), [ds, q]);
  const destinations = useMemo(() => stop ? destinationsFrom(ds, stop.id) : [], [ds, stop]);
  const groups = useMemo(() => destinationGroups(ds, stop?.id ?? '', destinations), [ds, stop, destinations]);
  const info = stop && boardingInfo(ds, stop.id), check = stop && dest ? checkDirection(ds, stop.id, dest) : undefined;
  const pick = (s: Stop) => { setStop(s); setSaveError(false); };
  if (!stop) return <section>
    <h1>{t.findStop}</h1>
    <label className="sr-only" htmlFor="stop-search">{t.findStop}</label>
    <input id="stop-search" name="stop-search" className="search" autoFocus type="search" value={q} placeholder={t.searchPlaceholder} autoCapitalize="off" spellCheck={false} onChange={e => setQ(e.currentTarget.value)} />
    <ul className="results">{results.map(s => <li key={s.id}><StopChoice ds={ds} stop={s} t={t} onPick={pick} /></li>)}{q && !results.length && <li className="muted">{t.noResults}</li>}</ul>
    {!q && <NearMe ds={ds} t={t} onPick={pick} />}
  </section>;
  const destination = (s: Stop) => <button key={s.id} type="button" className="chip destination-choice" aria-pressed={dest === s.id} onClick={() => { setDest(s.id); setSaveError(false); }}>
    <span>{s.name}</span>{s.code && <span className="small">{t.selection.stopNumber(s.code)}</span>}
  </button>;
  const saveButton = () => <button type="submit" className="primary save-trip">{t.selection.save}</button>;
  return <form className="trip-selection" onSubmit={e => {
    e.preventDefault();
    if (!dest || !check?.ok) { setSaveError(true); destinationHeading.current?.focus(); return; }
    if (submitted.current) return; submitted.current = true;
    onSave({ id: `${stop.id}>${dest}`, label: `${stopName(stop.id)} → ${stopName(dest)}`, fromStopId: stop.id, toStopId: dest, routeIds: [] });
  }}>
    <h1>{stop.name}</h1><p>{stop.code ? t.selection.stopNumber(stop.code) : t.selection.numberUnknown}</p>
    <button type="button" className="link" onClick={() => { setStop(undefined); setDest(undefined); }}>{t.selection.change}</button>
    {info && info.headsigns.length > 0 && <><p>{t.busesHereGoTo}:</p><ul className="route-descriptions">{info.headsigns.map(text => <li key={text}>{text}</li>)}</ul></>}
    <h2 ref={destinationHeading} tabIndex={-1}>{t.whereTo}</h2>
    {dest && <p className="selected-destination"><strong>{t.selection.selected}:</strong> {stopName(dest)}</p>}
    {saveButton()}
    {saveError && <p className="warn" role="alert">{check && !check.ok ? t.notServed : t.selection.choose}</p>}
    {groups.terminal.length > 0 && <div className="pinned-destinations"><h3>{t.commutePabt}</h3><div className="choice-list">{groups.terminal.map(destination)}</div></div>}
    {groups.cities.length > 0 && <fieldset className="destination-cities"><legend>{t.selection.cities}</legend>{groups.cities.map(group => <details key={group.city || 'unknown'}>
      <summary>{group.city || t.selection.unknownCity} ({group.stops.length})</summary><div className="choice-list">{group.stops.map(destination)}</div>
    </details>)}</fieldset>}
    {!stop.terminal && !destinations.some(s => s.terminal) && <p className="warn small" role="note">{t.noTerminalFromHere}</p>}
    {check && !check.ok && check.reason === 'wrong-side' && <div className="warn" role="alert"><p>{check.distanceM === undefined ? t.wrongSideNoDistance(`${check.useStop.name}${check.useStop.code ? ' · ' + t.selection.stopNumber(check.useStop.code) : ''}`) : t.wrongSide(`${check.useStop.name}${check.useStop.code ? ' · ' + t.selection.stopNumber(check.useStop.code) : ''}`, check.distanceM)}</p><button type="button" className="primary" onClick={() => pick(check.useStop)}>{t.useThatStop}</button></div>}
    {check && !check.ok && check.reason === 'not-served' && <div className="warn" role="alert">{t.notServed}</div>}
    {saveButton()}
  </form>;
}

function Timetable({ ctx, leg, title, date: chosen, onDate, onDeparture }: { ctx: Ctx; leg: Leg; title: string; date?: string; onDate: (date: string) => void; onDeparture: (d: Departure) => void }) {
  const { ds, t, tz, now, lang } = ctx;
  const today = localYmd(now, tz);
  // The chosen day lives in the screen's history entry, so Back from a trip returns to it.
  const date = chosen && chosen >= today ? chosen : today;
  const setDate = onDate;
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const list = departuresOn(ds, { stopId: leg.fromStopId, toStopId: leg.toStopId, routeIds: leg.routeIds, date });
  const rows = list.map((d) => ({ d, arr: arrivalAt(ds, d, leg.toStopId) }));
  const anyEstimated = rows.some((r) => r.d.estimated || r.arr?.estimated);
  // Same rule as the trip screen, per row: a listed bus already running when the clocks change shows the new
  // clock time. Only then is there anything to explain; other rows read exactly as printed.
  const dayClockChange = rows.map(({ d, arr }) => {
    const first = tripStopTimes(ds, d)[0];
    return first ? clockChangeBetween(first.at, arr?.at ?? d.departs, tz) : undefined;
  }).find(Boolean);
  const dayLabel = (d: string, i: number) => i === 0 ? t.today : i === 1 ? t.tomorrow :
    new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
      .format(new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))));
  return (
    <section>
      <h1>{t.timetableTitle}</h1>
      <p className="leg">{title}</p>
      <div className="choice-list" role="tablist">
        {days.map((d, i) => (
          <button key={d} role="tab" className="chip" aria-selected={d === date} data-selected={d === date ? 'true' : undefined} onClick={() => setDate(d)}
            data-weekend={weekdayIndex(d) >= 5 ? 'true' : undefined}>{dayLabel(d, i)}</button>
        ))}
      </div>
      {ds.meta.transcribed && isNjtHoliday(date) && <p className="warn small" role="note">{t.holidayOn}</p>}
      {dayClockChange && <p className="warn small" role="note">{dayClockChange === 'back' ? t.clockBackDay : t.clockAheadDay}</p>}
      <table className="timetable">
        <thead><tr><th>{t.departs}</th><th>{t.route}</th><th>{t.arrives}</th></tr></thead>
        <tbody>
          {rows.map(({ d, arr }) => (
            <tr key={d.tripInstanceId} className={d.departs < now ? 'past' : ''}>
              <td className="tt-time"><button className="link-cell" onClick={() => onDeparture(d)}><TimeText ctx={ctx} at={d.departs} estimated={d.estimated} /></button></td>
              <td><RouteBadge ds={ds} routeId={d.route.id} /></td>
              <td>{arr ? <TimeText ctx={ctx} at={arr.at} estimated={arr.estimated} /> : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {anyEstimated && <p className="muted small">{t.estimatedNote}</p>}
      {!list.length && <p className="muted">{t.noBusesThisDay}</p>}
    </section>
  );
}

/** The Port Authority gate answer for a departure boarding there (same answer on home and the trip screen); undefined elsewhere. */
function departureGate(ds: Dataset, dep: Departure): GateAnswer | undefined {
  const boardStop = ds.stops.find((s) => s.id === dep.pattern.stopIds[dep.stopIndex]);
  if (boardStop?.terminal !== 'PABT') return undefined;
  // Usual-gate windows use service-day minutes (a 24:00 trip is 1440, not 0) and the service date's day type.
  const localMin = Math.round((ds.trips.find((x) => x.id === dep.tripId)?.times[dep.stopIndex] ?? 0) / 60);
  const wd = weekdayIndex(dep.serviceDate);
  return gateFor(dep.tripInstanceId, dep.pattern.id, localMin, wd === 5 ? 'saturday' : wd === 6 ? 'sunday' : 'weekday', [], ds.meta.demo ? demoUsualGates : [], ds.publishedGates, dep.pattern.variant);
}

/**
 * One-line gate for a home departure row, always saying what kind of answer it is. Postings are always
 * empty until M3; when DepartureVision is wired in, the posted line must also say how old the posting is.
 */
const gateLine = (t: Strings, g: GateAnswer) =>
  g.status === 'posted' ? t.gatePosted(g.gate, g.door)
    : g.status === 'usual' ? t.gateUsual(g.gate, g.door)
      : g.status === 'published' ? `${t.gatePublished(g.gate, g.door)} · ${t.gateRuleTag}`
        : t.gateUnknown;

function DepartureDetail({ ctx, dep, leg, pastReports, busSession, anotherLock, lockNow, keepAwake, onKeepAwake, onLockEvent, onAdvanceDemo, onLock, onUnlock, onReturn, onRescue, onBoarding, onOpenBackup, onPenn }: {
  ctx: Ctx; dep: Departure; leg: Leg; pastReports: PastReport[]; busSession?: BusSession; anotherLock: boolean; lockNow: number;
  keepAwake: boolean; onKeepAwake: (value: boolean) => void; onLockEvent: (event: BusSessionEvent) => void;
  onAdvanceDemo: (minutes: number) => void; onLock: () => void; onUnlock: () => void;
  onReturn: (dep: Departure, leg: Leg) => void;
  onRescue: () => void;
  onOpenBackup: (o: RescueOption) => void;
  onBoarding: () => void;
  onPenn: () => void;
}) {
  const { ds, t, stopName } = ctx;
  const times = tripStopTimes(ds, dep);
  // Search after the boarding stop: on a loop pattern the destination can also appear earlier.
  const alightIndex = dep.pattern.stopIds.indexOf(leg.toStopId, dep.stopIndex + 1);
  const boardStop = ds.stops.find((s) => s.id === dep.pattern.stopIds[dep.stopIndex]);
  const scheduledArrival = arrivalAt(ds, dep, leg.toStopId);
  const alightStop = alightIndex > dep.stopIndex ? ds.stops.find((s) => s.id === dep.pattern.stopIds[alightIndex]) : undefined;
  // The printed Park/Ride note is about Parkway express (P, FP) trips only; other trips stop there as usual.
  const alightNote = alightStop?.noteId && (alightStop.noteId !== 'parkride-request' || ['P', 'FP'].includes(dep.pattern.variant ?? '')) ? t.stopNotes[alightStop.noteId] : undefined;
  const atPabt = boardStop?.terminal === 'PABT';
  const fare = boardStop && alightStop ? fareBetween(ds, boardStop.id, alightStop.id) : undefined;
  const gate = departureGate(ds, dep);
  // From the trip's first stop (read as printed) to where the rider gets off: a change before boarding
  // still shifts the rider's times, a change after getting off does not.
  const rideEnd = times[alightIndex > dep.stopIndex ? alightIndex : times.length - 1];
  const clockChange = rideEnd && times[0] ? clockChangeBetween(times[0].at, rideEnd.at, ctx.tz) : undefined;
  return (
    <section>
      {/* A printed timetable gives no sign text, so a transcribed dataset's headsign is Dale's own route-and-destination label, not what the sign reads. */}
      <div className="sign" aria-label={`${ds.meta.transcribed ? t.routeAndDirection : t.checkSign}: ${dep.pattern.headsign}`}>
        <span className="sign-label">{ds.meta.transcribed ? t.routeAndDirection : t.checkSign}</span>
        <span className="sign-led">{dep.pattern.headsign}</span>
      </div>
      {dep.pattern.variant && t.variantNotes[dep.pattern.variant] && <p className="muted small">{t.variantNotes[dep.pattern.variant]}</p>}
      {boardStop?.noteId && t.stopNotes[boardStop.noteId] && <p className="muted small" role="note">{t.stopNotes[boardStop.noteId]}</p>}
      {alightNote && <p className="warn small" role="note">{alightNote}</p>}
      {ds.meta.transcribed && isNjtHoliday(dep.serviceDate) && <p className="warn small" role="note">{t.holidayOn}</p>}
      {clockChange && <p className="warn small" role="note">{clockChange === 'back' ? t.clockBackTrip : t.clockAheadTrip}</p>}
      {(() => {
        // Past rides only: today's ride (this lock) is shown in the panel, not here.
        const summary = summarize(ds, pastReports, dep, busSession?.id);
        const wd = weekdayIndex(dep.serviceDate);
        return summary && <PastReports summary={summary} dayType={wd === 5 ? 'saturday' : wd === 6 ? 'sunday' : 'weekday'} t={t} fmtDate={(d) => fmtYmd(d, ctx.lang)} />;
      })()}
      {busSession && <BusLockPanel ds={ds} session={busSession} alightIndex={alightIndex} now={lockNow} t={t} lang={ctx.lang}
        keepAwake={keepAwake} onKeepAwake={onKeepAwake} onEvent={onLockEvent} onAdvanceDemo={onAdvanceDemo} onUnlock={onUnlock}
        gateText={(o) => { const g = departureGate(ds, o.dep); return g && gateLine(t, g); }}
        badge={(routeId) => <RouteBadge ds={ds} routeId={routeId} />} onOpenBackup={onOpenBackup} onAlternatives={onRescue} onPenn={onPenn} />}
      <button className="boarding-open" onClick={onBoarding}>{t.boarding.open}</button>
      <div className="card trip-ticket">
        <p className="trip-ticket-label">{t.tripCard}</p>
        <div className="row-between">
          <div><span className="muted">{t.departs}</span><div className="big-time"><TimeText ctx={ctx} at={dep.departs} estimated={dep.estimated} /></div></div>
          {alightIndex > dep.stopIndex && (
            <div className="right"><span className="muted">{t.arrivesLabel}</span><div className="big-time">{scheduledArrival ? <TimeText ctx={ctx} at={scheduledArrival.at} estimated={scheduledArrival.estimated} /> : t.arrival.scheduleUnknown}</div></div>
          )}
        </div>
        <p className="badge-sched block">{t.scheduledOnly}</p>
        <p className="muted small">{ds.meta.realtime ? t.live.scheduleHelp : t.scheduledOnlyHelp}</p>
        {(dep.estimated || (alightIndex > dep.stopIndex && times[alightIndex]?.estimated)) && <p className="muted small">{t.estimatedNote}</p>}
      </div>

      {!busSession && <div className="card">
        {anotherLock ? <p className="small">{t.busLock.anotherLock}</p> : <button className="primary wide" onClick={onLock}>{t.lockBus}</button>}
      </div>}

      <LastReturnCard ds={ds} outbound={dep} toStopId={leg.toStopId} t={t} lang={ctx.lang} now={ctx.now} onOpen={onReturn} />
      {/* Heading out of New York is heading home; into Port Authority it is just "other buses there". */}
      <button className="ghost rescue-open" onClick={onRescue}>{ds.stops.find((s) => s.id === leg.toStopId)?.terminal ? t.rescue.otherWays : t.rescue.title}</button>

      {fare && ds.publishedFares && (
        <div className="card fare-card">
          <h2>{t.fareTitle} · {t.fareZones(fare.zones.min, fare.zones.max)}</h2>
          <div className="row-between"><span>{t.fareAdult}</span><strong>{money(fare.adult)}</strong></div>
          <div className="row-between"><span>{t.fareReduced}</span><strong>{money(fare.reduced)}</strong></div>
          {fare.zones.min !== fare.zones.max && <p className="warn small" role="note">{t.fareBoundary}</p>}
          <p className={atPabt ? 'warn small' : 'small'}>{atPabt ? t.fareAtPabt : t.fareCash}</p>
          <p className="muted small">{t.fareNote(fmtYmd(ds.publishedFares.effective, ctx.lang))}</p>
        </div>
      )}

      {gate && (
        <div className="card gate-card" data-status={gate.status}>
          <h2>{t.gateTitle}</h2>
          {gate.status === 'posted' && <p className="gate-big">{t.gatePosted(gate.gate, gate.door)}</p>}
          {gate.status === 'usual' && <><p className="gate-big">{t.gateUsual(gate.gate, gate.door)}</p><p className="muted small">{t.gateUsualNote(gate.samples)}</p></>}
          {gate.status === 'published' && <><p className="gate-big">{t.gatePublished(gate.gate, gate.door)}</p><p className="muted small">{t.gatePublishedNote(fmtYmd(gate.effective, ctx.lang))}</p></>}
          {gate.status === 'unknown' && <p className="gate-big">{t.gateUnknown}</p>}
          <p className="small">{t.gateConfirm}</p>
          {!ds.meta.demo && <p className="muted small" role="note">{t.gateConstruction}</p>}
          <p className="warn small" role="note">{t.ticketWarning}</p>
          <a className="link" href="https://www.njtransit.com/app" target="_blank" rel="noreferrer">{t.buyTicket} ↗</a>
        </div>
      )}

      <TicketGuide t={t} defaultOpen={atPabt} />

      <h2>{t.stops}</h2>
      <ol className="stop-list">
        {dep.pattern.stopIds.map((id, i) => (
          <li key={`${id}-${i}`} data-role={i === dep.stopIndex ? 'board' : i === alightIndex ? 'alight' : i < dep.stopIndex ? 'before' : undefined}>
            <span className="stop-time"><TimeText ctx={ctx} at={times[i]!.at} estimated={times[i]!.estimated} /></span>
            <span className="stop-name">{stopName(id)}</span>
            {i === dep.stopIndex && <span className="tag">{t.boardHere}</span>}
            {i === alightIndex && <span className="tag tag-alight">{t.getOffHere}</span>}
          </li>
        ))}
      </ol>
      {times.some((x) => x.estimated) && <p className="muted small">{t.estimatedNote}</p>}
    </section>
  );
}

function SettingsScreen({ ctx, settings, setSettings, onGuide, historyCount, onClearHistory }: {
  ctx: Ctx; settings: Settings; setSettings: (s: Settings) => void; onGuide: () => void; historyCount: number; onClearHistory: () => boolean;
}) {
  const { t, ds } = ctx;
  const [confirmClear, setConfirmClear] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  const [focusAfter, setFocusAfter] = useState<'heading' | 'clear' | undefined>();
  useEffect(() => {
    if (focusAfter === 'heading') historyHeading.current?.focus();
    if (focusAfter === 'clear') clearButton.current?.focus();
    if (focusAfter) setFocusAfter(undefined);
  }, [focusAfter]);
  const opt = <K extends keyof Settings>(k: K, v: Settings[K], label: string) => (
    <button className="chip" aria-pressed={settings[k] === v} onClick={() => setSettings({ ...settings, [k]: v })}>{label}</button>
  );
  return (
    <section>
      <h1>{t.settings}</h1>
      <label className="lock-toggle"><input type="checkbox" checked={settings.liveMotion} onChange={e => setSettings({ ...settings, liveMotion: e.currentTarget.checked })} />{t.live.motion}</label>
      <p className="small muted">{t.live.motionNote}</p>
      <h2>{t.language}</h2>
      <div className="choice-list">{opt('lang', 'en', 'English')}{opt('lang', 'es', 'Español')}</div>
      <h2>{t.skin}</h2>
      <div className="choice-list">{SKINS.map((k) => <span key={k}>{opt('skin', k, t.skins[k])}</span>)}</div>
      <p className="muted small">{t.skinNote}</p>
      <h2>{t.theme}</h2>
      <div className="choice-list">{opt('theme', 'system', t.themeSystem)}{opt('theme', 'light', t.themeLight)}{opt('theme', 'dark', t.themeDark)}</div>
      {settings.skin !== 'clean' && <p className="muted small">{t.themeCleanOnly}</p>}
      <h2>{t.departuresShown}</h2>
      <div className="choice-list">{opt('count', 3, '3')}{opt('count', 5, '5')}</div>
      <h2>{t.guide.title}</h2>
      <button className="ghost" onClick={onGuide}>{t.guideOpen}</button>
      <h2 tabIndex={-1} ref={historyHeading}>{t.history.settingsTitle}</h2>
      <p className="small">{t.history.count(historyCount)}</p>
      {historyCount > 0 && (confirmClear
        ? <div className="edit-row" role="group" aria-label={t.history.confirm}>
          <span className="small">{t.history.confirm}</span>
          <button className="danger" autoFocus onClick={() => { const ok = onClearHistory(); setConfirmClear(false); setCleared(ok); setClearFailed(!ok); setFocusAfter('heading'); }}>{t.history.yes}</button>
          <button className="ghost" onClick={() => { setConfirmClear(false); setFocusAfter('clear'); }}>{t.history.no}</button>
        </div>
        : <button ref={clearButton} className="ghost" onClick={() => { setCleared(false); setConfirmClear(true); }}>{t.history.clear}</button>)}
      <p className="small" role="status">{clearFailed ? t.confidence.clearFailed : cleared ? t.history.cleared : ''}</p>
      <h2>{t.about}</h2>
      <p className="small">{versionLine(t, ctx.lang, ctx.tz)}</p>
      <p className="small"><a className="link" href={`${import.meta.env.BASE_URL}licenses.txt`}>{t.licenses}</a></p>
      <h2>{t.dataSource}</h2>
      {ds.meta.realtime && <p className="small">{t.live.source}</p>}
      <p className="small">{ds.meta.source} · {ds.meta.feedVersion}</p>
      {ds.meta.transcribed && <p className="small">{t.transcribedBanner(fmtYmd(ds.meta.transcribed.issued, settings.lang))}</p>}
      {ds.meta.stopCities && <p className="small">{ds.meta.stopCities.state === 'verified' ? <>{t.selection.citySource} {new Intl.DateTimeFormat(settings.lang, { timeZone: ctx.tz, dateStyle: 'medium' }).format(new Date(ds.meta.stopCities.retrievedAt))}</> : t.selection.cityUnavailable}</p>}
      <p className="small muted">{dataNotice(ds, t)}</p>
      <p className="small muted">{t.appTagline}</p>
    </section>
  );
}
