(function () {
    "use strict";

    // ===== Algorithm metadata ================================================
    const ALGOS = [
        {
            id: "random",
            name: "Random",
            legacy: true,
            kind: "No lookahead",
            unit: "Legal moves",
            blurb: "Swipes in a random direction from the moves that change the board.",
            how: "The original StupidBot. It looks at nothing, so its result depends only on luck.",
            watch: "Big tiles end up anywhere on the board. Games end early, usually below 256."
        },
        {
            id: "greedy",
            name: "Greedy",
            legacy: true,
            kind: "1 move, no spawns",
            unit: "Merge points",
            blurb: "Takes the move that scores the most points right now. Ties go to a random move.",
            how: "The original ehBot. It sees only the points from the current move and ignores where the new tile can appear.",
            watch: "It merges small tiles eagerly and scatters large tiles. A large lead in early moves does not last."
        },
        {
            id: "corner",
            name: "Corner",
            legacy: false,
            kind: "Fixed priority",
            unit: "Priority",
            blurb: "The common human method. Swipes down when it can, then left, then right, and up only when no other move works.",
            how: "This keeps the largest tiles in the bottom-left corner most of the time. It does not search.",
            watch: "A forced up move pulls the big tile out of the corner, and the board falls apart quickly after that."
        },
        {
            id: "montecarlo",
            name: "Monte Carlo",
            legacy: false,
            kind: "Random rollouts",
            unit: "Avg rollout score",
            blurb: "For each legal move, plays many games to the end with random moves and keeps the average final score.",
            how: "It has no knowledge of 2048 strategy. Good moves are the ones where random play survives longer. More think time gives more rollouts and better averages.",
            watch: "It often finds a good position by itself, but it can make strange moves when the averages are close."
        },
        {
            id: "minimax",
            name: "Minimax",
            legacy: false,
            kind: "Alpha-beta search",
            unit: "Worst-case value",
            blurb: "Assumes the new tile always appears in the worst cell, and finds the move with the best worst case.",
            how: "Alpha-beta pruning with iterative deepening: it searches one more move deep at a time until the think time runs out. Leaf boards use the same heuristic as Expectimax.",
            watch: "The real game places tiles at random, not as an enemy. Minimax is too careful, and it avoids moves that are almost always safe."
        },
        {
            id: "expectimax",
            name: "Expectimax",
            legacy: false,
            kind: "Probability search",
            unit: "Expected value",
            blurb: "Averages over every cell where the new tile can appear, with 90% weight for a 2 and 10% for a 4.",
            how: "It cuts branches with less than 0.01% probability and stores positions it has already scored. Leaf boards get points for empty cells, possible merges, rows and columns that increase in one direction, and penalties for large tiles that are spread out.",
            watch: "The largest tile stays in a corner with a chain of smaller tiles next to it. It usually reaches 4096 or 8192."
        }
    ];
    const ALGO_BY_ID = {};
    ALGOS.forEach(function (a, i) {
        a.series = "var(--s" + (i + 1) + ")";
        ALGO_BY_ID[a.id] = a;
    });

    const ARROWS = ["↑", "→", "↓", "←"];
    const DIR_NAMES = ["up", "right", "down", "left"];
    const SPEEDS = [1, 2, 4, 8, 15, 30, 60, Infinity];
    const core = solverCore();

    // ===== Small helpers =====================================================
    function $(id) {
        return document.getElementById(id);
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }

    function fmt(n) {
        return Math.round(n).toLocaleString("en-US");
    }

    function compact(n) {
        const abs = Math.abs(n);
        if (abs >= 1e9) {
            return (n / 1e9).toFixed(1) + "B";
        }
        if (abs >= 1e6) {
            return (n / 1e6).toFixed(2) + "M";
        }
        if (abs >= 1e4) {
            return (n / 1e3).toFixed(1) + "k";
        }
        if (abs >= 100 || Number.isInteger(n)) {
            return String(Math.round(n));
        }
        return n.toFixed(1);
    }

    function storeGet(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function storeSet(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (e) {
            // Storage is optional.
        }
    }

    function reducedMotion() {
        return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    // ===== Workers ===========================================================
    // Each board thinks in its own worker so a slow search never blocks the
    // page. If the browser refuses blob workers, a main-thread stand-in runs
    // the same handler.
    let workerUrl = null;
    let useLocal = false;
    let localCore = null;

    function getWorkerUrl() {
        if (workerUrl === null) {
            const src = "(" + solverCore.toString() + ")();";
            workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        }
        return workerUrl;
    }

    function LocalWorker() {
        if (localCore === null) {
            localCore = solverCore();
        }
        this.onmessage = null;
        this.dead = false;
    }
    LocalWorker.prototype.postMessage = function (msg) {
        const self = this;
        setTimeout(function () {
            if (self.dead) {
                return;
            }
            localCore.handle(msg, function (out) {
                if (self.onmessage && !self.dead) {
                    self.onmessage({ data: out });
                }
            });
        }, 0);
    };
    LocalWorker.prototype.terminate = function () {
        this.dead = true;
    };

    function rawWorker() {
        if (!useLocal) {
            try {
                return new Worker(getWorkerUrl());
            } catch (e) {
                useLocal = true;
            }
        }
        return new LocalWorker();
    }

    function probeWorkers() {
        return new Promise(function (resolve) {
            let w = null;
            try {
                w = new Worker(getWorkerUrl());
            } catch (e) {
                useLocal = true;
                resolve();
                return;
            }
            const timer = setTimeout(function () {
                useLocal = true;
                w.terminate();
                resolve();
            }, 4000);
            w.onmessage = function () {
                clearTimeout(timer);
                w.terminate();
                resolve();
            };
            w.onerror = function () {
                clearTimeout(timer);
                useLocal = true;
                resolve();
            };
            w.postMessage({ type: "ping" });
        });
    }

    function Agent() {
        const self = this;
        this.worker = rawWorker();
        this.pending = new Map();
        this.nextId = 1;
        this.worker.onmessage = function (e) {
            const resolve = self.pending.get(e.data.id);
            if (resolve) {
                self.pending.delete(e.data.id);
                resolve(e.data);
            }
        };
    }
    Agent.prototype.call = function (msg) {
        const self = this;
        const id = this.nextId++;
        msg.id = id;
        return new Promise(function (resolve) {
            self.pending.set(id, resolve);
            self.worker.postMessage(msg);
        });
    };
    Agent.prototype.terminate = function () {
        this.worker.terminate();
        this.pending.clear();
    };

    // ===== Tabs ==============================================================
    const VIEWS = ["arena", "benchmark", "algorithms"];

    function showView(name) {
        let view = name;
        if (VIEWS.indexOf(view) < 0) {
            view = "arena";
        }
        VIEWS.forEach(function (v) {
            const active = v === view;
            $("view-" + v).hidden = !active;
            $("tab-" + v).setAttribute("aria-selected", String(active));
            if (active) {
                $("tab-" + v).tabIndex = 0;
            } else {
                $("tab-" + v).tabIndex = -1;
            }
        });
        if (view === "arena") {
            drawRace();
        }
        if (view === "benchmark") {
            renderBench();
        }
    }

    function initTabs() {
        document.querySelectorAll(".tab").forEach(function (tab) {
            tab.addEventListener("click", function () {
                const v = tab.dataset.view;
                if (location.hash !== "#" + v) {
                    history.replaceState(null, "", "#" + v);
                }
                showView(v);
            });
        });
        window.addEventListener("hashchange", function () {
            showView(location.hash.slice(1));
        });
        showView(location.hash.slice(1));
    }

    // ===== Arena state =======================================================
    const arena = {
        running: true,
        speedIndex: 3,
        thinkMs: 50,
        seed: 1,
        generation: 0,
        lanes: [],
        selected: ["random", "greedy", "corner", "montecarlo", "minimax", "expectimax"],
        resumeWaiters: []
    };

    function interval() {
        const mps = SPEEDS[arena.speedIndex];
        if (mps === Infinity) {
            return 0;
        }
        return 1000 / mps;
    }

    function animDuration() {
        const mps = SPEEDS[arena.speedIndex];
        if (mps >= 30 || reducedMotion()) {
            return 0;
        }
        return Math.min(130, interval() * 0.6);
    }

    function waitForResume() {
        return new Promise(function (resolve) {
            arena.resumeWaiters.push(resolve);
        });
    }

    function releaseWaiters() {
        const waiters = arena.resumeWaiters;
        arena.resumeWaiters = [];
        waiters.forEach(function (fn) {
            fn();
        });
    }

    function randomSeed() {
        return 1 + Math.floor(Math.random() * 999999);
    }

    // ===== Lane DOM ==========================================================
    function buildLane(algo, index) {
        const card = el("article", "lane");
        card.style.setProperty("--series", algo.series);

        const head = el("div", "lane-head");
        head.appendChild(el("span", "dot"));
        head.appendChild(el("h3", "lane-name", algo.name));
        if (algo.legacy) {
            head.appendChild(el("span", "badge", "2022"));
        }
        const status = el("span", "status", "Ready");
        head.appendChild(status);
        card.appendChild(head);

        const board = el("div", "board");
        const bg = el("div", "grid-bg");
        for (let k = 0; k < 16; k++) {
            bg.appendChild(el("div"));
        }
        board.appendChild(bg);
        const tiles = el("div", "tiles");
        board.appendChild(tiles);
        const over = el("div", "board-over");
        over.hidden = true;
        const overTitle = el("strong", "", "Game over");
        const overText = el("span", "");
        over.appendChild(overTitle);
        over.appendChild(overText);
        board.appendChild(over);
        card.appendChild(board);

        const stats = el("dl", "stats");
        const statEls = {};
        [["score", "Score"], ["best", "Best tile"], ["moves", "Moves"], ["think", "Think"]].forEach(function (pair) {
            const wrap = el("div");
            wrap.appendChild(el("dt", "", pair[1]));
            const dd = el("dd", "", "0");
            wrap.appendChild(dd);
            stats.appendChild(wrap);
            statEls[pair[0]] = dd;
        });
        card.appendChild(stats);

        const decide = el("div", "decide");
        const dh = el("div", "decide-head");
        const depth = el("span", "", "Last decision");
        dh.appendChild(depth);
        dh.appendChild(el("span", "unit", algo.unit));
        decide.appendChild(dh);
        const rows = [];
        for (let d = 0; d < 4; d++) {
            const row = el("div", "bar-row illegal");
            row.title = "Swipe " + DIR_NAMES[d];
            row.appendChild(el("span", "arrow", ARROWS[d]));
            const track = el("div", "bar-track");
            const fill = el("div", "bar-fill");
            track.appendChild(fill);
            row.appendChild(track);
            const val = el("span", "val", "–");
            row.appendChild(val);
            decide.appendChild(row);
            rows.push({ row: row, fill: fill, val: val });
        }
        card.appendChild(decide);

        return {
            algo: algo,
            index: index,
            card: card,
            status: status,
            board: board,
            tiles: tiles,
            over: over,
            overText: overText,
            stats: statEls,
            depth: depth,
            rows: rows
        };
    }

    function tileElement(rank, k) {
        const t = el("div", "tile r" + Math.min(rank, 14));
        const digits = String(2 ** rank).length;
        if (digits >= 3) {
            t.classList.add("d" + Math.min(digits, 5));
        }
        t.style.setProperty("--x", String(k & 3));
        t.style.setProperty("--y", String(k >> 2));
        t.appendChild(el("span", "", String(2 ** rank)));
        return t;
    }

    function renderTiles(lane, spawnIndex, merged) {
        const cells = core.toCells(lane.hi, lane.lo);
        const frag = document.createDocumentFragment();
        lane.tileEls = [];
        for (let k = 0; k < 16; k++) {
            lane.tileEls.push(null);
            if (cells[k] === 0) {
                continue;
            }
            const t = tileElement(cells[k], k);
            if (k === spawnIndex) {
                t.classList.add("spawn");
            }
            if (merged && merged.has(k)) {
                t.classList.add("merged");
            }
            frag.appendChild(t);
            lane.tileEls[k] = t;
        }
        lane.view.tiles.replaceChildren(frag);
        lane.renderedHi = lane.hi;
        lane.renderedLo = lane.lo;
    }

    // Without animation, boards only mark themselves dirty and redraw once per
    // frame. Redrawing after every move made layout eat the main thread.
    let flushQueued = false;

    function markDirty(lane) {
        lane.dirty = true;
        if (flushQueued) {
            return;
        }
        flushQueued = true;
        requestAnimationFrame(function () {
            flushQueued = false;
            arena.lanes.forEach(function (l) {
                if (l.dirty) {
                    l.dirty = false;
                    renderTiles(l, -1, null);
                    renderStats(l);
                    renderDecision(l);
                }
            });
        });
    }

    async function animateMove(lane, beforeHi, beforeLo, dir, spawnIndex, dur) {
        if (dur <= 0) {
            markDirty(lane);
            return;
        }
        if (lane.renderedHi !== beforeHi || lane.renderedLo !== beforeLo) {
            const hi = lane.hi;
            const lo = lane.lo;
            lane.hi = beforeHi;
            lane.lo = beforeLo;
            renderTiles(lane, -1, null);
            lane.hi = hi;
            lane.lo = lo;
        }
        const plan = core.slidePlan(core.toCells(beforeHi, beforeLo), dir);
        const merged = new Set();
        lane.view.board.style.setProperty("--dur", Math.round(dur) + "ms");
        // Force a style flush so the new duration applies to this transition.
        void lane.view.board.offsetWidth;
        plan.moves.forEach(function (m) {
            const t = lane.tileEls[m.from];
            if (!t) {
                return;
            }
            t.style.setProperty("--x", String(m.to & 3));
            t.style.setProperty("--y", String(m.to >> 2));
            if (m.merged) {
                merged.add(m.to);
            }
        });
        await sleep(dur);
        renderTiles(lane, spawnIndex, merged);
    }

    function setStatus(lane, state, text) {
        lane.view.status.dataset.state = state;
        lane.view.status.textContent = text;
    }

    function renderStats(lane) {
        const v = lane.view;
        v.stats.score.textContent = fmt(lane.score);
        v.stats.best.textContent = String(2 ** core.maxRank(lane.hi, lane.lo));
        v.stats.moves.textContent = fmt(lane.moves);
        if (lane.thinkCount === 0) {
            v.stats.think.textContent = "–";
        } else {
            const avg = lane.thinkTotal / lane.thinkCount;
            if (avg >= 10) {
                v.stats.think.textContent = Math.round(avg) + "ms";
            } else {
                v.stats.think.textContent = avg.toFixed(1) + "ms";
            }
        }
        if (lane.lastDepth > 0) {
            v.depth.textContent = "Last decision · depth " + lane.lastDepth;
        } else {
            v.depth.textContent = "Last decision";
        }
        v.over.hidden = !lane.over;
        if (lane.over) {
            v.overText.textContent = fmt(lane.score) + " points · " + fmt(lane.moves) + " moves";
        }
    }

    function renderDecision(lane) {
        const evals = lane.lastEvals;
        const rows = lane.view.rows;
        if (!evals) {
            rows.forEach(function (r) {
                r.row.className = "bar-row illegal";
                r.val.textContent = "–";
                r.fill.style.width = "0";
            });
            return;
        }
        let lo = Infinity;
        let hi = -Infinity;
        evals.forEach(function (v) {
            if (v !== null) {
                lo = Math.min(lo, v);
                hi = Math.max(hi, v);
            }
        });
        for (let d = 0; d < 4; d++) {
            const r = rows[d];
            const v = evals[d];
            if (v === null) {
                r.row.className = "bar-row illegal";
                r.val.textContent = "–";
                continue;
            }
            let share = 1;
            if (hi > lo) {
                share = (v - lo) / (hi - lo);
            }
            r.fill.style.width = (12 + 88 * share).toFixed(1) + "%";
            r.val.textContent = compact(v);
            if (d === lane.lastMove) {
                r.row.className = "bar-row chosen";
            } else {
                r.row.className = "bar-row";
            }
        }
    }

    // ===== Lane game loop ====================================================
    function resetLane(lane) {
        lane.rng = core.mulberry32(arena.seed);
        const g = core.newGame(lane.rng);
        lane.hi = g.hi;
        lane.lo = g.lo;
        lane.score = 0;
        lane.moves = 0;
        lane.over = false;
        lane.thinkTotal = 0;
        lane.thinkCount = 0;
        lane.lastDepth = 0;
        lane.lastEvals = null;
        lane.lastMove = -1;
        lane.history = [0];
        lane.busy = false;
        lane.gen = arena.generation;
        renderTiles(lane, -1, null);
        renderStats(lane);
        renderDecision(lane);
        setStatus(lane, "idle", runLabel());
    }

    function runLabel() {
        if (arena.running) {
            return "Playing";
        }
        return "Paused";
    }

    async function stepLane(lane) {
        if (lane.over || lane.busy) {
            return;
        }
        const gen = lane.gen;
        lane.busy = true;
        const slowTimer = setTimeout(function () {
            if (lane.busy && lane.gen === gen) {
                setStatus(lane, "thinking", "Thinking");
            }
        }, 150);
        const res = await lane.agent.call({
            type: "think",
            algo: lane.algo.id,
            hi: lane.hi,
            lo: lane.lo,
            opts: { budgetMs: arena.thinkMs },
            rngSeed: arena.seed * 7 + lane.index + 1
        });
        clearTimeout(slowTimer);
        if (lane.gen !== gen || lane.dead) {
            return;
        }
        if (res.move < 0) {
            lane.over = true;
            lane.busy = false;
            renderStats(lane);
            setStatus(lane, "over", "Game over");
            return;
        }
        const beforeHi = lane.hi;
        const beforeLo = lane.lo;
        const moved = core.applyMove(beforeHi, beforeLo, res.move);
        const spawned = core.spawn(moved.hi, moved.lo, lane.rng);
        lane.hi = spawned.hi;
        lane.lo = spawned.lo;
        lane.score += moved.score;
        lane.moves++;
        lane.history.push(lane.score);
        lane.thinkTotal += res.ms;
        lane.thinkCount++;
        lane.lastDepth = res.depth;
        lane.lastEvals = res.evals;
        lane.lastMove = res.move;
        lane.over = !core.hasMove(lane.hi, lane.lo);
        if (lane.over) {
            setStatus(lane, "over", "Game over");
        } else {
            setStatus(lane, "idle", runLabel());
        }
        const dur = animDuration();
        await animateMove(lane, beforeHi, beforeLo, res.move, spawned.index, dur);
        if (lane.gen !== gen) {
            return;
        }
        if (dur > 0) {
            renderStats(lane);
            renderDecision(lane);
        }
        lane.busy = false;
        scheduleRace();
    }

    async function laneLoop(lane) {
        const gen = lane.gen;
        while (lane.gen === gen && !lane.dead && !lane.over) {
            if (!arena.running) {
                await waitForResume();
                continue;
            }
            const t0 = performance.now();
            await stepLane(lane);
            const wait = interval() - (performance.now() - t0);
            if (wait > 1) {
                await sleep(wait);
            }
        }
    }

    function createLane(algoId) {
        const algo = ALGO_BY_ID[algoId];
        const lane = {
            algo: algo,
            index: ALGOS.indexOf(algo),
            agent: new Agent(),
            view: buildLane(algo, ALGOS.indexOf(algo)),
            dead: false
        };
        resetLane(lane);
        return lane;
    }

    function syncLanes() {
        const keep = [];
        arena.lanes.forEach(function (lane) {
            if (arena.selected.indexOf(lane.algo.id) < 0) {
                lane.dead = true;
                lane.gen = -1;
                lane.agent.terminate();
                lane.view.card.remove();
            } else {
                keep.push(lane);
            }
        });
        arena.lanes = keep;
        ALGOS.forEach(function (algo) {
            if (arena.selected.indexOf(algo.id) >= 0 && !arena.lanes.some(function (l) { return l.algo === algo; })) {
                const lane = createLane(algo.id);
                arena.lanes.push(lane);
                laneLoop(lane);
            }
        });
        arena.lanes.sort(function (a, b) {
            return a.index - b.index;
        });
        const container = $("lanes");
        arena.lanes.forEach(function (lane) {
            container.appendChild(lane.view.card);
        });
        updateBoardWidth();
        renderRaceLegend();
        scheduleRace();
    }

    // Tile text and gaps scale with the board through --bw. Container query
    // units did the same but made every frame's layout about 7x slower.
    function updateBoardWidth() {
        const board = $("lanes").querySelector(".board");
        if (board && board.clientWidth > 0) {
            $("lanes").style.setProperty("--bw", board.clientWidth + "px");
        }
    }

    function initBoardSizing() {
        if (window.ResizeObserver) {
            new ResizeObserver(updateBoardWidth).observe($("lanes"));
        } else {
            window.addEventListener("resize", updateBoardWidth);
        }
    }

    function newGame(seed) {
        arena.generation++;
        arena.seed = seed;
        $("seed").value = String(seed);
        arena.lanes.forEach(function (lane) {
            // A worker still busy with the old board would answer late, so
            // give each lane a fresh one.
            lane.agent.terminate();
            lane.agent = new Agent();
            resetLane(lane);
            laneLoop(lane);
        });
        scheduleRace();
    }

    function setRunning(running) {
        arena.running = running;
        const btn = $("btn-play");
        if (running) {
            btn.dataset.state = "playing";
            btn.querySelector(".lbl").textContent = "Pause";
        } else {
            btn.dataset.state = "paused";
            btn.querySelector(".lbl").textContent = "Play";
        }
        $("btn-step").disabled = running;
        arena.lanes.forEach(function (lane) {
            if (!lane.over && !lane.busy) {
                setStatus(lane, "idle", runLabel());
            }
        });
        if (running) {
            releaseWaiters();
        }
    }

    // ===== Score race chart ==================================================
    const SVG_NS = "http://www.w3.org/2000/svg";
    let raceTimer = null;
    let raceHoverMove = null;

    function svg(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(function (k) {
            node.setAttribute(k, String(attrs[k]));
        });
        return node;
    }

    // Picks a round tick step (1, 2 or 5 times a power of ten) so that about
    // four ticks cover v, and returns the axis end and step.
    function niceScale(v, minStep) {
        const raw = Math.max(v, minStep * 4) / 4;
        const exp = Math.pow(10, Math.floor(Math.log10(raw)));
        let step = 10 * exp;
        const mults = [1, 2, 5];
        for (let i = mults.length - 1; i >= 0; i--) {
            if (mults[i] * exp >= raw) {
                step = mults[i] * exp;
            }
        }
        step = Math.max(step, minStep);
        return { max: Math.ceil(Math.max(v, 1) / step) * step, step: step };
    }

    function scheduleRace() {
        if (raceTimer !== null) {
            return;
        }
        raceTimer = setTimeout(function () {
            raceTimer = null;
            drawRace();
        }, 250);
    }

    function renderRaceLegend() {
        const legend = $("race-legend");
        legend.replaceChildren();
        arena.lanes.forEach(function (lane) {
            const item = el("span");
            item.style.setProperty("--series", lane.algo.series);
            item.appendChild(el("i"));
            item.appendChild(document.createTextNode(lane.algo.name));
            legend.appendChild(item);
        });
    }

    function raceGeometry() {
        const wrap = $("race-wrap");
        const width = Math.max(280, wrap.clientWidth);
        const height = 240;
        const m = { left: 58, right: 14, top: 10, bottom: 28 };
        let maxMoves = 10;
        let maxScore = 0;
        arena.lanes.forEach(function (lane) {
            maxMoves = Math.max(maxMoves, lane.history.length - 1);
            maxScore = Math.max(maxScore, lane.history[lane.history.length - 1]);
        });
        const ys = niceScale(maxScore, 25);
        const xs = niceScale(maxMoves, 5);
        const yMax = ys.max;
        const xMax = xs.max;
        return {
            width: width,
            height: height,
            m: m,
            xMax: xMax,
            yMax: yMax,
            xStep: xs.step,
            yStep: ys.step,
            x: function (i) {
                return m.left + (i / xMax) * (width - m.left - m.right);
            },
            y: function (v) {
                return height - m.bottom - (v / yMax) * (height - m.top - m.bottom);
            }
        };
    }

    function drawRace() {
        const svgEl = $("race");
        if ($("view-arena").hidden) {
            return;
        }
        const g = raceGeometry();
        svgEl.setAttribute("viewBox", "0 0 " + g.width + " " + g.height);
        svgEl.style.height = g.height + "px";
        svgEl.replaceChildren();

        const grid = svg("g", { class: "grid" });
        const axis = svg("g", { class: "axis" });
        for (let v = 0; v <= g.yMax; v += g.yStep) {
            const y = g.y(v);
            if (v > 0) {
                grid.appendChild(svg("line", { x1: g.m.left, x2: g.width - g.m.right, y1: y, y2: y }));
            }
            const t = svg("text", { x: g.m.left - 8, y: y + 4, "text-anchor": "end" });
            t.textContent = compact(v);
            axis.appendChild(t);
        }
        for (let v = 0; v <= g.xMax; v += g.xStep) {
            const t = svg("text", { x: g.x(v), y: g.height - 8, "text-anchor": "middle" });
            if (v === 0) {
                t.setAttribute("text-anchor", "start");
            }
            if (v === g.xMax) {
                t.setAttribute("text-anchor", "end");
                t.textContent = compact(v) + " moves";
            } else {
                t.textContent = compact(v);
            }
            axis.appendChild(t);
        }
        svgEl.appendChild(grid);
        svgEl.appendChild(svg("line", { class: "baseline", x1: g.m.left, x2: g.width - g.m.right, y1: g.y(0), y2: g.y(0) }));
        svgEl.appendChild(axis);

        const plotWidth = g.width - g.m.left - g.m.right;
        arena.lanes.forEach(function (lane) {
            const h = lane.history;
            const n = h.length;
            const step = Math.max(1, Math.floor(n / plotWidth));
            let d = "M" + g.x(0).toFixed(1) + "," + g.y(h[0]).toFixed(1);
            for (let i = step; i < n; i += step) {
                d += "L" + g.x(i).toFixed(1) + "," + g.y(h[i]).toFixed(1);
            }
            d += "L" + g.x(n - 1).toFixed(1) + "," + g.y(h[n - 1]).toFixed(1);
            svgEl.appendChild(svg("path", { class: "series-line", d: d, stroke: "var(--s" + (lane.index + 1) + ")" }));
        });
        arena.lanes.forEach(function (lane) {
            const n = lane.history.length;
            svgEl.appendChild(svg("circle", {
                class: "endpoint",
                cx: g.x(n - 1),
                cy: g.y(lane.history[n - 1]),
                r: 4.5,
                fill: "var(--s" + (lane.index + 1) + ")"
            }));
        });
        if (raceHoverMove !== null) {
            drawRaceHover(svgEl, g);
        }
    }

    function drawRaceHover(svgEl, g) {
        const m = Math.min(raceHoverMove, g.xMax);
        const x = g.x(m);
        svgEl.appendChild(svg("line", { class: "crosshair", x1: x, x2: x, y1: g.m.top, y2: g.height - g.m.bottom }));
        const rows = [];
        arena.lanes.forEach(function (lane) {
            const last = lane.history.length - 1;
            const idx = Math.min(m, last);
            const v = lane.history[idx];
            rows.push({ lane: lane, value: v, ended: m > last });
            svgEl.appendChild(svg("circle", {
                class: "endpoint",
                cx: g.x(idx),
                cy: g.y(v),
                r: 4,
                fill: "var(--s" + (lane.index + 1) + ")"
            }));
        });
        rows.sort(function (a, b) {
            return b.value - a.value;
        });
        const tip = $("race-tip");
        tip.replaceChildren();
        tip.appendChild(el("div", "tt-title", "Move " + fmt(m)));
        rows.forEach(function (r) {
            const row = el("div", "tt-row");
            if (r.ended) {
                row.classList.add("dim");
            }
            row.style.setProperty("--series", r.lane.algo.series);
            row.appendChild(el("i"));
            let name = r.lane.algo.name;
            if (r.ended) {
                name += " (ended)";
            }
            row.appendChild(el("span", "", name));
            row.appendChild(el("b", "", fmt(r.value)));
            tip.appendChild(row);
        });
        tip.hidden = false;
        const wrapW = $("race-wrap").clientWidth;
        const scale = wrapW / g.width;
        let left = x * scale + 14;
        if (left + tip.offsetWidth > wrapW) {
            left = x * scale - tip.offsetWidth - 14;
        }
        tip.style.left = Math.max(0, left) + "px";
        tip.style.top = "8px";
    }

    function initRaceHover() {
        const svgEl = $("race");
        function update(clientX) {
            const g = raceGeometry();
            const rect = svgEl.getBoundingClientRect();
            const px = ((clientX - rect.left) / rect.width) * g.width;
            const m = Math.round(((px - g.m.left) / (g.width - g.m.left - g.m.right)) * g.xMax);
            raceHoverMove = Math.max(0, m);
            drawRace();
        }
        svgEl.addEventListener("pointermove", function (e) {
            update(e.clientX);
        });
        svgEl.addEventListener("pointerleave", function () {
            raceHoverMove = null;
            $("race-tip").hidden = true;
            drawRace();
        });
        if (window.ResizeObserver) {
            new ResizeObserver(function () {
                scheduleRace();
            }).observe($("race-wrap"));
        }
    }

    // ===== Arena controls ====================================================
    function buildChips(container, selected, onToggle) {
        container.replaceChildren();
        ALGOS.forEach(function (algo) {
            const chip = el("button", "chip");
            chip.type = "button";
            chip.style.setProperty("--series", algo.series);
            chip.setAttribute("aria-pressed", String(selected.indexOf(algo.id) >= 0));
            chip.appendChild(el("span", "dot"));
            chip.appendChild(document.createTextNode(algo.name));
            if (algo.legacy) {
                chip.appendChild(el("span", "badge", "2022"));
            }
            chip.addEventListener("click", function () {
                onToggle(algo.id, chip);
            });
            container.appendChild(chip);
        });
    }

    function speedLabel(i) {
        const s = SPEEDS[i];
        if (s === Infinity) {
            return "Max";
        }
        return s + " moves/s";
    }

    function initArenaControls() {
        $("btn-play").addEventListener("click", function () {
            setRunning(!arena.running);
        });
        $("btn-step").addEventListener("click", function () {
            arena.lanes.forEach(function (lane) {
                stepLane(lane);
            });
        });
        $("btn-new").addEventListener("click", function () {
            newGame(randomSeed());
        });
        const speed = $("speed");
        speed.value = String(arena.speedIndex);
        $("speed-out").textContent = speedLabel(arena.speedIndex);
        speed.addEventListener("input", function () {
            arena.speedIndex = Number(speed.value);
            $("speed-out").textContent = speedLabel(arena.speedIndex);
            storeSet("arena.speed", speed.value);
        });
        const think = $("think");
        think.value = String(arena.thinkMs);
        think.addEventListener("change", function () {
            arena.thinkMs = Number(think.value);
            storeSet("arena.think", think.value);
        });
        const seed = $("seed");
        seed.addEventListener("change", function () {
            const v = Math.floor(Number(seed.value));
            if (v >= 1 && v <= 999999) {
                newGame(v);
            } else {
                seed.value = String(arena.seed);
            }
        });
        buildChips($("algo-chips"), arena.selected, function (id, chip) {
            const i = arena.selected.indexOf(id);
            if (i >= 0) {
                if (arena.selected.length === 1) {
                    return;
                }
                arena.selected.splice(i, 1);
            } else {
                arena.selected.push(id);
            }
            chip.setAttribute("aria-pressed", String(arena.selected.indexOf(id) >= 0));
            storeSet("arena.selected", arena.selected.join(","));
            syncLanes();
        });
        document.addEventListener("keydown", function (e) {
            const tag = (e.target && e.target.tagName) || "";
            if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) {
                return;
            }
            if ($("view-arena").hidden) {
                return;
            }
            if (e.key === " " && tag !== "BUTTON") {
                e.preventDefault();
                setRunning(!arena.running);
            } else if (e.key === "s" || e.key === "S") {
                if (!arena.running) {
                    arena.lanes.forEach(function (lane) {
                        stepLane(lane);
                    });
                }
            } else if (e.key === "n" || e.key === "N") {
                newGame(randomSeed());
            }
        });
    }

    function restorePrefs() {
        const speed = Number(storeGet("arena.speed"));
        if (storeGet("arena.speed") !== null && speed >= 0 && speed < SPEEDS.length) {
            arena.speedIndex = speed;
        }
        const think = storeGet("arena.think");
        if (think !== null && ["10", "50", "200", "500"].indexOf(think) >= 0) {
            arena.thinkMs = Number(think);
        }
        const sel = storeGet("arena.selected");
        if (sel) {
            const ids = sel.split(",").filter(function (id) {
                return ALGO_BY_ID[id];
            });
            if (ids.length > 0) {
                arena.selected = ids;
            }
        }
    }

    // ===== Benchmark =========================================================
    const TILE_BUCKETS = [
        { label: "128 or less", min: 0 },
        { label: "256", min: 256 },
        { label: "512", min: 512 },
        { label: "1024", min: 1024 },
        { label: "2048", min: 2048 },
        { label: "4096", min: 4096 },
        { label: "8192+", min: 8192 }
    ];
    const REACH = [512, 1024, 2048, 4096, 8192];

    const bench = {
        running: false,
        agents: [],
        selected: ALGOS.map(function (a) { return a.id; }),
        algos: [],
        planned: 0,
        results: {},
        startedAt: 0,
        runId: 0
    };

    function bucketOf(tile) {
        let idx = 0;
        TILE_BUCKETS.forEach(function (b, i) {
            if (tile >= b.min) {
                idx = i;
            }
        });
        return idx;
    }

    function median(values) {
        const s = values.slice().sort(function (a, b) {
            return a - b;
        });
        const mid = Math.floor(s.length / 2);
        if (s.length % 2 === 1) {
            return s[mid];
        }
        return (s[mid - 1] + s[mid]) / 2;
    }

    function renderBenchLegend() {
        const legend = $("dist-legend");
        if (legend.childElementCount > 0) {
            return;
        }
        TILE_BUCKETS.forEach(function (b, i) {
            const item = el("span");
            item.style.setProperty("--series", "var(--q" + (i + 1) + ")");
            item.appendChild(el("i", "sq"));
            item.appendChild(document.createTextNode(b.label));
            legend.appendChild(item);
        });
    }

    function renderBench() {
        renderBenchLegend();
        const dist = $("dist");
        const tbody = $("bench-table").querySelector("tbody");
        dist.replaceChildren();
        tbody.replaceChildren();
        if (bench.algos.length === 0) {
            dist.appendChild(el("div", "dist-placeholder", "Pick the algorithms and press Run benchmark. Each one plays the same seeded games in background workers."));
            const tr = el("tr");
            const td = el("td", "muted", "No results yet.");
            td.colSpan = 12;
            tr.appendChild(td);
            tbody.appendChild(tr);
            return;
        }
        bench.algos.forEach(function (id) {
            const algo = ALGO_BY_ID[id];
            const rs = bench.results[id];
            const row = el("div", "dist-row");
            row.style.setProperty("--series", algo.series);
            const name = el("div", "dist-name");
            name.appendChild(el("i", "dot"));
            name.appendChild(el("span", "", algo.name));
            row.appendChild(name);
            if (rs.length === 0) {
                row.appendChild(el("div", "dist-empty"));
            } else {
                const bar = el("div", "dist-bar");
                const counts = TILE_BUCKETS.map(function () { return 0; });
                rs.forEach(function (r) {
                    counts[bucketOf(r.maxTile)]++;
                });
                counts.forEach(function (c, i) {
                    if (c === 0) {
                        return;
                    }
                    const seg = el("div", "dist-seg");
                    seg.style.flex = String(c);
                    seg.style.background = "var(--q" + (i + 1) + ")";
                    seg.dataset.tip = algo.name + "|" + TILE_BUCKETS[i].label + "|" + c + "|" + rs.length;
                    bar.appendChild(seg);
                });
                row.appendChild(bar);
            }
            dist.appendChild(row);

            const tr = el("tr");
            tr.style.setProperty("--series", algo.series);
            const nameTd = el("td");
            const cell = el("span", "algo-cell");
            cell.appendChild(el("i"));
            cell.appendChild(document.createTextNode(algo.name));
            nameTd.appendChild(cell);
            tr.appendChild(nameTd);
            tr.appendChild(el("td", "num", rs.length + " / " + bench.planned));
            if (rs.length === 0) {
                for (let i = 0; i < 10; i++) {
                    tr.appendChild(el("td", "num muted", "–"));
                }
            } else {
                const scores = rs.map(function (r) { return r.score; });
                const totalMoves = rs.reduce(function (s, r) { return s + r.moves; }, 0);
                const totalMs = rs.reduce(function (s, r) { return s + r.ms; }, 0);
                tr.appendChild(el("td", "num", fmt(scores.reduce(function (s, v) { return s + v; }, 0) / rs.length)));
                tr.appendChild(el("td", "num", fmt(median(scores))));
                tr.appendChild(el("td", "num", fmt(Math.max.apply(null, scores))));
                tr.appendChild(el("td", "num", fmt(totalMoves / rs.length)));
                tr.appendChild(el("td", "num", (totalMs / Math.max(1, totalMoves)).toFixed(2)));
                REACH.forEach(function (tile) {
                    const share = rs.filter(function (r) { return r.maxTile >= tile; }).length / rs.length;
                    const td = el("td", "num");
                    const pct = el("span", "pct");
                    pct.appendChild(el("span", "", Math.round(share * 100) + "%"));
                    const pb = el("span", "pct-bar");
                    const fill = el("b");
                    fill.style.width = (share * 100).toFixed(1) + "%";
                    pb.appendChild(fill);
                    pct.appendChild(pb);
                    td.appendChild(pct);
                    tr.appendChild(td);
                });
            }
            tbody.appendChild(tr);
        });
    }

    function benchStatus() {
        const done = bench.algos.reduce(function (s, id) { return s + bench.results[id].length; }, 0);
        const total = bench.algos.length * bench.planned;
        const secs = Math.round((performance.now() - bench.startedAt) / 1000);
        if (bench.running) {
            $("bench-status").textContent = done + " of " + total + " games · " + secs + "s · " + bench.agents.length + " workers";
        } else if (total > 0) {
            $("bench-status").textContent = done + " of " + total + " games in " + secs + "s";
        }
    }

    let benchRenderTimer = null;
    function scheduleBenchRender() {
        if (benchRenderTimer !== null) {
            return;
        }
        benchRenderTimer = setTimeout(function () {
            benchRenderTimer = null;
            renderBench();
            benchStatus();
        }, 200);
    }

    function stopBench() {
        bench.running = false;
        bench.runId++;
        bench.agents.forEach(function (a) {
            a.terminate();
        });
        bench.agents = [];
        $("bench-run").textContent = "Run benchmark";
        benchStatus();
        renderBench();
    }

    async function runBench() {
        if (bench.running) {
            stopBench();
            return;
        }
        const algos = ALGOS.map(function (a) { return a.id; }).filter(function (id) {
            return bench.selected.indexOf(id) >= 0;
        });
        if (algos.length === 0) {
            $("bench-status").textContent = "Select at least one algorithm.";
            return;
        }
        bench.runId++;
        const runId = bench.runId;
        bench.running = true;
        bench.algos = algos;
        bench.planned = Number($("bench-games").value);
        bench.results = {};
        algos.forEach(function (id) {
            bench.results[id] = [];
        });
        const thinkMs = Number($("bench-think").value);
        const jobs = [];
        // Interleave so every algorithm shows progress early.
        for (let g = 1; g <= bench.planned; g++) {
            algos.forEach(function (id) {
                jobs.push({ algo: id, seed: g * 7919 });
            });
        }
        let poolSize = 1;
        if (!useLocal) {
            poolSize = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
        }
        bench.agents = [];
        for (let i = 0; i < poolSize; i++) {
            bench.agents.push(new Agent());
        }
        bench.startedAt = performance.now();
        $("bench-run").textContent = "Stop";
        renderBench();
        benchStatus();
        const ticker = setInterval(function () {
            if (bench.runId !== runId) {
                clearInterval(ticker);
                return;
            }
            benchStatus();
        }, 1000);

        async function workerLoop(agent) {
            while (jobs.length > 0 && bench.runId === runId) {
                const job = jobs.shift();
                const r = await agent.call({ type: "bench", algo: job.algo, seed: job.seed, opts: { budgetMs: thinkMs } });
                if (bench.runId !== runId) {
                    return;
                }
                bench.results[job.algo].push(r);
                scheduleBenchRender();
            }
        }
        await Promise.all(bench.agents.map(workerLoop));
        clearInterval(ticker);
        if (bench.runId === runId) {
            stopBench();
        }
    }

    function initBenchTooltip() {
        const wrap = $("dist-wrap");
        const tip = $("dist-tip");
        wrap.addEventListener("pointermove", function (e) {
            const seg = e.target.closest && e.target.closest(".dist-seg");
            if (!seg) {
                tip.hidden = true;
                return;
            }
            const parts = seg.dataset.tip.split("|");
            tip.replaceChildren();
            tip.appendChild(el("div", "tt-title", parts[0]));
            const row = el("div", "tt-row");
            row.style.setProperty("--series", seg.style.background);
            row.appendChild(el("i"));
            row.appendChild(el("span", "", "Best tile " + parts[1]));
            row.appendChild(el("b", "", parts[2] + " of " + parts[3] + " (" + Math.round((Number(parts[2]) / Number(parts[3])) * 100) + "%)"));
            tip.appendChild(row);
            tip.hidden = false;
            const rect = wrap.getBoundingClientRect();
            let left = e.clientX - rect.left + 14;
            if (left + tip.offsetWidth > rect.width) {
                left = e.clientX - rect.left - tip.offsetWidth - 14;
            }
            tip.style.left = Math.max(0, left) + "px";
            tip.style.top = (e.clientY - rect.top + 14) + "px";
        });
        wrap.addEventListener("pointerleave", function () {
            tip.hidden = true;
        });
    }

    function initBenchControls() {
        buildChips($("bench-chips"), bench.selected, function (id, chip) {
            if (bench.running) {
                return;
            }
            const i = bench.selected.indexOf(id);
            if (i >= 0) {
                bench.selected.splice(i, 1);
            } else {
                bench.selected.push(id);
            }
            chip.setAttribute("aria-pressed", String(bench.selected.indexOf(id) >= 0));
        });
        $("bench-run").addEventListener("click", runBench);
        initBenchTooltip();
    }

    // ===== Algorithms view ===================================================
    function renderAlgoCards() {
        const grid = $("algo-cards");
        ALGOS.forEach(function (algo) {
            const card = el("article", "algo-card");
            card.style.setProperty("--series", algo.series);
            const header = el("header");
            header.appendChild(el("span", "dot"));
            header.appendChild(el("h3", "", algo.name));
            header.appendChild(el("span", "kind", algo.kind));
            if (algo.legacy) {
                header.appendChild(el("span", "badge", "2022 original"));
            }
            card.appendChild(header);
            card.appendChild(el("p", "", algo.blurb));
            const dl = el("dl");
            dl.appendChild(el("dt", "", "How"));
            dl.appendChild(el("dd", "", algo.how));
            dl.appendChild(el("dt", "", "Watch for"));
            dl.appendChild(el("dd", "", algo.watch));
            dl.appendChild(el("dt", "", "Bars show"));
            dl.appendChild(el("dd", "", algo.unit));
            card.appendChild(dl);
            grid.appendChild(card);
        });
    }

    // ===== Boot ==============================================================
    async function boot() {
        restorePrefs();
        arena.seed = randomSeed();
        $("seed").value = String(arena.seed);
        renderAlgoCards();
        initTabs();
        initArenaControls();
        initBenchControls();
        initRaceHover();
        initBoardSizing();
        setRunning(true);
        await probeWorkers();
        syncLanes();
    }

    boot();
})();
