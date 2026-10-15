# 2048 Solver Arena — quick reference

Static web page, no build. `index.html` loads `js/core.js` (engine + bots) then `js/app.js` (UI). Tests: `npm test` (Node `node:test`).

## Key constants

| Name | Value | Where |
|---|---|---|
| Directions | `UP=0, RIGHT=1, DOWN=2, LEFT=3` | core.js Constants |
| 4-tile chance | `FOUR_CHANCE = 0.1` | core.js Constants |
| Loss value (minimax) | `LOSS = -1e9` | core.js Constants |
| Expectimax prob cutoff | `cprob < 0.0001` | core.js `exChance` |
| Expectimax depth limit | `clamp(distinctTiles - 2, 2, maxDepth=8)`, iterative deepening | core.js `chooseExpectimax` |
| Minimax max depth | `8`, iterative deepening | core.js `chooseMinimax` |
| Transposition table | `2^18` slots, cleared per root call | core.js `TT_BITS` |
| Arena speeds (moves/s) | `[1, 2, 4, 8, 15, 30, 60, Max]`, default index 3 | app.js `SPEEDS` |
| Arena think times | 10 / 50 / 200 / 500 ms, default 50 | index.html `#think` |
| Bench think times | 2 / 5 / 10 / 20 ms, default 5 | index.html `#bench-think` |
| Bench seeds | `game * 7919`, same for every algorithm | app.js `runBench` |
| Bench pool | `min(8, hardwareConcurrency - 1)` workers | app.js `runBench` |
| No animation at | ≥ 30 moves/s or reduced motion | app.js `animDuration` |

## Board layout (bitboard)

| Field | Bits |
|---|---|
| `hi` (uint32) | row 0 = bits 31–16, row 1 = bits 15–0 |
| `lo` (uint32) | row 2 = bits 31–16, row 3 = bits 15–0 |
| Cell `c` in a row | nibble at bit `4c` (c=0 is leftmost) |
| Cell index `k` | `row*4 + col`; shift = `(1 - (row & 1))*16 + col*4` |
| Nibble value | rank: 0 empty, 1 = 2, 2 = 4 … 15 = 32768 (rank 15 never merges) |

Hot-path functions return through `outHi / outLo / outScore`. Copy them into locals immediately — the next call (including `heuristic`, which transposes) overwrites them.

## Bots

| id | Function | Evals shown in bars | Uses opts |
|---|---|---|---|
| `random` | `chooseRandom` | 1 per legal move | — |
| `greedy` | `chooseGreedy` | merge points | — |
| `corner` | `chooseCorner` | priority 4..1 (D, L, R, U) | — |
| `montecarlo` | `chooseMonteCarlo` | avg final score of rollouts | `budgetMs`, `rollouts` |
| `minimax` | `chooseMinimax` | worst-case heuristic | `budgetMs`, `maxDepth` |
| `expectimax` | `chooseExpectimax` | expected heuristic | `budgetMs`, `maxDepth` |

Every bot: `(hi, lo, opts, rng) -> { move (-1 if none), evals[4] (null = illegal), depth?, nodes? }`.

## Worker protocol (`handle(msg, post)`)

| In | Out |
|---|---|
| `{type:"ping"}` | `{type:"pong"}` |
| `{type:"think", id, algo, hi, lo, opts, rngSeed}` | `{type:"thought", id, move, evals, depth, nodes, ms}` |
| `{type:"bench", id, algo, seed, opts}` | `{type:"benchResult", id, score, maxTile, moves, ms}` |

Worker source = `"(" + solverCore.toString() + ")()"` as a blob URL. If blob workers fail, `LocalWorker` runs the handler on the main thread.

## Where to find X

| Task | Files, in order |
|---|---|
| Add an algorithm | core.js: new `chooseX` + `BOTS` entry → app.js `ALGOS` (name, unit, copy) → css `--s7` light + both dark blocks → test `ALGOS` list |
| Change game rules | core.js Row tables / Board operations → `slidePlan` (must match `move`) → tests |
| Change tile colors | css `--t1..--t14` (+ dark overrides for `--t1`, `--t2`) |
| Change lane card | app.js `buildLane`, `renderStats`, `renderDecision` → css Lanes / Lane stats |
| Change race chart | app.js `raceGeometry`, `drawRace`, `drawRaceHover` |
| Change benchmark | app.js `runBench`, `renderBench`; buckets in `TILE_BUCKETS`, `REACH` |

## Section index

`Read(file, offset=N, limit=80)`

| core.js | line | app.js | line |
|---|---|---|---|
| Constants | 6 | Algorithm metadata | 4 |
| Row tables | 33 | Small helpers | 78 |
| Board operations | 133 | Workers | 141 |
| Slide plan | 306 | Tabs | 248 |
| Search bookkeeping | 362 | Arena state | 290 |
| Bot: Random | 405 | Lane DOM | 336 |
| Bot: Greedy | 421 | Lane game loop | 582 |
| Bot: Corner | 432 | Score race chart | 789 |
| Bot: Monte Carlo | 450 | Arena controls | 1012 |
| Bot: Minimax | 513 | Benchmark | 1132 |
| Bot: Expectimax | 619 | Algorithms view | 1427 |
| Bot registry and games | 740 | Boot | 1454 |
| Public API | 789 | | |

style.css: Masthead 137, Toolbar 192, Lanes 269, Board 309, Lane stats 396, Panels and charts 438, Benchmark 494, Algorithms view 522.

## Conventions

- Always braces; no `var`; no `?:` ternaries.
- All colors are tokens on `:root`, redefined in both dark blocks (media query + `[data-theme="dark"]`).
- Series colors `--s1..--s6` follow `ALGOS` order; never re-assign by rank.

## Session Cost Log

| Date | Task | Mode | Tokens (est.) | Notes |
|------|------|------|:-------------:|-------|
| 2026-10-15 | Read 2022 C# repo, plan | inline | ~15K | One-time |
| 2026-10-15 | Engine, six bots, tests | inline | ~35K | |
| 2026-10-15 | Web UI (html/css/app.js) | inline | ~45K | |
| 2026-10-15 | Headless browser checks + fixes | inline | ~12K | puppeteer-core in scratchpad |
| 2026-10-15 | Perf fix: container queries → `--bw` var, rAF redraw | inline | ~15K | cqi units made layout ~7x slower |
