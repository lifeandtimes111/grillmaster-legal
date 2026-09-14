// Deeper self-consistency checks for the engine.
// Run: node test/consistency.js
const E = require('../engine.js');
const { Position } = E;
let failed = 0;
const check = (ok, msg) => { if (!ok) { failed++; console.log('FAIL ' + msg); } };

// 1. Incremental Zobrist hash must equal a from-scratch hash after every make,
//    and make/unmake must restore board, hash, rights, ep and king squares.
function snapshot(p) { return JSON.stringify({ b: Array.from(p.board), s: p.side, c: p.castle, e: p.ep, h: p.halfmove, f: p.fullmove, lo: p.hashLo, hi: p.hashHi, k: Array.from(p.kingSq) }); }
let rng = 12345;
const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const STARTS = [
  E.START_FEN,
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
  '3kNr2/pp2bQ2/2p1P2p/6q1/4B1b1/4P3/PPP5/2K2R2 w - - 0 1',
];
let plies = 0;
for (const fen of STARTS) {
  for (let game = 0; game < 40; game++) {
    const p = new Position(fen);
    for (let i = 0; i < 120; i++) {
      const legal = p.legalMoves();
      if (!legal.length) break;
      const before = snapshot(p);
      const m = legal[Math.floor(rand() * legal.length)];
      const san = p.moveToSan(m), uci = p.moveToUci(m);
      check(p.sanToMove(san) === m, `SAN round trip ${san} in ${p.fen()}`);
      check(p.uciToMove(uci) === m, `UCI round trip ${uci} in ${p.fen()}`);
      check(p.make(m), `legal move rejected: ${uci} in ${p.fen()}`);
      plies++;
      const lo = p.hashLo, hi = p.hashHi;
      p.computeHash();
      check(p.hashLo === lo && p.hashHi === hi, `incremental hash mismatch after ${uci} in ${before}`);
      const fenNow = p.fen();
      const reparsed = new Position(fenNow);
      check(reparsed.fen() === fenNow, `FEN round trip ${fenNow}`);
      check(reparsed.hashLo === lo && reparsed.hashHi === hi, `hash differs after FEN round trip ${fenNow}`);
      p.unmake();
      check(snapshot(p) === before, `unmake did not restore state after ${uci} in ${before}`);
      p.make(m);
    }
  }
}
console.log(`ok   make/unmake, hash, SAN and FEN round trips over ${plies} random plies`);

// 2. Evaluation symmetry: mirroring the board and swapping colours must negate the score.
function mirrorFen(fen) {
  const [placement, side, castle, ep, half, full] = fen.split(' ');
  const rows = placement.split('/').reverse().map((r) => r.split('').map((c) => /[a-z]/.test(c) ? c.toUpperCase() : /[A-Z]/.test(c) ? c.toLowerCase() : c).join(''));
  const c = castle === '-' ? '-' : castle.split('').map((x) => /[a-z]/.test(x) ? x.toUpperCase() : x.toLowerCase()).sort((a, b) => 'KQkq'.indexOf(a) - 'KQkq'.indexOf(b)).join('');
  const e = ep === '-' ? '-' : ep[0] + (9 - +ep[1]);
  return `${rows.join('/')} ${side === 'w' ? 'b' : 'w'} ${c} ${e} ${half} ${full}`;
}
let evals = 0;
for (const fen of STARTS) {
  const p = new Position(fen);
  for (let i = 0; i < 60; i++) {
    const a = new Position(p.fen()), b = new Position(mirrorFen(p.fen()));
    check(a.evaluate() === b.evaluate(), `evaluation not symmetric: ${p.fen()} -> ${a.evaluate()} vs mirror ${b.evaluate()}`);
    evals++;
    const legal = p.legalMoves();
    if (!legal.length) break;
    p.make(legal[Math.floor(rand() * legal.length)]);
  }
}
console.log(`ok   evaluation symmetry over ${evals} positions`);

// 3. Search must return a legal move and a legal principal variation, and find
//    the same move from the mirrored position.
const SEARCH_POSITIONS = [
  '3kNr2/pp2bQ2/2p1P2p/6q1/4B1b1/4P3/PPP5/2K2R2 w - - 0 1',
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  '8/8/8/8/8/4k3/4p3/4K3 b - - 0 1',
];
for (const fen of SEARCH_POSITIONS) {
  const p = new Position(fen);
  const r = new E.Search().go(p, { movetime: 3000, depth: 40 });
  check(p.legalMoves().includes(r.bestMove), `best move not legal in ${fen}`);
  let made = 0;
  for (const m of r.pv) { check(p.legalMoves().includes(m), `PV move not legal in ${fen}`); if (!p.make(m)) break; made++; }
  while (made--) p.unmake();
  const q = new Position(mirrorFen(fen));
  const r2 = new E.Search().go(q, { movetime: 3000, depth: 40 });
  const mirrorSan = r.bestSan.replace(/\d/g, (d) => 9 - +d);
  console.log(`ok   ${fen.split(' ')[0]}  ${r.bestSan} (${r.mate !== null ? 'M' + r.mate : r.score})  mirror: ${r2.bestSan} (${r2.mate !== null ? 'M' + r2.mate : r2.score})`);
  const same = r2.bestSan === mirrorSan, bothMate = r.mate !== null && r2.mate !== null, close = Math.abs(r2.score - r.score) < 80;
  const bothWinning = r.score * r2.score > 0 && Math.min(Math.abs(r.score), Math.abs(r2.score)) > 500;
  check(same || bothMate || close || bothWinning || (r.mate !== null && Math.abs(r2.score) > 500) || (r2.mate !== null && Math.abs(r.score) > 500), `mirror search disagrees for ${fen}: ${r.bestSan} vs ${r2.bestSan}`);
}

// 4. Endgame technique: king and rook (and king and queen) against a bare king
//    must be converted to checkmate in self-play well inside the fifty-move rule.
for (const [name, fen] of [['KR vs K', '7k/8/8/8/8/8/8/R6K w - - 0 1'], ['KQ vs K', '8/8/3k4/8/8/8/8/Q6K w - - 0 1']]) {
  const p = new Position(fen);
  const s = new E.Search();
  let moves = 0, status = p.status();
  while (status !== 'checkmate' && moves < 120) {
    const r = s.go(p, { movetime: 250, depth: 40 });
    p.make(r.bestMove); moves++;
    status = p.status();
    if (status === 'stalemate' || status === 'fifty-move' || status === 'insufficient') break;
  }
  check(status === 'checkmate', `${name}: self-play ended in ${status} after ${moves} plies`);
  console.log(`${status === 'checkmate' ? 'ok  ' : 'FAIL'} ${name}: mate in ${Math.ceil(moves / 2)} moves of self-play (${status})`);
}
console.log(failed ? `\n${failed} FAILURE(S)` : '\nall consistency checks passed');
process.exit(failed ? 1 : 0);
