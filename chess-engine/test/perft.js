// Move-generation correctness (perft) and search sanity tests.
// Run: node test/perft.js            (fast set)
//      node test/perft.js --deep     (adds slower depths)
const E = require('../engine.js');
const deep = process.argv.includes('--deep');

const PERFT = [
  ['startpos', E.START_FEN, [20, 400, 8902, 197281, 4865609]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862, 4085603]],
  ['pos3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624]],
  ['pos4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333]],
  ['pos4-mirror', 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1', [6, 264, 9467, 422333]],
  ['pos5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379, 2103487]],
  ['pos6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890, 3894594]],
];
let failed = 0;
for (const [name, fen, counts] of PERFT) {
  const pos = new E.Position(fen);
  if (pos.fen() !== fen) { console.log(`FEN round-trip mismatch for ${name}:\n  ${pos.fen()}\n  ${fen}`); failed++; }
  const maxDepth = deep ? counts.length : Math.min(counts.length, name === 'startpos' ? 4 : 3);
  for (let d = 1; d <= maxDepth; d++) {
    const t = Date.now();
    const n = E.perft(pos, d);
    const ok = n === counts[d - 1];
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(12)} depth ${d}: ${n}${ok ? '' : ' (expected ' + counts[d - 1] + ')'}  ${Date.now() - t}ms`);
  }
}

// Search sanity: well-known tactics. [fen, expected best move(s) in SAN]
const TACTICS = [
  ['mate in 1', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', ['Ra8#']],
  ['queen sac mate in 2', 'r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1', ['Nf6+']],
  ['smothered mate in 2', '6rk/6pp/8/6N1/8/8/8/6RK w - - 0 1', ['Nf7#']],
  ['Legal trap (mate in 3)', 'r2qkbnr/ppp2ppp/2np4/4N3/2B1P1b1/8/PPPP1PPP/RNBQK2R w KQkq - 0 1', ['Bxf7+', 'Nxg4']],
  ['WAC.001', '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', ['Qg6']],
  ['WAC.003', '5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1', ['Rg3']],
  ['WAC.004', 'r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1', ['Qxh7+']],
  ['WAC.005', '5k2/6pp/p1qN4/1p1p4/3P4/2PKP2Q/PP3r2/3R4 b - - 0 1', ['Qc4+']],
  ['WAC.007', 'rnbqkb1r/pppp1ppp/8/4P3/6n1/7P/PPPNPPP1/R1BQKBNR b KQkq - 0 1', ['Ne3']],
  ['WAC.008', 'r4q1k/p2bR1rp/2p2Q1N/5p2/5p2/2P5/PP3PPP/R5K1 w - - 0 1', ['Rf7']],
];
// Slower positions that need deeper search (about 8 s each); run with --deep.
const DEEP_TACTICS = [
  ['WAC.002', '8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1', ['Rxb2']],
];
if (deep) TACTICS.push(...DEEP_TACTICS);
const search = new E.Search();
for (const [name, fen, expected] of TACTICS) {
  const pos = new E.Position(fen);
  search.clearTables();
  const r = search.go(pos, { movetime: DEEP_TACTICS.some((t) => t[0] === name) ? 10000 : 2000, depth: 30 });
  const ok = expected.includes(r.bestSan);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(24)} ${r.bestSan.padEnd(6)} depth ${r.depth} score ${r.mate !== null ? 'M' + r.mate : r.score} nodes ${r.nodes} (${Math.round(r.nodes / Math.max(1, r.time))}k nps)  pv ${r.pvSan.join(' ')}`);
}
console.log(failed ? `\n${failed} FAILURE(S)` : '\nall tests passed');
process.exit(failed ? 1 : 0);
