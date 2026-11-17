// Stop alert outputs (issue #176): chime, spoken line and phone notification while Dale is open.
// Each is best effort and never throws: a phone without one of them still shows the on-screen countdown.
import type { Lang } from './i18n';

let audio: AudioContext | undefined;
function audioContext(): AudioContext | undefined {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return undefined;
    audio ??= new Ctor();
    return audio;
  } catch { return undefined; }
}

export const canSpeak = (): boolean => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
export const canChime = (): boolean => typeof window !== 'undefined' && (typeof window.AudioContext === 'function' || 'webkitAudioContext' in window);

/**
 * iPhone and some browsers only allow sound and speech after a tap on the page. Called from the rider's
 * own taps (the setting, the test button, any tap while riding) so later alerts can play.
 */
export function primeSound(): void {
  try { void audioContext()?.resume(); } catch { /* no sound */ }
  try { if (canSpeak()) window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* no speech */ }
}

/** Two short tones. */
export function chime(): void {
  const ctx = audioContext();
  if (!ctx) return;
  try {
    void ctx.resume();
    [0, 0.22].forEach((offset) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.18);
    });
  } catch { /* no sound */ }
}

/** Say one line in the rider's language with the phone's own voice; a newer line replaces an older one. */
export function speak(text: string, lang: Lang): void {
  if (!canSpeak()) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === 'es' ? 'es-US' : 'en-US';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch { /* no speech */ }
}

export type NotifySupport = 'supported' | 'iphone-install' | 'unsupported';

const isIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** iPhone only offers web notifications once Dale is added to the Home Screen and opened from there. */
export function notifySupport(): NotifySupport {
  if (typeof window === 'undefined') return 'unsupported';
  if ('Notification' in window) return 'supported';
  return isIos() ? 'iphone-install' : 'unsupported';
}

export const notifyPermission = (): NotificationPermission | 'unsupported' =>
  notifySupport() === 'supported' ? Notification.permission : 'unsupported';

/** Ask from the rider's own tap; resolves to whether notifications may be shown. */
export async function requestNotify(): Promise<boolean> {
  if (notifySupport() !== 'supported') return false;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

/**
 * Show one notification. Android Chrome only allows them through the service worker, so that comes first;
 * the page's own Notification is the fallback where no service worker is registered.
 */
export async function notify(title: string, body: string, tag: string): Promise<void> {
  if (notifyPermission() !== 'granted') return;
  const options = { body, tag, renotify: true, lang: document.documentElement.lang || undefined } as NotificationOptions;
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) { await reg.showNotification(title, options); return; }
  } catch { /* fall back below */ }
  try { new Notification(title, options); } catch { /* not shown */ }
}
