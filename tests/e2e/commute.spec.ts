import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// Wednesday Nov 4 2026, 7:50 AM New York time, on the invented demo dataset.
const URL = '/?now=2026-11-04T07:50&demo';

async function saveCommute(page: Page, query: string, pick: RegExp, dest: RegExp) {
  await page.getByRole('button', { name: /find a stop/i }).first().click();
  await page.getByRole('searchbox').fill(query);
  await page.getByRole('button', { name: new RegExp(pick.source.replace(/\$$/, ''), pick.flags) }).click();
  const choice = page.getByRole('button', { name: new RegExp(dest.source.replace(/\$$/, ''), dest.flags), includeHidden: true });
  const city = choice.locator('xpath=ancestor::details[1]');
  if (await city.count()) await city.locator('summary').click();
  await choice.click();
}

test('first run: wrong-side guard, save, zero-tap home on return', async ({ page }) => {
  await page.goto(URL);
  await expect(page.getByRole('note').first()).toContainText('Demo data');
  await expect(page.locator('footer.foot')).toContainText('may not be real time'); // NJ Transit data terms
  await saveCommute(page, 'maple', /Maple Ave & Main St \(to Demo Terminal\)/, /Port Authority Bus Terminal/);

  // Buses on this side go the other way: the app points across the street.
  await expect(page.getByRole('alert')).toContainText('Wrong side of the street');
  await page.getByRole('button', { name: 'Use that stop' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Maple Ave & Main St (to NYC)');
  await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
  await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();

  const card = page.getByRole('article');
  await expect(card.locator('[data-end="from"] .highway-name')).toHaveText('Maple Ave & Main St');
  await expect(card.locator('[data-end="to"] .highway-name')).toHaveText('New York');
  await expect(card.locator('[data-end="to"] .commute-stop')).toHaveText('Port Authority');
  await expect(card.locator('.dep-time')).toHaveText(['8:06 AM', '8:06 AM', '8:26 AM']);
  await expect(card.locator('.route-badge')).toHaveText(['165', '165T', '165T']);
  await expect(card.locator('.destination-clock .dep-arrival-scheduled').first()).toHaveText('8:55 AM');
  await expect(card.getByText('Scheduled only').first()).toBeVisible();

  // Reload = a returning rider: the next buses are there with no taps.
  await page.reload();
  await expect(page.getByRole('article').locator('.dep-time').first()).toHaveText('8:06 AM');
  await page.screenshot({ path: 'test-results/home.png', fullPage: true });
});

test('reverse, gate card, exact-bus lock, all-day timetable, Spanish', async ({ page }) => {
  await page.goto(URL);
  await saveCommute(page, '90002', /Maple Ave & Main St \(to NYC\)/, /Port Authority Bus Terminal/);
  await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();

  // One tap reverses the commute; the return leg ends at the home stop's twin across the street.
  await page.getByRole('button', { name: /Reverse/ }).click();
  const card = page.getByRole('article');
  await expect(card.locator('[data-end="from"] .highway-name')).toHaveText('New York');
  await expect(card.locator('[data-end="to"] .highway-name')).toHaveText('Maple Ave & Main St');
  await expect(card).toHaveAccessibleName('Port Authority Bus Terminal → Maple Ave & Main St (to Demo Terminal)');
  await expect(card.locator('.dep-gate').first()).toHaveText('Usually gate 212, door 2'); // same answer as the trip screen
  await card.locator('.dep').first().click();
  await expect(page.locator('.sign-led')).toHaveText('165 DEMO TERMINAL');
  await expect(page.locator('.gate-card')).toContainText('Usually gate 212, door 2');
  await expect(page.locator('.gate-card')).toContainText('Ticket required before boarding');
  await page.getByRole('button', { name: 'Lock onto this bus' }).click();
  await expect(page.locator('.lock-status')).toHaveText('Scheduled only: no live bus linked yet');
  await expect(page.locator('.stop-list li[data-role="alight"]')).toContainText('Maple Ave & Main St (to Demo Terminal)');
  await page.screenshot({ path: 'test-results/departure.png', fullPage: true });

  // Back on home the card is still reversed; its all-day timetable is the return leg.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: /Reverse/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /All day/ }).click();
  const rows = page.locator('table.timetable tbody tr');
  // Demo weekday return: the previous night's midnight local, 36 locals 6:00 AM-11:30 PM, 10 PM-peak expresses.
  await expect(rows).toHaveCount(47);
  await expect(rows.first().locator('.link-cell')).toHaveText('12:00 AM');
  await expect(rows.nth(1).locator('.link-cell')).toHaveText('6:00 AM');
  await expect(page.locator('tr.past')).toHaveCount(5); // 12:00, 6:00, 6:30, 7:00, 7:30 AM are before 7:50 AM
  await page.screenshot({ path: 'test-results/timetable.png', fullPage: true });

  // Spanish everywhere, 12-hour clock kept.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Español' }).click();
  await page.getByRole('button', { name: 'Atrás' }).click(); // back to the timetable it came from
  await expect(page.locator('table.timetable')).toBeVisible();
  await page.getByRole('button', { name: 'Atrás' }).click();
  await expect(page.getByRole('button', { name: /Invertir/ })).toBeVisible();
  await expect(page.getByRole('article').locator('.dep-time').first()).toHaveText(/^\d{1,2}:\d{2} (a|p)\.? ?m\.?$/i);
});

test('favorites keep the rider order', async ({ page }) => {
  await page.goto(URL);
  await saveCommute(page, '90002', /Maple Ave & Main St \(to NYC\)/, /Port Authority Bus Terminal/);
  await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
  await saveCommute(page, '90003', /Oak St & River Rd \(to NYC\)/, /Port Authority Bus Terminal/);
  await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
  const titles = page.getByRole('article').locator('h2');
  await expect(titles).toHaveText([/^Maple/, /^Oak/]);
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: /Move up/ }).nth(1).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(titles).toHaveText([/^Oak/, /^Maple/]);
  await page.reload();
  await expect(titles).toHaveText([/^Oak/, /^Maple/]);

  // A rider's custom name survives the sign treatment and Reverse; the actual leg stays visible.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Name', { exact: true }).first().fill('Mañana · mi viaje (to New York)');
  await page.getByRole('button', { name: 'Done' }).click();
  const renamed = page.getByRole('article').first();
  await renamed.getByRole('button', { name: /Reverse/ }).click();
  await expect(renamed.locator('h2')).toHaveText('Mañana · mi viaje (to New York)');
  await expect(renamed.locator('[data-end="from"] .highway-name')).toHaveText('New York');
  await expect(renamed.locator('[data-end="to"] .highway-name')).toHaveText('Oak St & River Rd');
});

