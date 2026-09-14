# Sightline

Paste a picture of a chess position and get the best move.

`index.html` is the app. Open it inside claude.ai (as a published artifact) and it can
read a pasted screenshot or photo of a board by asking Claude for the position. Anywhere
else, set the position up with the on-page editor or paste a FEN.

## How it works

1. **Reading the board.** The pasted image goes to Claude through the artifact runtime's
   `sample` capability with a strict prompt: eight rows of eight characters, board
   orientation, and side to move if the picture shows it. The reply is converted to FEN,
   validated (one king each, no pawns on the back ranks, the side not to move is not in
   check), and shown on the board so mistakes can be corrected by hand.
2. **Finding the move.** `engine.js` is a self-contained engine, run in a Web Worker:
   - 0x88 board, full legal move generation (castling, en passant, promotions),
     verified by perft against the standard reference positions;
   - iterative deepening with aspiration windows, principal-variation search,
     a 1M-entry transposition table, null-move pruning, reverse futility pruning,
     late-move reductions, check extension, killer and history move ordering;
   - quiescence search with delta pruning;
   - tapered middlegame/endgame evaluation: piece-square tables, bishop pair,
     passed/isolated/doubled pawns, rook open files, king pawn shield, slider mobility.

   It searches about half a million nodes per second in a browser and typically reaches
   depth 12 to 16 with the default three-second think time. Longer think times search deeper.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page markup and styles |
| `app.js` | Board rendering, editor, picture reading, engine wiring |
| `engine.js` | The chess engine (worker, browser global, and Node module) |
| `test/perft.js` | Move-generation and tactics tests |

## Tests

```
node test/perft.js          # perft on 7 reference positions + tactical puzzles (~30 s)
node test/perft.js --deep   # deeper perft counts and slower puzzles
```

## Running locally

Serve the folder over HTTP (the engine worker cannot load from a `file://` URL):

```
python3 -m http.server 8000 --directory chess-engine
```

Then open `http://localhost:8000/`. Picture reading is only available inside claude.ai.
