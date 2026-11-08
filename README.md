# CFB Scoreboard

A college football scoreboard for a projector and a phone: only the games you pick, big enough to read from the couch,
with a stats page for every game (win probability you can scrub, scoring, drives, box score, standings, highlights).
One self-contained `index.html`, no build step, no keys — scores come from ESPN's public feeds (FBS only).

Live at https://awiley11.github.io/cfb-scoreboard/ · add it to the phone's home screen for the full-screen version.

- **F** fullscreen · **P** picks · **T** ticker · **H** hide/show finals · **R** refresh · **D** demo data · **Esc** close
- Click a tile (or a ticker item) for its stats page; **← →** step between games; on the win-probability chart, hover
  to scrub, click to pin, then **← →** nudge and **Esc** lets go.
- Settings → "Copy settings link" moves favorites and settings to another device.

## Checks

```
npm ci
npx playwright install --with-deps chromium
npm test                         # demo mode, frozen clock, no network
node tests/check.mjs --prev old.html --board-change   # compare the board with an older copy, allowing a change
```

The GitHub Action runs the same checks on every push and compares the 1920×1080 board with the previous commit's,
rendered in the same runner. A commit that changes the board on purpose says `[board-change]` in its message.
