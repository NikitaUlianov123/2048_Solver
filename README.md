# 2048 Solver Arena

A web page where six algorithms play [2048](https://play2048.co/) side by side. Each board starts from the same seed, so you can see how each algorithm handles the same opening.

Open `index.html` in a browser. No build step and no dependencies.

## Views

- **Arena**: live boards with slide animations, the score, best tile, moves, and think time for each board, and a bar chart of how the algorithm scored each direction for its last move. A score race chart compares all boards move by move.
- **Benchmark**: plays N seeded games per algorithm in background workers. It shows how often each algorithm reaches 512 through 8192, plus average, median, and best scores.
- **Algorithms**: how each algorithm decides, and what to watch for.

## Algorithms

| Algorithm | Idea | Typical best tile |
|---|---|---|
| Random (2022) | Random legal move. The original `StupidBot`. | 64–256 |
| Greedy (2022) | Most merge points this move. The original `ehBot`. | 128–256 |
| Corner | Down, then left, then right, then up. | 128–256 |
| Monte Carlo | Average final score of random games after each move. | 2048–4096 |
| Minimax | Alpha-beta search; the spawn is a worst-case opponent. | 2048–4096 |
| Expectimax | Probability-weighted search with a tuned heuristic. | 4096–8192 |

"Typical best tile" comes from short local runs with a 2–10 ms think time. Run the Benchmark tab for numbers on your computer.

## Engine

The board is a 64-bit value split into two 32-bit words, 4 bits per cell. Moves use precomputed 65,536-entry row tables, and up/down moves transpose the board first. New tiles follow the real game: a 2 with 90% probability, a 4 with 10%. A move that changes nothing is not allowed. The expectimax heuristic follows [nneonneo/2048-ai](https://github.com/nneonneo/2048-ai).

`js/core.js` holds the engine and all bots inside one function. The page turns that function into a Web Worker, so each board thinks in its own thread.

## Tests

```
npm test
```

Needs Node 18 or later. The tests compare the bitboard engine against a simple grid version on thousands of random boards, check spawn odds, game-over detection, and the animation slide plan, and check that every bot plays only legal moves.

## History

The 2022 version was a C# MonoGame app with Selenium control of play2048.co, written before I learned AI techniques. This version keeps the idea and two of the original bots and rewrites the rest for the web.
