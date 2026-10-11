# 2048_Solver

Bots that play [2048](https://play2048.co/), written in C# with MonoGame (2022). This is an old project, from before I learned AI techniques.

## What's here

- **GameLibrary**: the 2048 board logic and the bots.
  - `StupidBot`: alternates simple up and down moves.
  - `ehBot`: tries each direction and takes the move that scores the most points.
  - `MovementBot`: plays a given move.
- Bots can play a local copy of the game, or connect to play2048.co and play in Chrome through Selenium.
- **2048_Solver**: a MonoGame window that draws the board and tracks each bot's score and high score.
