// cfb-scoreboard checks — run with `npm test` (CI) or `CHROME=/path/to/chrome node tests/check.mjs [--prev old.html] [--board-change] [--out dir]`
// Everything runs in DEMO mode (?demo) with the clock frozen, animations off and every network request blocked, so the
// output is deterministic. The baseline check renders the PREVIOUS index.html in the same browser and compares the
// 1920×1080 board pixel for pixel: the projector view must not change unless the commit says so ([board-change]).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PREV = opt('--prev', ''), OUT = opt('--out', path.join(here, 'out')), BOARD_CHANGE = args.includes('--board-change');
const INDEX = path.join(here, '..', 'index.html');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg); } };
const same = (a, b) => a.length === b.length && a.equals(b);

// 1. the script parses
{
  const html = fs.readFileSync(INDEX, 'utf8');
  const m = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
  try { new vm.Script(m[1], { filename: 'index.html' }); ok(true, 'script parses'); } catch (e) { ok(false, 'script parses: ' + e.message); }
  ok(/<!-- cfb-scoreboard v\d/.test(html), 'version comment present');
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
const FROZEN = 1790000000000;   // a fixed instant: the demo fixture shifts its Saturday onto "today", so this keeps every date stable

const NOANIM = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent}';   // ::before too — the upset sweep lives there
async function load(page, file, hash) {   // the clock is PAUSED at FROZEN: nothing moves unless the test runs it forward
  await page.goto(pathToFileURL(file).href + '?demo' + (hash || ''));
  await page.addStyleTag({ content: NOANIM });
  await page.waitForTimeout(300); await page.clock.runFor(1500); await page.waitForTimeout(200);
}
async function open(ctx, file, hash, errors) {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.clock.install({ time: FROZEN - 60000 });
  await page.clock.pauseAt(FROZEN);
  await load(page, file, hash);
  return page;
}
async function boardShot(page, file) { const buf = await page.screenshot({ path: file }); return buf; }
async function pixelDiff(a, b, outFile) {   // pixelmatch when it is installed (CI), else a byte comparison
  try {
    const { PNG } = await import('pngjs'); const { default: pixelmatch } = await import('pixelmatch');
    const A = PNG.sync.read(a), B = PNG.sync.read(b);
    if (A.width !== B.width || A.height !== B.height) return { n: -1 };
    const D = new PNG({ width: A.width, height: A.height });
    const n = pixelmatch(A.data, B.data, D.data, A.width, A.height, { threshold: 0.05 });
    if (n && outFile) fs.writeFileSync(outFile, PNG.sync.write(D));
    return { n };
  } catch (e) { return { n: same(a, b) ? 0 : -2 }; }
}