test('first-ride guide from home and Settings, in English and Spanish', async ({ page }) => {
  await page.goto(URL);
  await page.getByRole('button', { name: 'First time riding? How it works' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your first ride');
  await expect(page.locator('.guide .card')).toHaveCount(6);
  await expect(page.locator('.guide')).toContainText('Put Dale on your home screen');
  await expect(page.locator('.guide')).toContainText('Buy your ticket or pass before you board');
  await expect(page.getByRole('link', { name: 'Call NJ Transit: 973-275-5555' })).toHaveAttribute('href', 'tel:+19732755555');
  await expect(page.locator('.guide')).toContainText('checked 11/3/2026');
  await page.screenshot({ path: 'test-results/guide.png', fullPage: true });

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Español' }).click();
  await page.getByRole('button', { name: '¿Primera vez? Cómo funciona' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tu primer viaje');
  await expect(page.locator('.guide')).toContainText('Compra tu boleto o pase antes de subir');
});

test('ticket guide: labeled drawings of paper and app tickets, never a usable ticket', async ({ page }) => {
  await page.goto(URL);
  await saveCommute(page, '90002', /Maple Ave & Main St \(to NYC\)/, /Port Authority Bus Terminal/);
  await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
  await page.getByRole('button', { name: /Reverse/ }).click();
  await page.getByRole('article').locator('.dep').first().click();

  await expect(page.locator('.trip-ticket-label')).toHaveText('Trip card · not a ticket');
  const guide = page.locator('details.ticket-guide');
  await expect(guide).toHaveAttribute('open', ''); // open by default when boarding at Port Authority
  await expect(guide.getByRole('img', { name: /paper one-way bus ticket, marked sample/ })).toBeVisible();
  await expect(guide.locator('svg text', { hasText: 'SAMPLE · NOT VALID' }).first()).toBeAttached();
  await expect(guide.locator('.ticket-notes li')).toHaveCount(5);
  await expect(guide.locator('.ticket-notes li').nth(1)).toContainText('30 days');
  await page.screenshot({ path: 'test-results/ticket-paper.png', fullPage: true });

  await guide.getByRole('button', { name: 'App ticket' }).click();
  await expect(guide.getByRole('img', { name: /app bus ticket, marked sample/ })).toBeVisible();
  await expect(guide.locator('.ticket-notes li').last()).toContainText('60 minutes after activation');
  await guide.locator('.ticket-figure').screenshot({ path: 'test-results/ticket-app.png' });

  // No real scannable code is ever drawn: the code area is a labeled hatch, not a QR or barcode image.
  await expect(guide.locator('image, img')).toHaveCount(0);

  // From a New Jersey stop the guide starts closed.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: /Reverse/ }).click();
  await page.getByRole('article').locator('.dep').first().click();
  await expect(page.locator('details.ticket-guide')).not.toHaveAttribute('open', '');
});

// A real-style dataset (meta.demo false) served in place of public/data/corridor.json: the NJ Transit
// source line must appear, the DEMO banner must not, and a stop time the build script filled in
// (trip.estimated) must read as an estimate everywhere it is shown.
const realStyle = {
  meta: { demo: false, source: 'NJ Transit GTFS', feedVersion: 'e2e', builtAt: '2026-11-01T00:00:00Z', timezone: 'America/New_York' },
  routes: [{ id: '10', shortName: '165', longName: 'E2E local' }],
  stops: [
    { id: '1', code: '30001', name: 'FIXTURE TERMINAL', lat: 40.88, lon: -74.045 },
    { id: '2', code: '30002', name: 'MAIN ST AT ELM', lat: 40.87, lon: -74.04 },
    { id: '3', name: 'PORT AUTHORITY BUS TERMINAL', lat: 40.757, lon: -73.991, terminal: 'PABT' },
  ],
  patterns: [{ id: 'P1', routeId: '10', directionId: 0, headsign: '165 NEW YORK', stopIds: ['1', '2', '3'] }],
  trips: [
    { id: 'T1', patternId: 'P1', serviceId: 'WK', times: [8 * 3600, 8 * 3600 + 20 * 60, 9 * 3600], arrivals: [8 * 3600, null, 9 * 3600], estimated: [1] },
    { id: 'T4', patternId: 'P1', serviceId: 'WK', times: [9 * 3600, 9 * 3600 + 10 * 60, 9 * 3600 + 50 * 60], arrivals: [9 * 3600, 9 * 3600 + 10 * 60, 9 * 3600 + 50 * 60] },
  ],
  calendars: { WK: { days: [true, true, true, true, true, false, false], start: '20261101', end: '20270430', added: [], removed: [] } },
};

// Blocked service worker: sw.js answers same-origin GETs itself, which would bypass page.route if it took control first.
test.describe('real data', () => {
  test.use({ serviceWorkers: 'block' });

  test('NJ Transit source line, no demo banner, filled-in times read as estimates', async ({ page }) => {
    await page.route('**/data/corridor.json', (route) => route.fulfill({ json: realStyle }));
    await page.goto('/?now=2026-11-04T07:50');
    await expect(page.locator('footer.foot')).toContainText('obtained from NJ Transit and redistributed from Dale');
    await expect(page.locator('footer.foot')).toContainText('may not be real time');
    await expect(page.locator('.demo-banner')).toHaveCount(0);

    await saveCommute(page, '30002', /MAIN ST AT ELM/, /PORT AUTHORITY BUS TERMINAL/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    const card = page.getByRole('article');
    // 8:20 AM at this stop is the filled-in time; the third entry is tomorrow's 8:20 AM.
    await expect(card.locator('.dep-time')).toContainText(['~8:20 AM', '9:10 AM', '~8:20 AM']);
    await expect(card.locator('.destination-clock .dep-arrival-scheduled').first()).toContainText('9:00 AM');
    await expect(card).toContainText('Estimated by Dale');

    await card.locator('.dep').first().click();
    await expect(page.locator('.trip-ticket .big-time').first()).toContainText('~8:20 AM');
    await expect(page.locator('.trip-ticket')).toContainText('Estimated by Dale');
    await expect(page.locator('.fare-card')).toHaveCount(0); // no fare table in this dataset
    await expect(page.locator('.stop-list .stop-time')).toContainText(['8:00 AM', '~8:20 AM', '9:00 AM']);
    await page.screenshot({ path: 'test-results/estimated.png', fullPage: true });
  });

  test('a failed load shows an error with a retry, never the demo', async ({ page }) => {
    let fail = true;
    await page.route('**/data/corridor.json', (route) => (fail ? route.abort('internetdisconnected') : route.fulfill({ json: realStyle })));
    await page.goto('/?now=2026-11-04T07:50');
    await expect(page.getByRole('alert')).toContainText("Couldn't load the schedule");
    await expect(page.locator('.demo-banner')).toHaveCount(0);
    fail = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('footer.foot')).toContainText('obtained from NJ Transit');
  });

  test("a saved copy from the service worker says when it was saved", async ({ page }) => {
    const savedAt = Date.parse('2026-11-04T12:30:00Z'); // 7:30 AM in New York
    await page.route('**/data/corridor.json', (route) =>
      route.fulfill({ json: realStyle, headers: { 'x-arriba-from-cache': '1', 'x-arriba-saved-at': String(savedAt) } }));
    await page.goto('/?now=2026-11-04T07:50');
    await expect(page.locator('.status-line')).toHaveText('The network is slow or down. Showing the schedule saved 11/4/2026, 7:30 AM.');
  });

  test('with no real dataset published, the labeled demo loads', async ({ page }) => {
    await page.route('**/data/corridor.json', (route) => route.fulfill({ status: 404, body: 'Not found' }));
    await page.goto('/?now=2026-11-04T07:50');
    await expect(page.locator('.demo-banner')).toBeVisible();
  });
});

// The committed public/data/corridor.json: route 165 typed in from NJ Transit's printed timetable.
test.describe('printed timetable data (route 165)', () => {
  test.use({ serviceWorkers: 'block' });

  test('a commute to an in-between stop reverses from across the street', async ({ page }) => {
    await page.goto('/?now=2026-11-04T07:50');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /^Hackensack \(Sears\) .*\(to New York\)$/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    const card = page.getByRole('article');
    await expect(card.locator('.dep-time')).toHaveCount(3);
    // The selected destination is Hackensack even though this stop's suffix says "to New York".
    await expect(card.locator('[data-end="to"] .highway-name')).toHaveText('Hackensack');
    await expect(card.locator('[data-end="to"] .commute-stop')).toHaveText('(Sears) · Main St. at Anderson St.');
    await page.getByRole('button', { name: /Reverse/ }).click();
    await expect(card.locator('[data-end="from"] .highway-name')).toHaveText('Hackensack');
    await expect(card.locator('[data-end="from"] .commute-stop')).toHaveText('(Sears) · Main St. at Anderson St.');
    await expect(card.locator('[data-end="to"] .highway-name')).toHaveText('Westwood');
    await expect(card.locator('[data-end="to"] .commute-stop')).toHaveText('Broadway at Irvington St.');
    await expect(card.locator('.dep-time')).toHaveCount(3);
  });

  test('commute sign and departure rows fit a 320 px phone with large text, in English and Spanish', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/?now=2026-11-04T17:10');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /Reverse/ }).click(); // Port Authority rows carry a gate line
    await page.addStyleTag({ content: 'html { font-size: 130%; } body { font-size: 20.8px; }' }); // the phone's text size set to 130%
    const overflow = () => page.evaluate(() => ({
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      row: Math.max(...[...document.querySelectorAll('.dep')].flatMap((b) => [...b.querySelectorAll('*')].map((e) => e.getBoundingClientRect().right - b.getBoundingClientRect().right))),
    }));
    await expect(page.locator('.dep-gate')).toHaveCount(3);
    await expect(page.locator('[data-end="from"] .highway-name')).toHaveText('New York');
    await expect(page.locator('[data-end="from"] .commute-stop')).toHaveText('Port Authority');
    await expect(page.locator('[data-end="to"] .highway-name')).toHaveText('Westwood');
    await expect(page.locator('[data-end="to"] .commute-stop')).toHaveText('Broadway at Irvington St.');
    expect(await overflow()).toEqual(expect.objectContaining({ page: 0 }));
    expect((await overflow()).row).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Español' }).click();
    await page.getByRole('button', { name: 'Atrás' }).click();
    await expect(page.locator('.dep-gate').first()).toContainText('regla impresa');
    await expect(page.locator('[data-end="from"] .highway-name')).toHaveText('Nueva York');
    await expect(page.locator('[data-end="from"] .highway-label')).toHaveText('Desde');
    await expect(page.locator('[data-end="to"] .highway-name')).toHaveText('Westwood');
    await expect(page.locator('[data-end="to"] .highway-label')).toHaveText('A');
    expect(await overflow()).toEqual(expect.objectContaining({ page: 0 }));
    expect((await overflow()).row).toBeLessThanOrEqual(0);
  });

  test('a trip that runs through the clock change says so', async ({ page }) => {
    // Fall-back night: the Saturday 1:10 AM bus toward Westwood runs to Oradell past 2 AM, when the clocks go back.
    await page.goto('/?now=2026-11-01T01:00');
    await saveCommute(page, 'port authority', /^New York - Port Authority Bus Terminal$/, /^Oradell - Kinderkamack Rd\. at New Milford Ave\./);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.locator('.dep').first().click();
    await expect(page.locator('.trip-ticket .big-time').first()).toContainText('1:10 AM');
    await expect(page.getByRole('note').filter({ hasText: 'Clocks go back an hour at 2 AM during this trip' })).toBeVisible();
    await expect(page.locator('.stop-list li[data-role="alight"] .stop-time')).toHaveText('1:08 AM');
    // An ordinary Saturday night: no note.
    await page.goto('/?now=2026-11-08T01:00');
    await page.locator('.dep').first().click();
    await expect(page.locator('.trip-ticket .big-time').first()).toContainText('1:10 AM');
    await expect(page.locator('.stop-list li[data-role="alight"] .stop-time')).toHaveText('2:08 AM');
    await expect(page.getByRole('note').filter({ hasText: 'Clocks go' })).toHaveCount(0);
    // Fall-back night again: a ride on the same bus that ends before 2 AM (Port Authority to Hackensack) gets no note.
    await page.goto('/?now=2026-11-01T01:00');
    await saveCommute(page, 'port authority', /^New York - Port Authority Bus Terminal$/, /^Hackensack \(Sears\) .*\(to Westwood\)$/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('article').nth(1).locator('.dep').first().click();
    await expect(page.locator('.trip-ticket .big-time').first()).toContainText('1:10 AM');
    await expect(page.locator('.stop-list li[data-role="alight"] .stop-time')).toHaveText('1:57 AM');
    await expect(page.getByRole('note').filter({ hasText: 'Clocks go' })).toHaveCount(0);
    // ...but boarding the same bus after the change (River Edge to Oradell, 1:03 AM) does get the note.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await saveCommute(page, 'river edge', /^River Edge .*\(to Westwood\)$/, /^Oradell - Kinderkamack Rd\. at New Milford Ave\./);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    // In real time the 1:14 AM bus (old clock) leaves before the 1:03 AM bus (new clock), so 1:14 is listed first.
    const card = page.getByRole('article').nth(2);
    await expect(card.locator('.dep-time').nth(0)).toHaveText('1:14 AM');
    await expect(card.locator('.dep-time').nth(1)).toHaveText('1:03 AM');
    await card.locator('.dep').nth(1).click();
    await expect(page.locator('.trip-ticket .big-time').first()).toContainText('1:03 AM');
    await expect(page.getByRole('note').filter({ hasText: 'Clocks go back an hour at 2 AM during this trip' })).toBeVisible();
    // The all-day timetable for that day explains the order too; the next day has no note.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('article').nth(2).getByRole('button', { name: /All day/ }).click();
    await expect(page.locator('table.timetable .link-cell').first()).toBeVisible();
    const listed = await page.locator('table.timetable .link-cell').allTextContents();
    expect(listed.slice(listed.indexOf('1:14 AM'), listed.indexOf('1:14 AM') + 2)).toEqual(['1:14 AM', '1:03 AM']);
    await expect(page.getByRole('note').filter({ hasText: 'Clocks go back an hour at 2 AM on this day' })).toBeVisible();
    await page.getByRole('tab', { name: 'Tomorrow' }).click();
    await expect(page.getByRole('note').filter({ hasText: 'Clocks go' })).toHaveCount(0);
  });

  test('the all-day timetable explains the clock change only where a listed bus runs through it', async ({ page }) => {
    // Spring-forward day: at Oradell the 1:10 AM bus's printed 2:08 arrival shows 3:08 AM, so the note shows.
    await page.goto('/?now=2027-03-14T00:30');
    await saveCommute(page, 'river edge', /^River Edge .*\(to Westwood\)$/, /^Oradell - Kinderkamack Rd\. at New Milford Ave\./);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /All day/ }).click();
    await expect(page.locator('table.timetable .link-cell').first()).toBeVisible();
    expect(await page.locator('table.timetable .link-cell').allTextContents()).toContain('3:03 AM');
    await expect(page.getByRole('note').filter({ hasText: 'Clocks go ahead an hour at 2 AM on this day' })).toBeVisible();
    // Same day, Weehawken to West New York: no bus runs through 2 AM there, every time reads as printed, no note.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await saveCommute(page, '47/48th', /^Weehawken - Blvd\. East at 47\/48th St\. \(to Westwood\)$/, /^West New York .*\(to Westwood\)$/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('article').nth(1).getByRole('button', { name: /All day/ }).click();
    await expect(page.locator('table.timetable .link-cell').first()).toBeVisible();
    await expect(page.getByRole('note').filter({ hasText: 'Clocks go' })).toHaveCount(0);
  });

  test('banner, wrong-side guard without coordinates, return trip with published gate', async ({ page }) => {
    await page.goto('/?now=2026-11-04T07:50');
    await expect(page.locator('.demo-banner')).toHaveCount(0);
    await expect(page.locator('.data-banner')).toHaveCount(0);
    await expect(page.getByText("on NJ Transit's holiday list")).toHaveCount(0);

    // A stop on the Westwood-bound side: buses here never reach Port Authority, and the twin is named without a distance.
    await saveCommute(page, 'irvington', /Irvington St\. \(to Westwood\)/, /Port Authority Bus Terminal/);
    await expect(page.getByRole('alert')).toContainText('Wrong side of the street');
    await expect(page.getByRole('alert')).not.toContainText(' m away');
    await page.getByRole('button', { name: 'Use that stop' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Westwood - Broadway at Irvington St. (to New York)');
    // Every stop toward New York is offered; the Westwood-bound short-trip ends (River Edge, Oradell) are not.
    await expect(page.getByRole('button', { name: /^River Edge .*\(to New York\)/, includeHidden: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: /(River Edge|Oradell).*\(to Westwood\)/, includeHidden: true })).toHaveCount(0);
    await page.getByRole('button', { name: /Port Authority Bus Terminal/ }).click();
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();

    const card = page.getByRole('article');
    await expect(card.locator('.dep-time')).toHaveCount(3);
    await expect(card.locator('.route-badge').first()).toHaveText(/^165T?$/);

    // Return trip: board at Port Authority, get off at the same corner's twin on the Westwood-bound side.
    await page.getByRole('button', { name: /Reverse/ }).click();
    await expect(card.locator('[data-end="from"] .highway-name')).toHaveText('New York');
    await expect(card.locator('[data-end="to"] .highway-name')).toHaveText('Westwood');
    await expect(card.locator('[data-end="to"] .commute-stop')).toHaveText('Broadway at Irvington St.');
    // Leaving Port Authority, each row names the gate and says it is the printed rule, not a posted gate.
    await expect(card.locator('.dep-gate')).toHaveCount(3);
    await expect(card.locator('.dep-gate').first()).toHaveText(/^Gate (212|311|312|310)(, door \d+)? · printed rule$/);
    await card.locator('.dep').first().click();
    await expect(page.locator('.sign-label')).toHaveText('Route and destination');
    await expect(page.locator('.gate-card')).toContainText(/Gate (212|311|312|310)/);
    await expect(page.locator('.gate-card')).toContainText("NJ Transit's printed timetable lists this gate");
    await expect(page.locator('.gate-card')).toContainText('Always confirm on the terminal departure screens');
    await expect(page.locator('.gate-card')).toContainText('construction at Port Authority may change gate assignments');
    await expect(page.locator('.stop-list li[data-role="alight"]')).toContainText('Westwood - Broadway at Irvington St. (to Westwood)');
    // Printed cash fare: Port Authority to Westwood crosses four zone lines.
    await expect(page.locator('.fare-card h2')).toHaveText('Fare · 5 zones');
    await expect(page.locator('.fare-card')).toContainText('$8.45');
    await expect(page.locator('.fare-card')).toContainText('$3.85');
    await expect(page.locator('.fare-card')).toContainText('fares effective 7/1/2026');
    await expect(page.locator('.fare-card')).not.toContainText('makes change');
    await expect(page.locator('.fare-card')).toContainText('you need a ticket or pass before you board');
    await page.screenshot({ path: 'test-results/printed-departure.png', fullPage: true });
  });

  test("Thanksgiving: holiday warning at the top, in the timetable and on the trip", async ({ page }) => {
    await page.goto('/?now=2026-11-26T07:50');
    await expect(page.locator('.status-line')).toContainText("Today is on NJ Transit's holiday list");
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /All day/ }).click();
    const holidayNote = page.getByRole('note').filter({ hasText: "This day is on NJ Transit's holiday list" });
    await expect(holidayNote).toBeVisible();
    await page.getByRole('tab', { name: 'Tomorrow' }).click(); // Friday after Thanksgiving is on the list too
    await expect(holidayNote).toBeVisible();
    await page.locator('.link-cell').first().click();
    await expect(holidayNote).toBeVisible();
  });

  test('a stop whose buses never reach Port Authority says which side to use instead', async ({ page }) => {
    await page.goto('/?now=2026-11-04T07:50');
    await page.getByRole('button', { name: /find a stop/i }).first().click();
    await page.getByRole('searchbox').fill('emerson');
    await page.getByRole('button', { name: /Emerson .*\(to Westwood\)/ }).click();
    await expect(page.getByRole('note').filter({ hasText: 'No bus from this stop goes to Port Authority' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Port Authority/ })).toHaveCount(0);
  });
});

test.describe('Get me home (issue #32)', () => {
  test.use({ serviceWorkers: 'block' });
  test('lists every scheduled way home in the data and says what it did not search', async ({ page }) => {
    await page.goto('/?now=2026-11-04T18:00');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.locator('.dep').first().click();
    await page.getByRole('button', { name: 'Other buses there' }).click(); // heading into New York
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Other buses there');
    await page.getByRole('button', { name: 'Back', exact: true }).click(); // back to the trip it came from
    await expect(page.locator('.trip-ticket')).toBeVisible();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: /Reverse/ }).click();
    await page.locator('.dep').first().click();
    await page.getByRole('button', { name: 'Get me the fuck home' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Get me the fuck home');
    const items = page.locator('.rescue-list li');
    expect(await items.count()).toBeGreaterThan(2);
    await expect(items.first()).toContainText('Gate');
    await expect(page.locator('.rescue')).toContainText('Only routes in Dale’s data are searched: 165, 165T');
    await expect(page.locator('.rescue')).toContainText('No walking routes or transfers are suggested');
    await expect(page.locator('.rescue')).toContainText('Last tonight on your line');
    const { violations } = await new AxeBuilder({ page }).include('.rescue').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    await items.first().click();
    await expect(page.locator('.trip-ticket')).toBeVisible();
  });
});

test('Back returns to the screen the rider came from, and home starts over', async ({ page }) => {
  await page.goto(URL);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Settings' }).click(); // a second tap does not stack a copy
  await page.getByRole('button', { name: 'First time riding? How it works' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your first ride');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Save your stop once');
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0); // home has no Back
});

test.describe('history (issue #48)', () => {
  test.use({ serviceWorkers: 'block' });

  test('more than 20 screens deep, Back still reaches home', async ({ page }) => {
    await page.goto('/?now=2026-11-04T18:00');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /Reverse/ }).click();
    await page.locator('.dep').first().click();
    for (let i = 0; i < 12; i++) {
      await page.getByRole('button', { name: 'Get me the fuck home' }).click();
      await page.locator('.rescue-list li').first().click();
    }
    for (let i = 0; i < 30 && (await page.getByRole('button', { name: 'Back', exact: true }).count()); i++) await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('button', { name: /Reverse/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  });

  test('the timetable keeps its chosen day when the rider comes back from a trip', async ({ page }) => {
    await page.goto('/?now=2026-11-04T07:50');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /All day/ }).click();
    await page.getByRole('tab', { name: 'Tomorrow' }).click();
    await page.locator('table.timetable .link-cell').first().click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Tomorrow' })).toHaveAttribute('aria-selected', 'true');
  });

  test('the phone’s or browser’s own Back steps back inside Dale', async ({ page }) => {
    await page.goto('/?now=2026-11-04T07:50');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    const url = page.url();
    await page.locator('.dep').first().click();
    await expect(page.locator('.trip-ticket')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('button', { name: /Reverse/ })).toBeVisible();
    expect(page.url()).toBe(url); // nothing about the trip was put in the address
  });
});

