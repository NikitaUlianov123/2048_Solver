const test = require("node:test");
const assert = require("node:assert/strict");
const solverCore = require("../js/core.js");

const core = solverCore();
const { UP, RIGHT, DOWN, LEFT } = core;
const ALGOS = ["random", "greedy", "corner", "montecarlo", "minimax", "expectimax"];

function board(rows) {
    const cells = [];
    for (const row of rows) {
        for (const v of row) {
            if (v === 0) {
                cells.push(0);
            } else {
                cells.push(Math.log2(v));
            }
        }
    }
    return core.fromCells(cells);
}

function values(b) {
    return core.toCells(b.hi, b.lo).map(function (r) {
        if (r === 0) {
            return 0;
        }
        return 2 ** r;
    });
}

// Plain grid implementation used as the reference for the bitboard engine.
function naiveMove(cells, dir) {
    const grid = cells.slice();
    let score = 0;
    for (let i = 0; i < 4; i++) {
        const idx = [];
        for (let j = 0; j < 4; j++) {
            if (dir === LEFT) {
                idx.push(i * 4 + j);
            } else if (dir === RIGHT) {
                idx.push(i * 4 + 3 - j);
            } else if (dir === UP) {
                idx.push(j * 4 + i);
            } else {
                idx.push((3 - j) * 4 + i);
            }
        }
        const tiles = idx.map((k) => grid[k]).filter((r) => r !== 0);
        const out = [];
        for (let k = 0; k < tiles.length; k++) {
            if (k + 1 < tiles.length && tiles[k] === tiles[k + 1] && tiles[k] < 15) {
                out.push(tiles[k] + 1);
                score += 2 ** (tiles[k] + 1);
                k++;
            } else {
                out.push(tiles[k]);
            }
        }
        for (let j = 0; j < 4; j++) {
            if (j < out.length) {
                grid[idx[j]] = out[j];
            } else {
                grid[idx[j]] = 0;
            }
        }
    }
    return { cells: grid, score: score };
}

function randomCells(rng, maxRank, emptyChance) {
    const cells = [];
    for (let k = 0; k < 16; k++) {
        if (rng() < emptyChance) {
            cells.push(0);
        } else {
            cells.push(1 + Math.floor(rng() * maxRank));
        }
    }
    return cells;
}