// 2. desktop board + game page
{
  console.log('desktop 1920×1080');
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await open(ctx, INDEX, '', errors);
  const cards = await page.locator('.card').count();
  ok(cards >= 1, 'default board shows the favorite\'s game(s): ' + cards);
  const status = v => page.evaluate(v => { document.getElementById('status').style.visibility = v; }, v);   // the countdown ticks when the test runs the clock
  await status('hidden'); const shotA = await boardShot(page, path.join(OUT, 'board-default.png')); await status('');
  ok((await page.evaluate(() => [document.body.scrollWidth, document.body.clientWidth]))[0] <= 1920, 'board has no horizontal overflow');

  // game page
  await page.locator('.card').first().click();
  await page.waitForTimeout(200); await page.clock.runFor(500); await page.waitForTimeout(100);
  ok(!(await page.evaluate(() => document.getElementById('gp').hidden)), 'clicking a tile opens the game page');
  const secs = await page.evaluate(() => [...document.querySelectorAll('#gp .gps')].map(s => s.className.replace('gps ', '')));
  ok(secs.includes('wp') && secs.includes('scor') && secs.includes('drv') && secs.includes('stats') && secs.includes('box'), 'live page has win prob, scoring, drives, team stats, box score: ' + secs.join(' '));
  ok(secs.includes('stand') && secs.includes('vid'), 'standings and highlights render');
  await page.waitForTimeout(300);
  const ssn = await page.evaluate(() => ({ teams: document.querySelectorAll('.ssnt').length, rows: document.querySelectorAll('.sst tr').length, me: document.querySelectorAll('.sst tr.me').length, wl: document.querySelectorAll('.sst tr.w, .sst tr.l').length, bye: document.querySelectorAll('.sst tr.bye').length, rec: document.querySelector('.ssnt .rec') && document.querySelector('.ssnt .rec').innerText }));
  ok(ssn.teams === 2 && ssn.me === 2 && ssn.wl >= 10 && ssn.bye >= 2, 'season schedules for both teams, this game highlighted, results and byes: ' + JSON.stringify(ssn));
  ok(/\d+-\d+/.test(ssn.rec || '') && /for \//.test(ssn.rec || ''), 'season summary line has record and points for/against: ' + ssn.rec);
  const ax = await page.evaluate(() => document.querySelector('.wp .ax') && document.querySelector('.wp .ax').innerText.replace(/\s+/g, ' '));
  ok(/Q1 Q2 Q3 Q4/.test(ax || ''), 'win probability axis is game time: ' + ax);
  ok((await page.locator('.wpo .mk').count()) > 0, 'scoring / turnover markers on the curve');
  const gpOverflow = await page.evaluate(() => { document.querySelectorAll('#gp details').forEach(d => d.open = true); const w = document.getElementById('gpw'); return [w.scrollWidth, w.clientWidth]; });
  ok(gpOverflow[0] <= gpOverflow[1], 'game page has no horizontal overflow with every table open');
  await page.screenshot({ path: path.join(OUT, 'game-live.png') });

  // scrub: hover, pin, arrows, rebuild survival, Now, Escape
  const cap = () => page.evaluate(() => ({ l: document.querySelector('.wp .capl').innerText, r: document.querySelector('.wp .capr').innerText, s: window.__cfb.scrub() }));
  const box = await page.locator('.wpc').boundingBox();
  const now = await cap();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
  const hov = await cap();
  ok(hov.s.hover != null && hov.l !== now.l, 'hover scrubs the history: ' + hov.l);
  await page.mouse.click(box.x + box.width * .25, box.y + box.height * .5);
  const pin = await cap();
  ok(pin.s.pin != null, 'click pins the cursor: ' + pin.l);
  await page.keyboard.press('ArrowLeft');
  const left = await cap();
  ok(left.s.pin !== pin.s.pin && left.s.hover == null, 'arrow key nudges the pinned cursor: ' + left.l);
  await page.evaluate(() => window.__cfb.rebuild());
  const after = await cap();
  ok(after.l === left.l && after.s.pin === left.s.pin, 'cursor survives a full rebuild of the page');
  await page.mouse.move(10, 10);
  ok((await cap()).l === left.l, 'leaving the chart returns to the pinned point');
  await page.keyboard.press('Escape');
  const esc = await cap();
  ok(esc.s.pin == null && esc.l === now.l && !(await page.evaluate(() => document.getElementById('gp').hidden)), 'Escape unpins first (page stays open)');
  await page.keyboard.press('Escape');
  ok(await page.evaluate(() => document.getElementById('gp').hidden), 'second Escape closes the page');
  await page.waitForTimeout(200);
  await status('hidden'); const shotB = await boardShot(page, path.join(OUT, 'board-after-page.png')); await status('');
  const d1 = await pixelDiff(shotA, shotB, path.join(OUT, 'diff-board-after-page.png'));
  ok(d1.n === 0, 'board is pixel-identical after closing the game page (' + d1.n + ' px differ)');

  // finals: recap + result card, OT axis, pregame
  await load(page, INDEX, '#g=404');
  const fsecs = await page.evaluate(() => [...document.querySelectorAll('#gp .gps')].map(s => s.className.replace('gps ', '')));
  ok(fsecs.includes('rcp'), 'a final has the recap / result card');
  const kv = await page.evaluate(() => document.querySelector('.rcp .kv') ? document.querySelector('.rcp .kv').innerText : '');
  ok(/Against the spread/i.test(kv) && /Total/i.test(kv), 'result against the line and the total render');
  await page.screenshot({ path: path.join(OUT, 'game-final.png') });
  await load(page, INDEX, '#g=406');
  ok(/OT/.test(await page.evaluate(() => document.querySelector('.wp .ax').innerText)), 'overtime gets its own axis segment');
  await load(page, INDEX, '#g=405');
  const psecs = await page.evaluate(() => [...document.querySelectorAll('#gp .gps')].map(s => s.className.replace('gps ', '')));
  ok(psecs.join(' ') === 'pre ssn', 'a scheduled game shows the preview and the season schedules only: ' + psecs.join(' '));
  ok(/moneyline|line/i.test(await page.evaluate(() => document.querySelector('.gps.pre').innerText)), 'preview carries the line');

  // board guards: 12 cards, flash, stale, adaptive cadence
  await load(page, INDEX, '');
  await page.keyboard.press('p'); await page.locator('[data-act=tickall]').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  ok((await page.locator('.card').count()) === 12, 'ticking every demo game gives 12 cards');
  ok((await page.locator('.card .wpf').count()) >= 5, 'live tiles carry a win probability');
  ok((await page.evaluate(() => window.__cfb.cadence())) === 15, 'adaptive cadence is 15 s with a late close game on the board');
  await page.evaluate(() => { window.__cfb.flash('401', 'home'); window.__cfb.fail(2); });
  ok((await page.locator('.card.flash').count()) === 1 && (await page.locator('.tm.scored').count()) === 1, 'a moved score flashes its tile');
  ok(await page.evaluate(() => document.body.classList.contains('stale')), 'two failed refreshes raise the stale guard');
  await page.screenshot({ path: path.join(OUT, 'board-12.png') });

  // settings link round-trip
  const link = await page.evaluate(() => window.__cfb.link());
  ok(/#s=[\w-]+$/.test(link), 'settings link is built');
  const ctx2 = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const p2 = await ctx2.newPage(); await p2.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await p2.goto(pathToFileURL(INDEX).href + '?demo' + link.slice(link.indexOf('#'))); await p2.waitForTimeout(600);
  const got = await p2.evaluate(() => ({ msg: window.__cfb.linkMsg(), s: window.__cfb.settings(), hash: location.hash }));
  ok(/applied/i.test(got.msg) && got.hash === '' && got.s.favorites.length >= 1, 'settings link applies on a fresh browser and clears the hash');
  await ctx2.close();

  ok(errors.length === 0, 'no page errors on desktop' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
}

// 3. phone 390×844
{
  console.log('phone 390×844');
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await open(ctx, INDEX, '', errors);
  ok(await page.evaluate(() => document.body.classList.contains('m')), 'phone mode is on');
  const bo = await page.evaluate(() => [document.body.scrollWidth, document.body.clientWidth]);
  ok(bo[0] <= bo[1], 'phone board has no horizontal overflow');
  await page.screenshot({ path: path.join(OUT, 'phone-board.png') });
  await load(page, INDEX, '#g=401');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => { const d = document.querySelector('details[data-k^="ssn"]'); return d && !d.open; });
  ok(closed, 'phone: season schedules start closed');
  await page.locator('.gpt[data-team]').first().click();
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => { const d = document.querySelector('details[data-k^="ssn"]'); return d && d.open; }), 'tapping a team in the header opens its season');
  const go = await page.evaluate(() => { document.querySelectorAll('#gp details').forEach(d => d.open = true); const w = document.getElementById('gpw'); return [w.scrollWidth, w.clientWidth]; });
  ok(go[0] <= go[1], 'phone game page has no horizontal overflow with every table open');
  // touch scrub: a drag across the chart, released → pinned
  await page.locator('.wpc').scrollIntoViewIfNeeded();
  const bx = await page.locator('.wpc').boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const cap = () => page.evaluate(() => ({ l: document.querySelector('.wp .capl').innerText, s: window.__cfb.scrub() }));
  const before = await cap();
  await touch('touchStart', bx.x + bx.width * .3, bx.y + bx.height * .5);
  await touch('touchMove', bx.x + bx.width * .6, bx.y + bx.height * .5);
  const during = await cap();
  await touch('touchEnd', 0, 0);
  const afterT = await cap();
  ok(during.s.hover != null && during.l !== before.l, 'a finger drag scrubs: ' + during.l);
  ok(afterT.s.pin != null && afterT.s.hover == null, 'lifting the finger leaves the cursor pinned');
  await page.screenshot({ path: path.join(OUT, 'phone-game.png') });
  ok(errors.length === 0, 'no page errors on the phone' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await ctx.close();
}

// 4. baseline: the 1920×1080 default board against the previous index.html, rendered in this same browser
if (PREV && fs.existsSync(PREV)) {
  console.log('baseline vs ' + PREV);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errs = [];
  const cur = await open(ctx, INDEX, '', errs), prev = await open(ctx, PREV, '', errs);
  const a = await cur.screenshot({ path: path.join(OUT, 'baseline-current.png') }), b = await prev.screenshot({ path: path.join(OUT, 'baseline-previous.png') });
  const d = await pixelDiff(b, a, path.join(OUT, 'diff-baseline.png'));
  if (d.n === 0) ok(true, 'board is pixel-identical to the previous version');
  else if (BOARD_CHANGE) ok(true, 'board differs from the previous version (' + d.n + ' px) — allowed, commit is tagged [board-change]');
  else ok(false, 'board differs from the previous version (' + d.n + ' px) and the commit is not tagged [board-change] — see ' + OUT + '/diff-baseline.png');
  await ctx.close();
} else console.log('baseline: skipped (no --prev file)');

await browser.close();
console.log(failures ? '\n' + failures + ' check(s) FAILED' : '\nall checks passed');
process.exit(failures ? 1 : 0);
