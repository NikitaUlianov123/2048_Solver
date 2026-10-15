// The whole engine lives inside one function so the page can turn its source
// into a Web Worker (solverCore.toString()) and Node can load it for tests.
function solverCore() {
    "use strict";

    // ===== Constants =========================================================
    const UP = 0;
    const RIGHT = 1;
    const DOWN = 2;
    const LEFT = 3;
    const DIRS = [UP, RIGHT, DOWN, LEFT];
    const FOUR_CHANCE = 0.1;
    const LOSS = -1e9;

    function now() {
        if (typeof performance !== "undefined") {
            return performance.now();
        }
        return Date.now();
    }

    function mulberry32(seed) {
        let a = seed >>> 0;
        return function () {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ===== Row tables ========================================================
    // A board is two uint32 words: hi = rows 0-1, lo = rows 2-3. A row is 16
    // bits; cell c (0 = leftmost) is the nibble at bit 4c and holds the tile
    // rank (0 = empty, 1 = 2, 2 = 4, ... 15 = 32768).
    const ROW_LEFT = new Uint16Array(65536);
    const ROW_RIGHT = new Uint16Array(65536);
    const ROW_SCORE_LEFT = new Uint32Array(65536);
    const ROW_SCORE_RIGHT = new Uint32Array(65536);
    const ROW_HEUR = new Float64Array(65536);
    const ROW_EMPTY = new Uint8Array(65536);

    function reverseRow(r) {
        return ((r & 15) << 12) | (((r >>> 4) & 15) << 8) | (((r >>> 8) & 15) << 4) | ((r >>> 12) & 15);
    }

    function slideLineLeft(line) {
        const tiles = [];
        for (let i = 0; i < 4; i++) {
            if (line[i] !== 0) {
                tiles.push(line[i]);
            }
        }
        const out = [];
        let score = 0;
        let k = 0;
        while (k < tiles.length) {
            // Rank 15 cannot merge: rank 16 does not fit in a nibble.
            if (k + 1 < tiles.length && tiles[k] === tiles[k + 1] && tiles[k] < 15) {
                out.push(tiles[k] + 1);
                score += 2 ** (tiles[k] + 1);
                k += 2;
            } else {
                out.push(tiles[k]);
                k += 1;
            }
        }
        while (out.length < 4) {
            out.push(0);
        }
        return { line: out, score: score };
    }

    // Heuristic from nneonneo's 2048-ai: reward empty cells and merges,
    // penalize non-monotonic rows and large scattered tiles.
    function rowHeuristic(line) {
        let sum = 0;
        let empty = 0;
        let merges = 0;
        let prev = 0;
        let counter = 0;
        for (let i = 0; i < 4; i++) {
            const rank = line[i];
            sum += Math.pow(rank, 3.5);
            if (rank === 0) {
                empty++;
            } else {
                if (prev === rank) {
                    counter++;
                } else if (counter > 0) {
                    merges += 1 + counter;
                    counter = 0;
                }
                prev = rank;
            }
        }
        if (counter > 0) {
            merges += 1 + counter;
        }
        let monoLeft = 0;
        let monoRight = 0;
        for (let i = 1; i < 4; i++) {
            if (line[i - 1] > line[i]) {
                monoLeft += Math.pow(line[i - 1], 4) - Math.pow(line[i], 4);
            } else {
                monoRight += Math.pow(line[i], 4) - Math.pow(line[i - 1], 4);
            }
        }
        return 200000 + 270 * empty + 700 * merges - 47 * Math.min(monoLeft, monoRight) - 11 * sum;
    }

    for (let r = 0; r < 65536; r++) {
        const line = [r & 15, (r >>> 4) & 15, (r >>> 8) & 15, (r >>> 12) & 15];
        const slid = slideLineLeft(line);
        ROW_LEFT[r] = slid.line[0] | (slid.line[1] << 4) | (slid.line[2] << 8) | (slid.line[3] << 12);
        ROW_SCORE_LEFT[r] = slid.score;
        ROW_HEUR[r] = rowHeuristic(line);
        let empty = 0;
        for (let i = 0; i < 4; i++) {
            if (line[i] === 0) {
                empty++;
            }
        }
        ROW_EMPTY[r] = empty;
    }
    for (let r = 0; r < 65536; r++) {
        const rev = reverseRow(r);
        ROW_RIGHT[r] = reverseRow(ROW_LEFT[rev]);
        ROW_SCORE_RIGHT[r] = ROW_SCORE_LEFT[rev];
    }

    // ===== Board operations ==================================================
    // Hot-path functions return boards through these to avoid allocation.
    // Copy them into locals right away: the next call overwrites them.
    let outHi = 0;
    let outLo = 0;
    let outScore = 0;

    function column(r0, r1, r2, r3, shift) {
        return ((r0 >>> shift) & 15) | (((r1 >>> shift) & 15) << 4) | (((r2 >>> shift) & 15) << 8) | (((r3 >>> shift) & 15) << 12);
    }

    function transpose(hi, lo) {
        const r0 = hi >>> 16;
        const r1 = hi & 0xffff;
        const r2 = lo >>> 16;
        const r3 = lo & 0xffff;
        const c0 = column(r0, r1, r2, r3, 0);
        const c1 = column(r0, r1, r2, r3, 4);
        const c2 = column(r0, r1, r2, r3, 8);
        const c3 = column(r0, r1, r2, r3, 12);
        outHi = ((c0 << 16) | c1) >>> 0;
        outLo = ((c2 << 16) | c3) >>> 0;
    }

    function move(hi, lo, dir) {
        let h = hi;
        let l = lo;
        const vertical = dir === UP || dir === DOWN;
        if (vertical) {
            transpose(hi, lo);
            h = outHi;
            l = outLo;
        }
        let table = ROW_LEFT;
        let scores = ROW_SCORE_LEFT;
        if (dir === RIGHT || dir === DOWN) {
            table = ROW_RIGHT;
            scores = ROW_SCORE_RIGHT;
        }
        const r0 = h >>> 16;
        const r1 = h & 0xffff;
        const r2 = l >>> 16;
        const r3 = l & 0xffff;
        let nh = ((table[r0] << 16) | table[r1]) >>> 0;
        let nl = ((table[r2] << 16) | table[r3]) >>> 0;
        const score = scores[r0] + scores[r1] + scores[r2] + scores[r3];
        if (vertical) {
            transpose(nh, nl);
            nh = outHi;
            nl = outLo;
        }
        outHi = nh;
        outLo = nl;
        outScore = score;
        return nh !== hi || nl !== lo;
    }

    function cellShift(k) {
        const row = k >>> 2;
        return (1 - (row & 1)) * 16 + (k & 3) * 4;
    }

    function getCell(hi, lo, k) {
        let word = hi;
        if (k >= 8) {
            word = lo;
        }
        return (word >>> cellShift(k)) & 15;
    }

    function setCell(hi, lo, k, rank) {
        const shift = cellShift(k);
        const mask = ~(15 << shift);
        if (k < 8) {
            outHi = ((hi & mask) | (rank << shift)) >>> 0;
            outLo = lo;
        } else {
            outHi = hi;
            outLo = ((lo & mask) | (rank << shift)) >>> 0;
        }
    }

    function emptyCount(hi, lo) {
        return ROW_EMPTY[hi >>> 16] + ROW_EMPTY[hi & 0xffff] + ROW_EMPTY[lo >>> 16] + ROW_EMPTY[lo & 0xffff];
    }

    function heuristic(hi, lo) {
        let h = ROW_HEUR[hi >>> 16] + ROW_HEUR[hi & 0xffff] + ROW_HEUR[lo >>> 16] + ROW_HEUR[lo & 0xffff];
        transpose(hi, lo);
        const th = outHi;
        const tl = outLo;
        h += ROW_HEUR[th >>> 16] + ROW_HEUR[th & 0xffff] + ROW_HEUR[tl >>> 16] + ROW_HEUR[tl & 0xffff];
        return h;
    }

    function maxRank(hi, lo) {
        let best = 0;
        for (let k = 0; k < 16; k++) {
            const r = getCell(hi, lo, k);
            if (r > best) {
                best = r;
            }
        }
        return best;
    }

    function distinctTiles(hi, lo) {
        let seen = 0;
        for (let k = 0; k < 16; k++) {
            seen |= 1 << getCell(hi, lo, k);
        }
        seen &= ~1;
        let count = 0;
        while (seen !== 0) {
            seen &= seen - 1;
            count++;
        }
        return count;
    }

    // Returns the cell index that got the new tile, or -1 if the board is full.
    function spawnRandom(hi, lo, rng) {
        const n = emptyCount(hi, lo);
        if (n === 0) {
            outHi = hi;
            outLo = lo;
            return -1;
        }
        let pick = Math.floor(rng() * n);
        let rank = 1;
        if (rng() < FOUR_CHANCE) {
            rank = 2;
        }
        for (let k = 0; k < 16; k++) {
            if (getCell(hi, lo, k) === 0) {
                if (pick === 0) {
                    setCell(hi, lo, k, rank);
                    return k;
                }
                pick--;
            }
        }
        return -1;
    }

    function hasMove(hi, lo) {
        for (let d = 0; d < 4; d++) {
            if (move(hi, lo, d)) {
                return true;
            }
        }
        return false;
    }

    function toCells(hi, lo) {
        const cells = [];
        for (let k = 0; k < 16; k++) {
            cells.push(getCell(hi, lo, k));
        }
        return cells;
    }

    function fromCells(cells) {
        let hi = 0;
        let lo = 0;
        for (let k = 0; k < 16; k++) {
            setCell(hi, lo, k, cells[k]);
            hi = outHi;
            lo = outLo;
        }
        return { hi: hi, lo: lo };
    }

    // ===== Slide plan (animation) ============================================
    // Pure grid version of a move that also reports where each tile travels,
    // so the page can animate it. Tests check it against move().
    function lineIndices(dir, i) {
        const res = [];
        for (let j = 0; j < 4; j++) {
            if (dir === LEFT) {
                res.push(i * 4 + j);
            } else if (dir === RIGHT) {
                res.push(i * 4 + 3 - j);
            } else if (dir === UP) {
                res.push(j * 4 + i);
            } else {
                res.push((3 - j) * 4 + i);
            }
        }
        return res;
    }

    function slidePlan(cells, dir) {
        const result = [];
        for (let k = 0; k < 16; k++) {
            result.push(0);
        }
        const moves = [];
        let score = 0;
        for (let i = 0; i < 4; i++) {
            const idx = lineIndices(dir, i);
            let target = 0;
            let lastRank = 0;
            let canMerge = false;
            for (let j = 0; j < 4; j++) {
                const from = idx[j];
                const r = cells[from];
                if (r === 0) {
                    continue;
                }
                if (canMerge && r === lastRank && r < 15) {
                    const to = idx[target - 1];
                    result[to] = r + 1;
                    score += 2 ** (r + 1);
                    moves.push({ from: from, to: to, merged: true });
                    canMerge = false;
                } else {
                    const to = idx[target];
                    result[to] = r;
                    moves.push({ from: from, to: to, merged: false });
                    lastRank = r;
                    canMerge = true;
                    target++;
                }
            }
        }
        return { cells: result, moves: moves, score: score };
    }

    // ===== Search bookkeeping ================================================
    let deadline = Infinity;
    let nodes = 0;
    let aborted = false;

    function tick() {
        nodes++;
        if ((nodes & 1023) === 0 && deadline !== Infinity && now() > deadline) {
            aborted = true;
        }
    }

    function emptyEvals() {
        return [null, null, null, null];
    }

    function budgetOf(opts) {
        if (opts && typeof opts.budgetMs === "number") {
            return opts.budgetMs;
        }
        return Infinity;
    }

    function bestOf(evals, rng) {
        let best = -1;
        let ties = [];
        for (let d = 0; d < 4; d++) {
            if (evals[d] === null) {
                continue;
            }
            if (best === -1 || evals[d] > evals[best]) {
                best = d;
                ties = [d];
            } else if (evals[d] === evals[best]) {
                ties.push(d);
            }
        }
        if (ties.length > 1 && rng) {
            return ties[Math.floor(rng() * ties.length)];
        }
        return best;
    }

    // ===== Bot: Random (legacy StupidBot) ====================================
    function chooseRandom(hi, lo, opts, rng) {
        const evals = emptyEvals();
        const legal = [];
        for (let d = 0; d < 4; d++) {
            if (move(hi, lo, d)) {
                legal.push(d);
                evals[d] = 1;
            }
        }
        if (legal.length === 0) {
            return { move: -1, evals: evals };
        }
        return { move: legal[Math.floor(rng() * legal.length)], evals: evals };
    }

    // ===== Bot: Greedy (legacy ehBot) ========================================
    function chooseGreedy(hi, lo, opts, rng) {
        const evals = emptyEvals();
        for (let d = 0; d < 4; d++) {
            if (move(hi, lo, d)) {
                evals[d] = outScore;
            }
        }
        return { move: bestOf(evals, rng), evals: evals };
    }

    // ===== Bot: Corner =======================================================
    const CORNER_ORDER = [DOWN, LEFT, RIGHT, UP];

    function chooseCorner(hi, lo) {
        const evals = emptyEvals();
        let chosen = -1;
        for (let i = 0; i < 4; i++) {
            const d = CORNER_ORDER[i];
            if (move(hi, lo, d)) {
                evals[d] = 4 - i;
                if (chosen === -1) {
                    chosen = d;
                }
            }
        }
        return { move: chosen, evals: evals };
    }

    // ===== Bot: Monte Carlo rollouts =========================================
    function rollout(hi, lo, rng) {
        let h = hi;
        let l = lo;
        let score = 0;
        for (;;) {
            const start = Math.floor(rng() * 4);
            let moved = false;
            for (let i = 0; i < 4; i++) {
                if (move(h, l, (start + i) & 3)) {
                    h = outHi;
                    l = outLo;
                    score += outScore;
                    moved = true;
                    break;
                }
            }
            if (!moved) {
                return score;
            }
            spawnRandom(h, l, rng);
            h = outHi;
            l = outLo;
        }
    }

    function chooseMonteCarlo(hi, lo, opts, rng) {
        const evals = emptyEvals();
        const children = [];
        for (let d = 0; d < 4; d++) {
            if (move(hi, lo, d)) {
                children.push({ dir: d, hi: outHi, lo: outLo, score: outScore, total: 0, count: 0 });
            }
        }
        if (children.length === 0) {
            return { move: -1, evals: evals };
        }
        const budget = budgetOf(opts);
        let maxRollouts = 1000000;
        if (opts && typeof opts.rollouts === "number") {
            maxRollouts = opts.rollouts;
        }
        const minRollouts = Math.min(8, maxRollouts);
        const start = now();
        let runs = 0;
        for (let round = 0; round < maxRollouts; round++) {
            if (round >= minRollouts && now() - start > budget) {
                break;
            }
            for (let i = 0; i < children.length; i++) {
                const c = children[i];
                spawnRandom(c.hi, c.lo, rng);
                c.total += c.score + rollout(outHi, outLo, rng);
                c.count++;
                runs++;
            }
        }
        for (let i = 0; i < children.length; i++) {
            evals[children[i].dir] = children[i].total / children[i].count;
        }
        return { move: bestOf(evals, null), evals: evals, nodes: runs };
    }

    // ===== Bot: Minimax with alpha-beta ======================================
    // Treats the tile spawn as an opponent that always picks the worst cell.
    function mmMax(hi, lo, depth, alpha, beta) {
        tick();
        if (aborted) {
            return 0;
        }
        if (depth === 0) {
            return heuristic(hi, lo);
        }
        let best = LOSS;
        let a = alpha;
        for (let d = 0; d < 4; d++) {
            if (move(hi, lo, d)) {
                const v = mmMin(outHi, outLo, depth, a, beta);
                if (v > best) {
                    best = v;
                }
                if (best > a) {
                    a = best;
                }
                if (a >= beta) {
                    break;
                }
            }
        }
        return best;
    }

    function mmMin(hi, lo, depth, alpha, beta) {
        tick();
        if (aborted) {
            return 0;
        }
        let best = Infinity;
        let b = beta;
        for (let k = 0; k < 16; k++) {
            if (getCell(hi, lo, k) !== 0) {
                continue;
            }
            for (let rank = 1; rank <= 2; rank++) {
                setCell(hi, lo, k, rank);
                const v = mmMax(outHi, outLo, depth - 1, alpha, b);
                if (v < best) {
                    best = v;
                }
                if (best < b) {
                    b = best;
                }
                if (alpha >= b) {
                    return best;
                }
            }
        }
        if (best === Infinity) {
            return mmMax(hi, lo, depth - 1, alpha, beta);
        }
        return best;
    }

    function chooseMinimax(hi, lo, opts) {
        const children = [];
        for (let d = 0; d < 4; d++) {
            if (move(hi, lo, d)) {
                children.push({ dir: d, hi: outHi, lo: outLo });
            }
        }
        if (children.length === 0) {
            return { move: -1, evals: emptyEvals() };
        }
        let maxDepth = 8;
        if (opts && typeof opts.maxDepth === "number") {
            maxDepth = opts.maxDepth;
        }
        const start = now();
        const budget = budgetOf(opts);
        nodes = 0;
        let result = null;
        let reached = 0;
        for (let depth = 1; depth <= maxDepth; depth++) {
            aborted = false;
            deadline = Infinity;
            if (depth > 1) {
                deadline = start + budget;
            }
            const evals = emptyEvals();
            for (let i = 0; i < children.length; i++) {
                evals[children[i].dir] = mmMin(children[i].hi, children[i].lo, depth, -Infinity, Infinity);
                if (aborted) {
                    break;
                }
            }
            if (aborted) {
                break;
            }
            result = evals;
            reached = depth;
            if (now() - start > budget) {
                break;
            }
        }
        deadline = Infinity;
        aborted = false;
        return { move: bestOf(result, null), evals: result, depth: reached, nodes: nodes };
    }

    // ===== Bot: Expectimax ===================================================
    // Weights each spawn by its real odds (90% a 2, 10% a 4). Prunes branches
    // whose total probability falls below 1e-4, and caches chance nodes.
    const TT_BITS = 18;
    let ttHi = null;
    let ttLo = null;
    let ttDepth = null;
    let ttVal = null;

    function ttInit() {
        if (ttHi === null) {
            ttHi = new Uint32Array(1 << TT_BITS);
            ttLo = new Uint32Array(1 << TT_BITS);
            ttDepth = new Int8Array(1 << TT_BITS);
            ttVal = new Float64Array(1 << TT_BITS);
        }
        ttDepth.fill(-1);
    }

    function ttIndex(hi, lo) {
        return (Math.imul(hi ^ (lo >>> 13), 0x9e3779b1) ^ Math.imul(lo, 0x85ebca77)) >>> (32 - TT_BITS);
    }

    function exChance(hi, lo, depthLeft, cprob) {
        tick();
        if (aborted) {
            return 0;
        }
        if (depthLeft <= 0 || cprob < 0.0001) {
            return heuristic(hi, lo);
        }
        const slot = ttIndex(hi, lo);
        if (ttDepth[slot] >= depthLeft && ttHi[slot] === hi && ttLo[slot] === lo) {
            return ttVal[slot];
        }
        const n = emptyCount(hi, lo);
        if (n === 0) {
            return exMax(hi, lo, depthLeft, cprob);
        }
        const p = cprob / n;
        let total = 0;
        for (let k = 0; k < 16; k++) {
            if (getCell(hi, lo, k) !== 0) {
                continue;
            }
            setCell(hi, lo, k, 1);
            total += (1 - FOUR_CHANCE) * exMax(outHi, outLo, depthLeft, p * (1 - FOUR_CHANCE));
            setCell(hi, lo, k, 2);
            total += FOUR_CHANCE * exMax(outHi, outLo, depthLeft, p * FOUR_CHANCE);
        }
        const value = total / n;
        if (!aborted) {
            ttHi[slot] = hi;
            ttLo[slot] = lo;
            ttDepth[slot] = depthLeft;
            ttVal[slot] = value;
        }
        return value;
    }

    function exMax(hi, lo, depthLeft, cprob) {
        let best = 0;
        for (let d = 0; d < 4; d++) {
            if (move(hi, lo, d)) {
                const v = exChance(outHi, outLo, depthLeft - 1, cprob);
                if (v > best) {
                    best = v;
                }
            }
        }
        return best;
    }

    function chooseExpectimax(hi, lo, opts) {
        const children = [];
        for (let d = 0; d < 4; d++) {
            if (move(hi, lo, d)) {
                children.push({ dir: d, hi: outHi, lo: outLo });
            }
        }
        if (children.length === 0) {
            return { move: -1, evals: emptyEvals() };
        }
        let maxDepth = 8;
        if (opts && typeof opts.maxDepth === "number") {
            maxDepth = opts.maxDepth;
        }
        const limit = Math.max(1, Math.min(maxDepth, Math.max(2, distinctTiles(hi, lo) - 2)));
        const start = now();
        const budget = budgetOf(opts);
        ttInit();
        nodes = 0;
        let result = null;
        let reached = 0;
        for (let depth = 1; depth <= limit; depth++) {
            aborted = false;
            deadline = Infinity;
            if (depth > 1) {
                deadline = start + budget;
            }
            const evals = emptyEvals();
            for (let i = 0; i < children.length; i++) {
                evals[children[i].dir] = exChance(children[i].hi, children[i].lo, depth - 1, 1);
                if (aborted) {
                    break;
                }
            }
            if (aborted) {
                break;
            }
            result = evals;
            reached = depth;
            if (now() - start > budget) {
                break;
            }
        }
        deadline = Infinity;
        aborted = false;
        return { move: bestOf(result, null), evals: result, depth: reached, nodes: nodes };
    }

    // ===== Bot registry and games ============================================
    const BOTS = {
        random: chooseRandom,
        greedy: chooseGreedy,
        corner: chooseCorner,
        montecarlo: chooseMonteCarlo,
        minimax: chooseMinimax,
        expectimax: chooseExpectimax
    };

    function choose(algo, hi, lo, opts, rng) {
        const fn = BOTS[algo];
        if (!fn) {
            throw new Error("Unknown algorithm: " + algo);
        }
        return fn(hi >>> 0, lo >>> 0, opts || {}, rng);
    }

    function newGame(rng) {
        spawnRandom(0, 0, rng);
        spawnRandom(outHi, outLo, rng);
        return { hi: outHi, lo: outLo };
    }

    function playGame(algo, seed, opts) {
        const gameRng = mulberry32(seed);
        const botRng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
        const start = now();
        const board = newGame(gameRng);
        let hi = board.hi;
        let lo = board.lo;
        let score = 0;
        let moves = 0;
        for (;;) {
            const res = choose(algo, hi, lo, opts, botRng);
            if (res.move < 0 || !move(hi, lo, res.move)) {
                break;
            }
            hi = outHi;
            lo = outLo;
            score += outScore;
            moves++;
            spawnRandom(hi, lo, gameRng);
            hi = outHi;
            lo = outLo;
        }
        return { score: score, maxTile: 2 ** maxRank(hi, lo), moves: moves, ms: now() - start, hi: hi, lo: lo };
    }

    // ===== Public API ========================================================
    function applyMove(hi, lo, dir) {
        const changed = move(hi >>> 0, lo >>> 0, dir);
        return { hi: outHi, lo: outLo, score: outScore, changed: changed };
    }

    function spawn(hi, lo, rng) {
        const index = spawnRandom(hi >>> 0, lo >>> 0, rng);
        return { hi: outHi, lo: outLo, index: index };
    }

    function transposeBoard(hi, lo) {
        transpose(hi >>> 0, lo >>> 0);
        return { hi: outHi, lo: outLo };
    }

    function setCellBoard(hi, lo, k, rank) {
        setCell(hi >>> 0, lo >>> 0, k, rank);
        return { hi: outHi, lo: outLo };
    }

    let workerRng = null;

    function handle(msg, post) {
        if (msg.type === "ping") {
            post({ type: "pong" });
        } else if (msg.type === "think") {
            if (workerRng === null) {
                workerRng = mulberry32(msg.rngSeed || 1);
            }
            const t0 = now();
            const res = choose(msg.algo, msg.hi, msg.lo, msg.opts, workerRng);
            post({
                type: "thought",
                id: msg.id,
                move: res.move,
                evals: res.evals,
                depth: res.depth || 0,
                nodes: res.nodes || 0,
                ms: now() - t0
            });
        } else if (msg.type === "bench") {
            const r = playGame(msg.algo, msg.seed, msg.opts);
            post({ type: "benchResult", id: msg.id, score: r.score, maxTile: r.maxTile, moves: r.moves, ms: r.ms });
        }
    }

    const api = {
        UP: UP,
        RIGHT: RIGHT,
        DOWN: DOWN,
        LEFT: LEFT,
        DIRS: DIRS,
        mulberry32: mulberry32,
        applyMove: applyMove,
        spawn: spawn,
        newGame: newGame,
        hasMove: hasMove,
        toCells: toCells,
        fromCells: fromCells,
        getCell: getCell,
        setCell: setCellBoard,
        transpose: transposeBoard,
        emptyCount: emptyCount,
        heuristic: heuristic,
        maxRank: maxRank,
        distinctTiles: distinctTiles,
        slidePlan: slidePlan,
        choose: choose,
        playGame: playGame,
        handle: handle,
        rowTables: { left: ROW_LEFT, right: ROW_RIGHT, scoreLeft: ROW_SCORE_LEFT, scoreRight: ROW_SCORE_RIGHT }
    };

    if (typeof window === "undefined" && typeof self !== "undefined" && typeof self.postMessage === "function") {
        self.onmessage = function (e) {
            handle(e.data, function (out) {
                self.postMessage(out);
            });
        };
    }

    return api;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = solverCore;
}