test.describe('last-bus reminder (issue #58)', () => {
  test.use({ serviceWorkers: 'block' });
  test('counts down to the last listed return and saves a calendar reminder', async ({ page }) => {
    await page.goto('/?now=2026-11-04T18:00');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.locator('.dep').first().click();
    const card = page.locator('.last-return');
    await expect(card.locator('.last-bus-reminder p').first()).toHaveText(/^Leaves in \d+ h \d+ min \(scheduled\)\.$/);
    const download = page.waitForEvent('download');
    await card.getByRole('button', { name: 'Add a calendar reminder 30 minutes before' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^dale-last-165-\d{8}\.ics$/);
    const body = await (await file.createReadStream()).toArray();
    const ics = Buffer.concat(body).toString('utf8');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('TRIGGER:-PT30M');
    expect(ics.replace(/\r\n /g, '')).toContain('SUMMARY:Last listed 165 home');
    expect(ics.replace(/\r\n /g, '')).toContain('schedule changes\\; check');
  });
});
test.describe('boarding check (issue #55)', () => {
  test.use({ serviceWorkers: 'block' });
  test('confirms the scheduled trip serves your stop and shows the driver a bilingual card', async ({ page }) => {
    await page.goto('/?now=2026-11-04T18:00');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /Reverse/ }).click();
    await page.locator('.dep').first().click();
    await page.getByRole('button', { name: 'Boarding check' }).click();
    const check = page.locator('.boarding-check');
    await expect(check.getByRole('status')).toContainText('This scheduled trip stops at Westwood - Broadway at Irvington St. (to Westwood)');
    await expect(check).toContainText(/Gate \d+.*printed rule/);
    await expect(check).toContainText('not the bus in front of you');
    const { violations } = await new AxeBuilder({ page }).include('.boarding-check').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    await check.getByRole('button', { name: 'Show the driver' }).click();
    const card = page.locator('.driver-card');
    await expect(card.locator('[lang="en"]')).toHaveText('Does this bus stop at Westwood - Broadway at Irvington St.?');
    await expect(card.locator('[lang="es"]')).toHaveText('¿Este autobús para en Westwood - Broadway at Irvington St.?');
    await expect(card.locator('[lang="en"]')).toBeFocused();
    await card.getByRole('button', { name: 'Done' }).click();
    await expect(check).toBeVisible();
    await expect(check.getByRole('button', { name: 'Show the driver' })).toBeFocused();
  });
});