test("row slides left: basic merges", () => {
    const cases = [
        [[0, 0, 0, 0], [0, 0, 0, 0], 0],
        [[2, 0, 0, 0], [2, 0, 0, 0], 0],
        [[0, 0, 0, 2], [2, 0, 0, 0], 0],
        [[2, 2, 0, 0], [4, 0, 0, 0], 4],
        [[2, 0, 2, 0], [4, 0, 0, 0], 4],
        [[2, 2, 2, 0], [4, 2, 0, 0], 4],
        [[2, 2, 2, 2], [4, 4, 0, 0], 8],
        [[4, 2, 2, 0], [4, 4, 0, 0], 4],
        [[2, 2, 4, 4], [4, 8, 0, 0], 12],
        [[2, 4, 8, 16], [2, 4, 8, 16], 0],
        [[4, 4, 4, 0], [8, 4, 0, 0], 8],
        [[0, 2, 2, 4], [4, 4, 0, 0], 4]
    ];
    for (const [input, expected, score] of cases) {
        const b = board([input, [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
        const res = core.applyMove(b.hi, b.lo, LEFT);
        assert.deepEqual(values(res).slice(0, 4), expected, "row " + input.join(","));
        assert.equal(res.score, score, "score for " + input.join(","));
    }
});

test("merged tiles do not merge again in the same move", () => {
    const b = board([[4, 4, 8, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    const res = core.applyMove(b.hi, b.lo, LEFT);
    assert.deepEqual(values(res).slice(0, 4), [8, 8, 0, 0]);
});

test("each direction moves tiles the right way", () => {
    const b = board([
        [2, 0, 0, 2],
        [0, 0, 0, 0],
        [0, 4, 0, 0],
        [0, 4, 0, 8]
    ]);
    assert.deepEqual(values(core.applyMove(b.hi, b.lo, LEFT)), [4, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 4, 8, 0, 0]);
    assert.deepEqual(values(core.applyMove(b.hi, b.lo, RIGHT)), [0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 4, 8]);
    assert.deepEqual(values(core.applyMove(b.hi, b.lo, UP)), [2, 8, 0, 2, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(values(core.applyMove(b.hi, b.lo, DOWN)), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 8, 0, 8]);
});

test("bitboard moves match the reference on random boards", () => {
    const rng = core.mulberry32(1234);
    for (let n = 0; n < 4000; n++) {
        const cells = randomCells(rng, 15, 0.35);
        const b = core.fromCells(cells);
        for (const dir of [UP, RIGHT, DOWN, LEFT]) {
            const expected = naiveMove(cells, dir);
            const res = core.applyMove(b.hi, b.lo, dir);
            assert.deepEqual(core.toCells(res.hi, res.lo), expected.cells);
            assert.equal(res.score, expected.score);
            const changed = expected.cells.some((v, i) => v !== cells[i]);
            assert.equal(res.changed, changed);
        }
    }
});

test("rank 15 tiles (32768) never merge", () => {
    const cells = [15, 15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const b = core.fromCells(cells);
    const res = core.applyMove(b.hi, b.lo, LEFT);
    assert.equal(res.changed, false);
    assert.equal(res.score, 0);
});

test("a move that changes nothing is reported as illegal", () => {
    const b = board([[2, 4, 0, 0], [8, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    assert.equal(core.applyMove(b.hi, b.lo, LEFT).changed, false);
    assert.equal(core.applyMove(b.hi, b.lo, UP).changed, false);
    assert.equal(core.applyMove(b.hi, b.lo, RIGHT).changed, true);
    assert.equal(core.applyMove(b.hi, b.lo, DOWN).changed, true);
});

test("cells round-trip through get and set for every index and rank", () => {
    for (let k = 0; k < 16; k++) {
        for (let rank = 0; rank < 16; rank++) {
            const b = core.setCell(0, 0, k, rank);
            assert.equal(core.getCell(b.hi, b.lo, k), rank);
            for (let other = 0; other < 16; other++) {
                if (other !== k) {
                    assert.equal(core.getCell(b.hi, b.lo, other), 0);
                }
            }
        }
    }
    const full = core.fromCells(Array(16).fill(15));
    assert.equal(full.hi, 0xffffffff);
    assert.equal(full.lo, 0xffffffff);
});

test("transpose swaps rows and columns and undoes itself", () => {
    const rng = core.mulberry32(99);
    for (let n = 0; n < 500; n++) {
        const cells = randomCells(rng, 15, 0.2);
        const b = core.fromCells(cells);
        const t = core.transpose(b.hi, b.lo);
        const tc = core.toCells(t.hi, t.lo);
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 4; c++) {
                assert.equal(tc[c * 4 + r], cells[r * 4 + c]);
            }
        }
        const back = core.transpose(t.hi, t.lo);
        assert.equal(back.hi, b.hi);
        assert.equal(back.lo, b.lo);
    }
});

test("spawn only fills empty cells and returns -1 on a full board", () => {
    const rng = core.mulberry32(7);
    const b = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 0, 4], [4, 2, 4, 2]]);
    for (let n = 0; n < 50; n++) {
        const s = core.spawn(b.hi, b.lo, rng);
        assert.equal(s.index, 10);
        assert.ok(core.getCell(s.hi, s.lo, 10) === 1 || core.getCell(s.hi, s.lo, 10) === 2);
    }
    const full = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
    const s = core.spawn(full.hi, full.lo, rng);
    assert.equal(s.index, -1);
    assert.equal(s.hi, full.hi);
    assert.equal(s.lo, full.lo);
});

test("spawn makes a 4 about 10% of the time and uses every empty cell", () => {
    const rng = core.mulberry32(42);
    let fours = 0;
    const hits = Array(16).fill(0);
    const total = 40000;
    for (let n = 0; n < total; n++) {
        const s = core.spawn(0, 0, rng);
        hits[s.index]++;
        if (core.getCell(s.hi, s.lo, s.index) === 2) {
            fours++;
        }
    }
    const rate = fours / total;
    assert.ok(rate > 0.09 && rate < 0.11, "four rate " + rate);
    for (let k = 0; k < 16; k++) {
        assert.ok(hits[k] > total / 16 * 0.85 && hits[k] < total / 16 * 1.15, "cell " + k + " hit " + hits[k]);
    }
});

test("a new game has exactly two tiles", () => {
    for (let seed = 1; seed <= 50; seed++) {
        const g = core.newGame(core.mulberry32(seed));
        assert.equal(core.emptyCount(g.hi, g.lo), 14);
    }
});

test("game over only when no move changes the board", () => {
    const stuck = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
    assert.equal(core.hasMove(stuck.hi, stuck.lo), false);
    const fullButMergeable = board([[2, 2, 4, 8], [4, 8, 16, 32], [8, 16, 32, 64], [16, 32, 64, 128]]);
    assert.equal(core.hasMove(fullButMergeable.hi, fullButMergeable.lo), true);
    const verticalMerge = board([[2, 4, 2, 4], [2, 8, 4, 2], [4, 2, 8, 4], [2, 4, 2, 8]]);
    assert.equal(core.hasMove(verticalMerge.hi, verticalMerge.lo), true);
    assert.equal(core.hasMove(0, 0), false);
});

test("slide plan matches the engine and reports merges", () => {
    const rng = core.mulberry32(555);
    for (let n = 0; n < 3000; n++) {
        const cells = randomCells(rng, 12, 0.4);
        const b = core.fromCells(cells);
        for (const dir of [UP, RIGHT, DOWN, LEFT]) {
            const plan = core.slidePlan(cells, dir);
            const res = core.applyMove(b.hi, b.lo, dir);
            assert.deepEqual(plan.cells, core.toCells(res.hi, res.lo));
            assert.equal(plan.score, res.score);
            const tiles = cells.filter((r) => r !== 0).length;
            assert.equal(plan.moves.length, tiles);
            for (const m of plan.moves) {
                assert.ok(plan.cells[m.to] !== 0);
                if (m.merged) {
                    assert.equal(plan.cells[m.to], cells[m.from] + 1);
                }
            }
        }
    }
});

test("helpers: max rank, distinct tiles, empty count", () => {
    const b = board([[2, 2, 4, 0], [0, 0, 1024, 0], [0, 0, 0, 0], [8, 0, 0, 2]]);
    assert.equal(core.maxRank(b.hi, b.lo), 10);
    assert.equal(core.distinctTiles(b.hi, b.lo), 4);
    assert.equal(core.emptyCount(b.hi, b.lo), 10);
    assert.equal(core.maxRank(0, 0), 0);
    assert.equal(core.distinctTiles(0, 0), 0);
    assert.equal(core.emptyCount(0, 0), 16);
});

test("mulberry32 is deterministic per seed and in [0, 1)", () => {
    const a = core.mulberry32(5);
    const b = core.mulberry32(5);
    const c = core.mulberry32(6);
    let differs = false;
    for (let i = 0; i < 1000; i++) {
        const x = a();
        assert.equal(x, b());
        assert.ok(x >= 0 && x < 1);
        if (x !== c()) {
            differs = true;
        }
    }
    assert.ok(differs);
});

const FAST = { budgetMs: 5, maxDepth: 3, rollouts: 10 };

test("every bot returns a legal move with evals only on legal moves", () => {
    const rng = core.mulberry32(2024);
    for (const algo of ALGOS) {
        for (let n = 0; n < 40; n++) {
            const cells = randomCells(rng, 9, 0.4);
            const b = core.fromCells(cells);
            if (!core.hasMove(b.hi, b.lo)) {
                continue;
            }
            const res = core.choose(algo, b.hi, b.lo, FAST, rng);
            assert.ok(res.move >= 0 && res.move < 4, algo);
            assert.equal(core.applyMove(b.hi, b.lo, res.move).changed, true, algo + " picked an illegal move");
            for (let d = 0; d < 4; d++) {
                const legal = core.applyMove(b.hi, b.lo, d).changed;
                assert.equal(res.evals[d] !== null, legal, algo + " eval presence for dir " + d);
            }
        }
    }
});

test("every bot returns -1 when no move is possible", () => {
    const stuck = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]);
    for (const algo of ALGOS) {
        const res = core.choose(algo, stuck.hi, stuck.lo, FAST, core.mulberry32(1));
        assert.equal(res.move, -1, algo);
        assert.deepEqual(res.evals, [null, null, null, null], algo);
    }
});

test("every bot plays a legal move when only one move is possible", () => {
    // Only DOWN changes this board: the top row is empty above a full,
    // unmergeable block, and no row can slide sideways.
    const b = board([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [0, 0, 0, 0]]);
    const legal = [UP, RIGHT, DOWN, LEFT].filter((d) => core.applyMove(b.hi, b.lo, d).changed);
    assert.deepEqual(legal, [DOWN]);
    for (const algo of ALGOS) {
        assert.equal(core.choose(algo, b.hi, b.lo, FAST, core.mulberry32(3)).move, DOWN, algo);
    }
});

test("unknown algorithm throws", () => {
    assert.throws(() => core.choose("nope", 0, 0, {}, Math.random));
});

test("greedy takes the move with the most merge points", () => {
    const b = board([[2, 0, 0, 0], [2, 0, 0, 0], [8, 8, 0, 0], [0, 0, 0, 0]]);
    const res = core.choose("greedy", b.hi, b.lo, {}, core.mulberry32(1));
    assert.ok(res.move === LEFT || res.move === RIGHT);
    assert.equal(res.evals[LEFT], 16);
    assert.equal(res.evals[UP], 4);
});

test("corner prefers down, then left, then right, then up", () => {
    const downOk = board([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]);
    assert.equal(core.choose("corner", downOk.hi, downOk.lo, {}).move, DOWN);
    const leftOk = board([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 2, 0, 0]]);
    assert.equal(core.choose("corner", leftOk.hi, leftOk.lo, {}).move, LEFT);
    const rightOk = board([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0]]);
    assert.equal(core.choose("corner", rightOk.hi, rightOk.lo, {}).move, RIGHT);
    const upOnly = board([[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [2, 4, 2, 4]]);
    assert.equal(core.choose("corner", upOnly.hi, upOnly.lo, {}).move, UP);
});

test("search bots report the depth they reached and respect maxDepth", () => {
    const b = board([[2, 4, 8, 16], [0, 0, 0, 32], [0, 0, 2, 64], [0, 0, 0, 128]]);
    const mm = core.choose("minimax", b.hi, b.lo, { maxDepth: 2 });
    assert.equal(mm.depth, 2);
    const ex = core.choose("expectimax", b.hi, b.lo, { maxDepth: 2 });
    assert.equal(ex.depth, 2);
    const ex1 = core.choose("expectimax", b.hi, b.lo, { maxDepth: 1 });
    assert.equal(ex1.depth, 1);
});

test("search bots stop near their time budget", () => {
    const b = board([[2, 4, 8, 16], [4, 0, 0, 32], [0, 2, 0, 64], [0, 0, 4, 128]]);
    for (const algo of ["montecarlo", "minimax", "expectimax"]) {
        const t0 = performance.now();
        core.choose(algo, b.hi, b.lo, { budgetMs: 30, maxDepth: 20 }, core.mulberry32(1));
        const ms = performance.now() - t0;
        assert.ok(ms < 400, algo + " took " + ms + "ms for a 30ms budget");
    }
});

test("monte carlo is deterministic with a fixed rollout count and seed", () => {
    const b = board([[2, 2, 4, 0], [0, 8, 0, 0], [0, 0, 0, 0], [0, 0, 0, 2]]);
    const a = core.choose("montecarlo", b.hi, b.lo, { rollouts: 20 }, core.mulberry32(11));
    const c = core.choose("montecarlo", b.hi, b.lo, { rollouts: 20 }, core.mulberry32(11));
    assert.deepEqual(a.evals, c.evals);
    assert.equal(a.nodes, 20 * 4);
});

test("a full game ends on a board with no moves and reports its stats", () => {
    for (const algo of ["random", "greedy", "corner"]) {
        const r = core.playGame(algo, 77, {});
        assert.ok(r.moves > 0);
        assert.ok(r.score > 0);
        assert.equal(core.hasMove(r.hi, r.lo), false);
        assert.equal(r.maxTile, 2 ** core.maxRank(r.hi, r.lo));
    }
    const a = core.playGame("corner", 5, {});
    const b = core.playGame("corner", 5, {});
    assert.equal(a.score, b.score);
    assert.equal(a.moves, b.moves);
});

test("expectimax beats the legacy bots on the same seeds", () => {
    let ex = 0;
    let rnd = 0;
    let greedy = 0;
    for (let seed = 1; seed <= 2; seed++) {
        ex += core.playGame("expectimax", seed, { maxDepth: 2 }).score;
        rnd += core.playGame("random", seed, {}).score;
        greedy += core.playGame("greedy", seed, {}).score;
    }
    assert.ok(ex > greedy * 3, "expectimax " + ex + " vs greedy " + greedy);
    assert.ok(ex > rnd * 3, "expectimax " + ex + " vs random " + rnd);
});

test("worker handler answers ping, think, and bench", () => {
    const out = [];
    const post = (m) => out.push(m);
    core.handle({ type: "ping" }, post);
    const g = core.newGame(core.mulberry32(3));
    core.handle({ type: "think", id: 9, algo: "greedy", hi: g.hi, lo: g.lo, opts: {}, rngSeed: 5 }, post);
    core.handle({ type: "bench", id: 10, algo: "corner", seed: 4, opts: {} }, post);
    assert.equal(out[0].type, "pong");
    assert.equal(out[1].type, "thought");
    assert.equal(out[1].id, 9);
    assert.ok(out[1].move >= 0);
    assert.equal(out[2].type, "benchResult");
    assert.equal(out[2].id, 10);
    assert.ok(out[2].maxTile >= 4);
});