test.describe('boarding check on a request-only stop', () => {
  test.use({ serviceWorkers: 'block' });
  test('a PM Parkway express to the Exit 165 Park/Ride says it stops only if you ask', async ({ page }) => {
    await page.goto('/?now=2026-11-04T17:10');
    await saveCommute(page, 'port authority', /^New York - Port Authority Bus Terminal$/, /^Paramus - GSP Exit 165 Park\/Ride Lot/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /All day/ }).click();
    await page.locator('table.timetable tr').filter({ hasText: '5:15 PM' }).locator('.link-cell').click();
    await page.getByRole('button', { name: 'Boarding check' }).click();
    const check = page.locator('.boarding-check');
    await expect(check.getByRole('status')).toContainText('stops there only if you ask the driver when you board');
    await expect(check.getByRole('note').filter({ hasText: 'Exit 165 Park/Ride lot' })).toBeVisible();
  });
});

test.describe('leave-by countdown (issue #54)', () => {
  test.use({ serviceWorkers: 'block' });
  test('flags the bus that arrives first on the demo', async ({ page }) => {
    await page.goto(URL);
    await saveCommute(page, 'maple', /Maple Ave & Main St \(to NYC\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    const card = page.getByRole('article');
    // Two 8:06 buses: the 165T express gets in first, and the card says why.
    await expect(card.locator('.dep').nth(1).locator('.tag-first')).toHaveText('Arrives first');
    await expect(card.locator('.tag-first')).toHaveCount(1);
    await expect(card.locator('.leave-why')).toHaveText(/^The 165T at 8:06 AM leaves at the same time and is scheduled to arrive (about )?\d+ min sooner\.$/);
  });

  test('counts down to leaving, plans an arrive-by time, and keeps the plan on this phone', async ({ page }) => {
    await page.goto('/?now=2026-11-04T06:49');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    const card = page.getByRole('article');
    await card.getByRole('button', { name: 'Leave by', exact: true }).click();
    await expect(card.getByRole('heading', { name: 'Leave-by countdown' })).toBeFocused();
    await card.getByLabel('Minutes to walk to the stop').fill('75');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('alert')).toHaveText('Enter whole minutes: walking 0 to 60, spare 0 to 30.');
    await card.getByLabel('Minutes to walk to the stop').fill('5');
    await card.getByLabel('Spare minutes').fill('3');
    await card.getByLabel('Arrive by (optional)').fill('09:00');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByRole('button', { name: 'Walking time' })).toBeFocused();

    const leave = card.locator('.leave-by');
    // The 6:53 is too soon to walk to; the 7:00 AM means leaving by 6:52 (5 min walk + 3 spare). The latest bus scheduled in by 9:00 is the 7:52 (8:37 AM).
    await expect(leave.locator('.leave-count')).toHaveText('Leave in 3 min');
    await expect(leave).toContainText('for the 7:00 AM bus · 5 min walk + 3 min spare');
    await expect(leave.locator('.leave-arrive')).toHaveText('To arrive by 9:00 AM: leave by 7:44 AM for the 7:52 AM bus (scheduled to arrive 8:37 AM).');
    await expect(leave).toContainText('Dale does not remind you in the background');
    await expect(card.locator('.dep').first().locator('.dep-toosoon')).toHaveText("Can't walk there in time");
    await expect(card.locator('.dep').nth(1).locator('.dep-toosoon')).toHaveCount(0);
    expect((await new AxeBuilder({ page }).include('.fav').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);

    // Kept on this phone, for this direction only.
    await page.reload();
    await expect(page.getByRole('article').locator('.leave-count')).toBeVisible();
    await page.getByRole('button', { name: /Reverse/ }).click();
    await expect(page.getByRole('article').locator('.leave-by')).toHaveCount(0);
    await page.getByRole('button', { name: /Reverse/ }).click();

    // A long walk: the next buses are marked as out of reach, and the countdown is for one you can make.
    await page.getByRole('article').getByRole('button', { name: 'Walking time' }).click();
    await page.getByLabel('Minutes to walk to the stop').fill('60');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('article').locator('.dep-toosoon').first()).toHaveText("Can't walk there in time");

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Español' }).click();
    await page.getByRole('button', { name: 'Atrás' }).click();
    await expect(page.getByRole('article').locator('.leave-count')).toHaveText(/^Sal (en \d+ min|ahora)$/);
    await expect(page.getByRole('article').locator('.leave-by')).toContainText(/para el autobús de las? ~?\d{1,2}:\d\d a\. ?m\./);

    await page.getByRole('article').getByRole('button', { name: 'Tiempo a pie' }).click();
    await page.getByRole('button', { name: 'Quitar' }).click();
    await expect(page.getByRole('article').locator('.leave-by')).toHaveCount(0);
  });
});
test.describe('saved backup plans (issue #62)', () => {
  test.use({ serviceWorkers: 'block' });
  test('the rider keeps their own plans on the rescue screen, labeled as their notes', async ({ page }) => {
    await page.goto('/?now=2026-11-04T18:00');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    await page.getByRole('button', { name: /Reverse/ }).click();
    await page.locator('.dep').first().click();
    await page.getByRole('button', { name: 'Get me the fuck home' }).click();
    const box = page.locator('.backups');
    await expect(box.getByRole('heading', { name: 'Your backup plans' })).toBeVisible();
    await expect(box).toContainText('Your own notes, not Dale schedule data');

    await box.getByRole('button', { name: 'Add a backup plan' }).click();
    await expect(box.getByLabel('Plan', { exact: true })).toBeFocused();
    await box.getByRole('button', { name: 'Save' }).click();
    await expect(box.getByRole('alert')).toHaveText('Write the plan first.');
    await box.getByLabel('Plan', { exact: true }).fill('  Take the 167 to Hackensack  ');
    await box.getByLabel('Drop-off or pickup place (optional)').fill('Hackensack Bus Terminal');
    await box.getByLabel('Notes (optional)').fill('Text Diego first.\nWait inside.');
    await box.getByRole('button', { name: 'Save' }).click();
    await expect(box.locator('.backup-plan')).toHaveText('Take the 167 to Hackensack');
    await expect(box).toContainText('Drop-off or pickup: Hackensack Bus Terminal');
    await expect(box.getByRole('button', { name: 'Add a backup plan' })).toBeFocused();
    expect((await new AxeBuilder({ page }).include('.backups').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    // Not in the schedule list: Dale never ranks or checks it.
    await expect(page.locator('.rescue-list')).not.toContainText('167');

    // Kept on this phone across a reload, and edited in place.
    await page.reload();
    await page.getByRole('button', { name: /Reverse/ }).click();
    await page.locator('.dep').first().click();
    await page.getByRole('button', { name: 'Get me the fuck home' }).click();
    await expect(box.locator('.backup-plan')).toHaveText('Take the 167 to Hackensack');
    await box.getByRole('button', { name: 'Edit' }).click();
    await box.getByLabel('Plan', { exact: true }).fill('Take the 167 to Hackensack, Diego picks me up');
    await box.getByRole('button', { name: 'Save' }).click();
    await expect(box.locator('.backup-plan')).toHaveText('Take the 167 to Hackensack, Diego picks me up');
    await expect(box.getByRole('button', { name: 'Edit' })).toBeFocused();
    await expect(box.locator('.backup-note')).toHaveText('Text Diego first.\nWait inside.');

    // Removing asks first.
    await box.getByRole('button', { name: 'Remove' }).click();
    await expect(box.getByRole('button', { name: 'Yes, remove' })).toBeFocused();
    await box.getByRole('button', { name: 'Keep it' }).click();
    await expect(box.locator('.backup')).toHaveCount(1);
    await expect(box.getByRole('button', { name: 'Remove' })).toBeFocused();
    await box.getByRole('button', { name: 'Remove' }).click();
    await box.getByRole('button', { name: 'Yes, remove' }).click();
    await expect(box.locator('.backup')).toHaveCount(0);
    await expect(box.getByRole('button', { name: 'Add a backup plan' })).toBeFocused();
    await expect(box).toContainText('Write down what you would do if the bus never comes');
  });
});
test.describe('home card actions and version (owner request 2026-11-04)', () => {
  test.use({ serviceWorkers: 'block' });
  test('the commute card opens Get me home directly, and the footer and Settings show the version and build time', async ({ page }) => {
    await page.goto('/?now=2026-11-04T18:00');
    await saveCommute(page, 'irvington', /Irvington St\. \(to New York\)/, /Port Authority Bus Terminal/);
    await page.getByRole('button', { name: 'Save trip', exact: true }).first().click();
    const card = page.getByRole('article');
    await expect(card).toContainText('Tap a bus to lock onto it, ride, check it or share');
    await card.getByRole('button', { name: /Reverse/ }).click();
    await card.getByRole('button', { name: 'Get me the fuck home' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Get me the fuck home');
    await expect(page.locator('.rescue-list li').first()).toBeVisible();
    await expect(page.locator('.version-line')).toHaveText(/^Dale \d+\.\d+\.(\d+|local) \([0-9a-z]+\) · app updated \d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d\d [AP]M$/);
    // Always in view in the top bar, on every screen (owner request 2026-11-05).
    // Owner request 2026-11-11: lower-case am/pm kept with its time, and the slogan beside the wordmark.
    await expect(page.locator('.top .top-stamp')).toHaveText(/^Version and when this app was updated: v\d+\.\d+\.(\d+|local) · \d{1,2}\/\d{1,2} \d{1,2}:\d\d\u00a0[ap]m$/);
    await expect(page.locator('.top .top-slogan')).toHaveText('When you ride NJ Transit, you need all the help you can get!');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'About this version' })).toBeVisible();
  });
});
test.describe('a real commute opened on the demo (owner report 2026-11-05)', () => {
  test.use({ serviceWorkers: 'block' });
  test('says why there are no buses, never shows a stop code, and leads back to the real schedule', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('arriba.favorites.v1', JSON.stringify([{ id: 'f', label: 'Hackensack - State St. at Lawerence St. (to New York) → New York - Port Authority Bus Terminal', fromStopId: 'N10', toStopId: 'PABT', routeIds: [] }])));
    await page.goto('/?now=2026-11-05T07:30&demo');
    const card = page.getByRole('article');
    await expect(card).toContainText('This commute was saved from the real schedule');
    await expect(card).toContainText('Hackensack - State St. at Lawerence St.');
    await expect(page.locator('main')).not.toContainText('N10');
    expect((await new AxeBuilder({ page }).include('.fav-missing').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
    await card.getByRole('link', { name: 'Leave the demo' }).click();
    await expect(page).toHaveURL(/\?now=2026-11-05T07:30$/);
    await expect(page.locator('.demo-banner')).toHaveCount(0);
    await expect(page.getByRole('article').locator('[data-end="from"] .highway-name')).toHaveText('Hackensack');
    await expect(page.getByRole('article').locator('.dep').first()).toBeVisible();
  });
});
