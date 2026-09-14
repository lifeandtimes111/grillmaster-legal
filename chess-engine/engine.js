/*
 * Sightline chess engine
 * Self-contained JavaScript chess engine: 0x88 board, full legal move
 * generation, iterative-deepening principal-variation search with a
 * transposition table, null-move pruning, late-move reductions, killer and
 * history ordering, quiescence search, and a tapered piece-square evaluation.
 *
 * Runs in three places with the same file:
 *   - a Web Worker      (postMessage {type:'go'|'stop'} protocol, see bottom)
 *   - a browser window  (window.SightlineEngine)
 *   - Node              (module.exports), used by test/perft.js
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SightlineEngine = api;
  if (typeof importScripts === 'function' && typeof onmessage !== 'undefined') api.installWorker(root);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- pieces
  const EMPTY = 0;
  const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  const WHITE = 0, BLACK = 8;
  const typeOf = (p) => p & 7;
  const colorOf = (p) => p & 8;
  const PIECE_CHARS = { 1: 'P', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K', 9: 'p', 10: 'n', 11: 'b', 12: 'r', 13: 'q', 14: 'k' };
  const CHAR_PIECES = {};
  for (const k in PIECE_CHARS) CHAR_PIECES[PIECE_CHARS[k]] = +k;

  // --------------------------------------------------------------- squares
  // 0x88: square = rank * 16 + file; (sq & 0x88) !== 0 means off-board.
  const sq = (file, rank) => rank * 16 + file;
  const fileOf = (s) => s & 7;
  const rankOf = (s) => s >> 4;
  const sq64 = (s) => rankOf(s) * 8 + fileOf(s);          // a1 = 0 ... h8 = 63
  const algebraic = (s) => 'abcdefgh'[fileOf(s)] + (rankOf(s) + 1);
  const parseSquare = (str) => sq(str.charCodeAt(0) - 97, str.charCodeAt(1) - 49);

  const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
  const BISHOP_OFFSETS = [-17, -15, 15, 17];
  const ROOK_OFFSETS = [-16, -1, 1, 16];
  const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];

  // castling rights bits
  const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;
  // rights removed when a piece moves from / captures on a square
  const CASTLE_MASK = new Uint8Array(128).fill(15);
  CASTLE_MASK[sq(4, 0)] = 15 & ~(CASTLE_WK | CASTLE_WQ);
  CASTLE_MASK[sq(0, 0)] = 15 & ~CASTLE_WQ;
  CASTLE_MASK[sq(7, 0)] = 15 & ~CASTLE_WK;
  CASTLE_MASK[sq(4, 7)] = 15 & ~(CASTLE_BK | CASTLE_BQ);
  CASTLE_MASK[sq(0, 7)] = 15 & ~CASTLE_BQ;
  CASTLE_MASK[sq(7, 7)] = 15 & ~CASTLE_BK;

  // ----------------------------------------------------------------- moves
  // move = from | to << 7 | promo << 14 | flags << 17
  const FLAG_CAPTURE = 1, FLAG_DOUBLE = 2, FLAG_EP = 4, FLAG_CASTLE = 8;
  const mkMove = (from, to, promo, flags) => from | (to << 7) | (promo << 14) | (flags << 17);
  const moveFrom = (m) => m & 127;
  const moveTo = (m) => (m >> 7) & 127;
  const movePromo = (m) => (m >> 14) & 7;
  const moveFlags = (m) => (m >> 17) & 15;

  // --------------------------------------------------------------- zobrist
  // Two independent 32-bit keys give a 64-bit identity for the TT / repetition table.
  function xorshift(seed) {
    let x = seed | 0;
    return function () {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      return x | 0;
    };
  }
  const rngLo = xorshift(0x9E3779B9), rngHi = xorshift(0x7F4A7C15);
  const Z_PIECE_LO = new Int32Array(16 * 128), Z_PIECE_HI = new Int32Array(16 * 128);
  const Z_CASTLE_LO = new Int32Array(16), Z_CASTLE_HI = new Int32Array(16);
  const Z_EP_LO = new Int32Array(8), Z_EP_HI = new Int32Array(8);
  for (let i = 0; i < Z_PIECE_LO.length; i++) { Z_PIECE_LO[i] = rngLo(); Z_PIECE_HI[i] = rngHi(); }
  for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = rngLo(); Z_CASTLE_HI[i] = rngHi(); }
  for (let i = 0; i < 8; i++) { Z_EP_LO[i] = rngLo(); Z_EP_HI[i] = rngHi(); }
  const Z_SIDE_LO = rngLo(), Z_SIDE_HI = rngHi();

  // ------------------------------------------------------------ evaluation
  // Tapered evaluation: middlegame and endgame piece-square tables, blended by
  // the amount of non-pawn material left on the board.
  const MG_VALUE = [0, 82, 337, 365, 477, 1025, 0];
  const EG_VALUE = [0, 94, 281, 297, 512, 936, 0];
  const PHASE_INC = [0, 0, 1, 1, 2, 4, 0];
  const TOTAL_PHASE = 24;

  // Tables are written from White's point of view, rank 8 first (as a diagram reads).
  const MG_PST = {
    [PAWN]: [
      0, 0, 0, 0, 0, 0, 0, 0,
      98, 134, 61, 95, 68, 126, 34, -11,
      -6, 7, 26, 31, 65, 56, 25, -20,
      -14, 13, 6, 21, 23, 12, 17, -23,
      -27, -2, -5, 12, 17, 6, 10, -25,
      -26, -4, -4, -10, 3, 3, 33, -12,
      -35, -1, -20, -23, -15, 24, 38, -22,
      0, 0, 0, 0, 0, 0, 0, 0],
    [KNIGHT]: [
      -167, -89, -34, -49, 61, -97, -15, -107,
      -73, -41, 72, 36, 23, 62, 7, -17,
      -47, 60, 37, 65, 84, 129, 73, 44,
      -9, 17, 19, 53, 37, 69, 18, 22,
      -13, 4, 16, 13, 28, 19, 21, -8,
      -23, -9, 12, 10, 19, 17, 25, -16,
      -29, -53, -12, -3, -1, 18, -14, -19,
      -105, -21, -58, -33, -17, -28, -19, -23],
    [BISHOP]: [
      -29, 4, -82, -37, -25, -42, 7, -8,
      -26, 16, -18, -13, 30, 59, 18, -47,
      -16, 37, 43, 40, 35, 50, 37, -2,
      -4, 5, 19, 50, 37, 37, 7, -2,
      -6, 13, 13, 26, 34, 12, 10, 4,
      0, 15, 15, 15, 14, 27, 18, 10,
      4, 15, 16, 0, 7, 21, 33, 1,
      -33, -3, -14, -21, -13, -12, -39, -21],
    [ROOK]: [
      32, 42, 32, 51, 63, 9, 31, 43,
      27, 32, 58, 62, 80, 67, 26, 44,
      -5, 19, 26, 36, 17, 45, 61, 16,
      -24, -11, 7, 26, 24, 35, -8, -20,
      -36, -26, -12, -1, 9, -7, 6, -23,
      -45, -25, -16, -17, 3, 0, -5, -33,
      -44, -16, -20, -9, -1, 11, -6, -71,
      -19, -13, 1, 17, 16, 7, -37, -26],
    [QUEEN]: [
      -28, 0, 29, 12, 59, 44, 43, 45,
      -24, -39, -5, 1, -16, 57, 28, 54,
      -13, -17, 7, 8, 29, 56, 47, 57,
      -27, -27, -16, -16, -1, 17, -2, 1,
      -9, -26, -9, -10, -2, -4, 3, -3,
      -14, 2, -11, -2, -5, 2, 14, 5,
      -35, -8, 11, 2, 8, 15, -3, 1,
      -1, -18, -9, 10, -15, -25, -31, -50],
    [KING]: [
      -65, 23, 16, -15, -56, -34, 2, 13,
      29, -1, -20, -7, -8, -4, -38, -29,
      -9, 24, 2, -16, -20, 6, 22, -22,
      -17, -20, -12, -27, -30, -25, -14, -36,
      -49, -1, -27, -39, -46, -44, -33, -51,
      -14, -14, -22, -46, -44, -30, -15, -27,
      1, 7, -8, -64, -43, -16, 9, 8,
      -15, 36, 12, -54, 8, -28, 24, 14],
  };
  const EG_PST = {
    [PAWN]: [
      0, 0, 0, 0, 0, 0, 0, 0,
      178, 173, 158, 134, 147, 132, 165, 187,
      94, 100, 85, 67, 56, 53, 82, 84,
      32, 24, 13, 5, -2, 4, 17, 17,
      13, 9, -3, -7, -7, -8, 3, -1,
      4, 7, -6, 1, 0, -5, -1, -8,
      13, 8, 8, 10, 13, 0, 2, -7,
      0, 0, 0, 0, 0, 0, 0, 0],
    [KNIGHT]: [
      -58, -38, -13, -28, -31, -27, -63, -99,
      -25, -8, -25, -2, -9, -25, -24, -52,
      -24, -20, 10, 9, -1, -9, -19, -41,
      -17, 3, 22, 22, 22, 11, 8, -18,
      -18, -6, 16, 25, 16, 17, 4, -18,
      -23, -3, -1, 15, 10, -3, -20, -22,
      -42, -20, -10, -5, -2, -20, -23, -44,
      -29, -51, -23, -15, -22, -18, -50, -64],
    [BISHOP]: [
      -14, -21, -11, -8, -7, -9, -17, -24,
      -8, -4, 7, -12, -3, -13, -4, -14,
      2, -8, 0, -1, -2, 6, 0, 4,
      -3, 9, 12, 9, 14, 10, 3, 2,
      -6, 3, 13, 19, 7, 10, -3, -9,
      -12, -3, 8, 10, 13, 3, -7, -15,
      -14, -18, -7, -1, 4, -9, -15, -27,
      -23, -9, -23, -5, -9, -16, -5, -17],
    [ROOK]: [
      13, 10, 18, 15, 12, 12, 8, 5,
      11, 13, 13, 11, -3, 3, 8, 3,
      7, 7, 7, 5, 4, -3, -5, -3,
      4, 3, 13, 1, 2, 1, -1, 2,
      3, 5, 8, 4, -5, -6, -8, -11,
      -4, 0, -5, -1, -7, -12, -8, -16,
      -6, -6, 0, 2, -9, -9, -11, -3,
      -9, 2, 3, -1, -5, -13, 4, -20],
    [QUEEN]: [
      -9, 22, 22, 27, 27, 19, 10, 20,
      -17, 20, 32, 41, 58, 25, 30, 0,
      -20, 6, 9, 49, 47, 35, 19, 9,
      3, 22, 24, 45, 57, 40, 57, 36,
      -18, 28, 19, 47, 31, 34, 39, 23,
      -16, -27, 15, 6, 9, 17, 10, 5,
      -22, -23, -30, -16, -16, -23, -36, -32,
      -33, -28, -22, -43, -5, -32, -20, -41],
    [KING]: [
      -74, -35, -18, -18, -11, 15, 4, -17,
      -12, 17, 14, 17, 17, 38, 23, 11,
      10, 17, 23, 15, 20, 45, 44, 13,
      -8, 22, 24, 27, 26, 33, 26, 3,
      -18, -4, 21, 24, 27, 23, 9, -11,
      -19, -3, 11, 21, 23, 16, 7, -9,
      -27, -11, 4, 13, 14, 4, -5, -17,
      -53, -34, -21, -11, -28, -14, -24, -43],
  };
  // Pre-flatten into [piece][sq64] with a1 = 0 for white; black mirrors ranks.
  const MG_TABLE = [], EG_TABLE = [];
  for (let p = 0; p < 16; p++) { MG_TABLE[p] = new Int16Array(64); EG_TABLE[p] = new Int16Array(64); }
  for (let t = PAWN; t <= KING; t++) {
    for (let s = 0; s < 64; s++) {
      const file = s & 7, rank = s >> 3;                 // rank 0 = rank 1
      const diagramIdx = (7 - rank) * 8 + file;          // table row 0 = rank 8
      MG_TABLE[WHITE | t][s] = MG_VALUE[t] + MG_PST[t][diagramIdx];
      EG_TABLE[WHITE | t][s] = EG_VALUE[t] + EG_PST[t][diagramIdx];
      const blackDiagramIdx = rank * 8 + file;           // mirrored vertically
      MG_TABLE[BLACK | t][s] = MG_VALUE[t] + MG_PST[t][blackDiagramIdx];
      EG_TABLE[BLACK | t][s] = EG_VALUE[t] + EG_PST[t][blackDiagramIdx];
    }
  }
  const PASSED_BONUS_MG = [0, 5, 10, 20, 35, 60, 90, 0];   // by relative rank
  const PASSED_BONUS_EG = [0, 10, 20, 35, 60, 100, 150, 0];
  const ISOLATED_PENALTY = 12, DOUBLED_PENALTY = 14;
  const BISHOP_PAIR_MG = 25, BISHOP_PAIR_EG = 45;
  const ROOK_OPEN_FILE = 22, ROOK_SEMI_OPEN = 10;
  const KING_SHIELD = 9;
  // scratch space for evaluate(), allocated once
  const EV = { wPawnFiles: new Uint8Array(8), bPawnFiles: new Uint8Array(8), wPawns: new Int8Array(16), bPawns: new Int8Array(16), wRooks: new Int8Array(16), bRooks: new Int8Array(16) };

  // ------------------------------------------------------------- constants
  const MAX_PLY = 128;
  const MATE = 30000;
  const MATE_IN_MAX = MATE - MAX_PLY;
  const INFINITY = 32000;
  const TT_SIZE = 1 << 20;   // entries
  const TT_EXACT = 1, TT_ALPHA = 2, TT_BETA = 3;

  // ================================================================ Position
  class Position {
    constructor(fen) {
      this.board = new Int8Array(128);
      this.side = WHITE;
      this.castle = 0;
      this.ep = -1;
      this.halfmove = 0;
      this.fullmove = 1;
      this.hashLo = 0; this.hashHi = 0;
      this.kingSq = new Int8Array(16);   // indexed by color
      // undo stack (indexed by ply)
      this.ply = 0;
      this.uMove = new Int32Array(1024);
      this.uCaptured = new Int8Array(1024);
      this.uCastle = new Int8Array(1024);
      this.uEp = new Int16Array(1024);
      this.uHalf = new Int16Array(1024);
      this.uHashLo = new Int32Array(1024);
      this.uHashHi = new Int32Array(1024);
      this.histLo = new Int32Array(1024);  // position hashes along the played line, for repetition
      this.histHi = new Int32Array(1024);
      this.setFen(fen || START_FEN);
    }

    // ------------------------------------------------------------- FEN I/O
    setFen(fen) {
      const parts = fen.trim().split(/\s+/);
      if (parts.length < 2) throw new Error('FEN needs at least placement and side to move');
      this.board.fill(EMPTY);
      const rows = parts[0].split('/');
      if (rows.length !== 8) throw new Error('FEN placement must have 8 ranks');
      for (let r = 0; r < 8; r++) {
        let file = 0;
        for (const ch of rows[r]) {
          if (ch >= '1' && ch <= '8') file += +ch;
          else if (CHAR_PIECES[ch]) { if (file > 7) throw new Error('Too many squares on rank ' + (8 - r)); this.board[sq(file, 7 - r)] = CHAR_PIECES[ch]; file++; }
          else throw new Error('Unknown FEN character "' + ch + '"');
        }
        if (file !== 8) throw new Error('Rank ' + (8 - r) + ' does not have 8 squares');
      }
      this.side = parts[1] === 'b' ? BLACK : WHITE;
      this.castle = 0;
      const c = parts[2] || '-';
      if (c.includes('K')) this.castle |= CASTLE_WK;
      if (c.includes('Q')) this.castle |= CASTLE_WQ;
      if (c.includes('k')) this.castle |= CASTLE_BK;
      if (c.includes('q')) this.castle |= CASTLE_BQ;
      // drop rights whose king / rook are not home
      if (this.board[sq(4, 0)] !== (WHITE | KING)) this.castle &= ~(CASTLE_WK | CASTLE_WQ);
      if (this.board[sq(7, 0)] !== (WHITE | ROOK)) this.castle &= ~CASTLE_WK;
      if (this.board[sq(0, 0)] !== (WHITE | ROOK)) this.castle &= ~CASTLE_WQ;
      if (this.board[sq(4, 7)] !== (BLACK | KING)) this.castle &= ~(CASTLE_BK | CASTLE_BQ);
      if (this.board[sq(7, 7)] !== (BLACK | ROOK)) this.castle &= ~CASTLE_BK;
      if (this.board[sq(0, 7)] !== (BLACK | ROOK)) this.castle &= ~CASTLE_BQ;
      this.ep = -1;
      if (parts[3] && parts[3] !== '-' && /^[a-h][36]$/.test(parts[3])) {
        const e = parseSquare(parts[3]);
        // only keep it if a capture is actually possible
        const dir = this.side === WHITE ? -16 : 16;
        const pawn = this.side | PAWN;
        if (((e + dir - 1) & 0x88) === 0 && this.board[e + dir - 1] === pawn) this.ep = e;
        if (((e + dir + 1) & 0x88) === 0 && this.board[e + dir + 1] === pawn) this.ep = e;
      }
      this.halfmove = parts[4] ? Math.max(0, parseInt(parts[4], 10) || 0) : 0;
      this.fullmove = parts[5] ? Math.max(1, parseInt(parts[5], 10) || 1) : 1;
      this.kingSq[WHITE] = -1; this.kingSq[BLACK] = -1;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) continue;
        if (typeOf(this.board[s]) === KING) this.kingSq[colorOf(this.board[s])] = s;
      }
      this.ply = 0;
      this.computeHash();
      this.histLo[0] = this.hashLo; this.histHi[0] = this.hashHi;
    }

    fen() {
      let out = '';
      for (let r = 7; r >= 0; r--) {
        let empty = 0;
        for (let f = 0; f < 8; f++) {
          const p = this.board[sq(f, r)];
          if (p === EMPTY) { empty++; continue; }
          if (empty) { out += empty; empty = 0; }
          out += PIECE_CHARS[p];
        }
        if (empty) out += empty;
        if (r) out += '/';
      }
      let c = '';
      if (this.castle & CASTLE_WK) c += 'K';
      if (this.castle & CASTLE_WQ) c += 'Q';
      if (this.castle & CASTLE_BK) c += 'k';
      if (this.castle & CASTLE_BQ) c += 'q';
      return out + ' ' + (this.side === WHITE ? 'w' : 'b') + ' ' + (c || '-') + ' ' +
        (this.ep >= 0 ? algebraic(this.ep) : '-') + ' ' + this.halfmove + ' ' + this.fullmove;
    }

    computeHash() {
      let lo = 0, hi = 0;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) continue;
        const p = this.board[s];
        if (p) { lo ^= Z_PIECE_LO[p * 128 + s]; hi ^= Z_PIECE_HI[p * 128 + s]; }
      }
      lo ^= Z_CASTLE_LO[this.castle]; hi ^= Z_CASTLE_HI[this.castle];
      if (this.ep >= 0) { lo ^= Z_EP_LO[fileOf(this.ep)]; hi ^= Z_EP_HI[fileOf(this.ep)]; }
      if (this.side === BLACK) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
      this.hashLo = lo; this.hashHi = hi;
    }

    // ------------------------------------------------------------ attacks
    isAttacked(s, byColor) {
      const b = this.board;
      // pawns
      if (byColor === WHITE) {
        if (((s - 15) & 0x88) === 0 && b[s - 15] === (WHITE | PAWN)) return true;
        if (((s - 17) & 0x88) === 0 && b[s - 17] === (WHITE | PAWN)) return true;
      } else {
        if (((s + 15) & 0x88) === 0 && b[s + 15] === (BLACK | PAWN)) return true;
        if (((s + 17) & 0x88) === 0 && b[s + 17] === (BLACK | PAWN)) return true;
      }
      const knight = byColor | KNIGHT, king = byColor | KING;
      for (let i = 0; i < 8; i++) {
        const t = s + KNIGHT_OFFSETS[i];
        if ((t & 0x88) === 0 && b[t] === knight) return true;
        const k = s + KING_OFFSETS[i];
        if ((k & 0x88) === 0 && b[k] === king) return true;
      }
      const bishop = byColor | BISHOP, rook = byColor | ROOK, queen = byColor | QUEEN;
      for (let i = 0; i < 4; i++) {
        const d = BISHOP_OFFSETS[i];
        for (let t = s + d; (t & 0x88) === 0; t += d) {
          const p = b[t];
          if (p) { if (p === bishop || p === queen) return true; break; }
        }
        const e = ROOK_OFFSETS[i];
        for (let t = s + e; (t & 0x88) === 0; t += e) {
          const p = b[t];
          if (p) { if (p === rook || p === queen) return true; break; }
        }
      }
      return false;
    }

    inCheck() { return this.isAttacked(this.kingSq[this.side], this.side ^ 8); }

    // --------------------------------------------------------- generation
    // Appends pseudo-legal moves to `out` (a plain array). capturesOnly also
    // includes queen promotions.
    generate(out, capturesOnly) {
      const b = this.board, side = this.side, them = side ^ 8;
      const push = (from, to, promo, flags) => { out.push(mkMove(from, to, promo, flags)); };
      for (let from = 0; from < 128; from++) {
        if (from & 0x88) { from += 7; continue; }
        const p = b[from];
        if (!p || colorOf(p) !== side) continue;
        const t = typeOf(p);
        if (t === PAWN) {
          const dir = side === WHITE ? 16 : -16;
          const startRank = side === WHITE ? 1 : 6;
          const promoRank = side === WHITE ? 7 : 0;
          const to = from + dir;
          if ((to & 0x88) === 0 && !b[to]) {
            if (rankOf(to) === promoRank) {
              push(from, to, QUEEN, 0);
              if (!capturesOnly) { push(from, to, KNIGHT, 0); push(from, to, ROOK, 0); push(from, to, BISHOP, 0); }
            } else if (!capturesOnly) {
              push(from, to, 0, 0);
              if (rankOf(from) === startRank && !b[to + dir]) push(from, to + dir, 0, FLAG_DOUBLE);
            }
          }
          for (let k = 0; k < 2; k++) {
            const c = from + dir + (k ? 1 : -1);
            if (c & 0x88) continue;
            const q = b[c];
            if (q && colorOf(q) === them) {
              if (rankOf(c) === promoRank) {
                push(from, c, QUEEN, FLAG_CAPTURE);
                if (!capturesOnly) { push(from, c, KNIGHT, FLAG_CAPTURE); push(from, c, ROOK, FLAG_CAPTURE); push(from, c, BISHOP, FLAG_CAPTURE); }
              } else push(from, c, 0, FLAG_CAPTURE);
            } else if (c === this.ep) push(from, c, 0, FLAG_CAPTURE | FLAG_EP);
          }
        } else if (t === KNIGHT || t === KING) {
          const offs = t === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
          for (let i = 0; i < 8; i++) {
            const to = from + offs[i];
            if (to & 0x88) continue;
            const q = b[to];
            if (!q) { if (!capturesOnly) push(from, to, 0, 0); }
            else if (colorOf(q) === them) push(from, to, 0, FLAG_CAPTURE);
          }
        } else {
          const offs = t === BISHOP ? BISHOP_OFFSETS : t === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
          for (let i = 0; i < offs.length; i++) {
            const d = offs[i];
            for (let to = from + d; (to & 0x88) === 0; to += d) {
              const q = b[to];
              if (!q) { if (!capturesOnly) push(from, to, 0, 0); continue; }
              if (colorOf(q) === them) push(from, to, 0, FLAG_CAPTURE);
              break;
            }
          }
        }
      }
      if (!capturesOnly) {
        const k = this.kingSq[side];
        if (side === WHITE) {
          if ((this.castle & CASTLE_WK) && !b[sq(5, 0)] && !b[sq(6, 0)] &&
            !this.isAttacked(k, them) && !this.isAttacked(sq(5, 0), them) && !this.isAttacked(sq(6, 0), them)) push(k, sq(6, 0), 0, FLAG_CASTLE);
          if ((this.castle & CASTLE_WQ) && !b[sq(3, 0)] && !b[sq(2, 0)] && !b[sq(1, 0)] &&
            !this.isAttacked(k, them) && !this.isAttacked(sq(3, 0), them) && !this.isAttacked(sq(2, 0), them)) push(k, sq(2, 0), 0, FLAG_CASTLE);
        } else {
          if ((this.castle & CASTLE_BK) && !b[sq(5, 7)] && !b[sq(6, 7)] &&
            !this.isAttacked(k, them) && !this.isAttacked(sq(5, 7), them) && !this.isAttacked(sq(6, 7), them)) push(k, sq(6, 7), 0, FLAG_CASTLE);
          if ((this.castle & CASTLE_BQ) && !b[sq(3, 7)] && !b[sq(2, 7)] && !b[sq(1, 7)] &&
            !this.isAttacked(k, them) && !this.isAttacked(sq(3, 7), them) && !this.isAttacked(sq(2, 7), them)) push(k, sq(2, 7), 0, FLAG_CASTLE);
        }
      }
      return out;
    }

    legalMoves() {
      const pseudo = this.generate([], false), legal = [];
      for (const m of pseudo) {
        if (this.make(m)) { legal.push(m); this.unmake(); }
      }
      return legal;
    }

    // ------------------------------------------------------- make / unmake
    // Returns false (and undoes) if the move leaves own king in check.
    make(m) {
      const b = this.board, side = this.side, ply = this.ply;
      const from = moveFrom(m), to = moveTo(m), promo = movePromo(m), flags = moveFlags(m);
      const piece = b[from];
      let captured = b[to];
      this.uMove[ply] = m; this.uCastle[ply] = this.castle; this.uEp[ply] = this.ep;
      this.uHalf[ply] = this.halfmove; this.uHashLo[ply] = this.hashLo; this.uHashHi[ply] = this.hashHi;
      let lo = this.hashLo, hi = this.hashHi;
      if (this.ep >= 0) { lo ^= Z_EP_LO[fileOf(this.ep)]; hi ^= Z_EP_HI[fileOf(this.ep)]; }
      this.ep = -1;
      this.halfmove++;
      if (flags & FLAG_EP) {
        const capSq = to + (side === WHITE ? -16 : 16);
        captured = b[capSq];
        b[capSq] = EMPTY;
        lo ^= Z_PIECE_LO[captured * 128 + capSq]; hi ^= Z_PIECE_HI[captured * 128 + capSq];
      } else if (captured) {
        lo ^= Z_PIECE_LO[captured * 128 + to]; hi ^= Z_PIECE_HI[captured * 128 + to];
      }
      this.uCaptured[ply] = captured;
      if (captured || typeOf(piece) === PAWN) this.halfmove = 0;
      // move the piece
      b[from] = EMPTY;
      lo ^= Z_PIECE_LO[piece * 128 + from]; hi ^= Z_PIECE_HI[piece * 128 + from];
      const placed = promo ? (side | promo) : piece;
      b[to] = placed;
      lo ^= Z_PIECE_LO[placed * 128 + to]; hi ^= Z_PIECE_HI[placed * 128 + to];
      if (typeOf(piece) === KING) this.kingSq[side] = to;
      if (flags & FLAG_CASTLE) {
        let rFrom, rTo;
        if (to === sq(6, 0)) { rFrom = sq(7, 0); rTo = sq(5, 0); }
        else if (to === sq(2, 0)) { rFrom = sq(0, 0); rTo = sq(3, 0); }
        else if (to === sq(6, 7)) { rFrom = sq(7, 7); rTo = sq(5, 7); }
        else { rFrom = sq(0, 7); rTo = sq(3, 7); }
        const rook = b[rFrom];
        b[rFrom] = EMPTY; b[rTo] = rook;
        lo ^= Z_PIECE_LO[rook * 128 + rFrom] ^ Z_PIECE_LO[rook * 128 + rTo];
        hi ^= Z_PIECE_HI[rook * 128 + rFrom] ^ Z_PIECE_HI[rook * 128 + rTo];
      }
      if (flags & FLAG_DOUBLE) {
        const epSq = from + (side === WHITE ? 16 : -16);
        // only record if an enemy pawn could capture (keeps hashes canonical)
        const them = side ^ 8, ep = them | PAWN;
        if ((((to - 1) & 0x88) === 0 && b[to - 1] === ep) || (((to + 1) & 0x88) === 0 && b[to + 1] === ep)) {
          this.ep = epSq; lo ^= Z_EP_LO[fileOf(epSq)]; hi ^= Z_EP_HI[fileOf(epSq)];
        }
      }
      const newCastle = this.castle & CASTLE_MASK[from] & CASTLE_MASK[to];
      if (newCastle !== this.castle) {
        lo ^= Z_CASTLE_LO[this.castle] ^ Z_CASTLE_LO[newCastle];
        hi ^= Z_CASTLE_HI[this.castle] ^ Z_CASTLE_HI[newCastle];
        this.castle = newCastle;
      }
      this.side = side ^ 8;
      lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI;
      this.hashLo = lo; this.hashHi = hi;
      this.ply = ply + 1;
      this.histLo[this.ply] = lo; this.histHi[this.ply] = hi;
      if (side === BLACK) this.fullmove++;
      if (this.isAttacked(this.kingSq[side], side ^ 8)) { this.unmake(); return false; }
      return true;
    }

    unmake() {
      const ply = --this.ply;
      const m = this.uMove[ply], b = this.board;
      const from = moveFrom(m), to = moveTo(m), promo = movePromo(m), flags = moveFlags(m);
      this.side ^= 8;
      const side = this.side;
      if (side === BLACK) this.fullmove--;
      const piece = promo ? (side | PAWN) : b[to];
      b[from] = piece;
      b[to] = EMPTY;
      if (typeOf(piece) === KING) this.kingSq[side] = from;
      const captured = this.uCaptured[ply];
      if (flags & FLAG_EP) b[to + (side === WHITE ? -16 : 16)] = captured;
      else if (captured) b[to] = captured;
      if (flags & FLAG_CASTLE) {
        if (to === sq(6, 0)) { b[sq(7, 0)] = b[sq(5, 0)]; b[sq(5, 0)] = EMPTY; }
        else if (to === sq(2, 0)) { b[sq(0, 0)] = b[sq(3, 0)]; b[sq(3, 0)] = EMPTY; }
        else if (to === sq(6, 7)) { b[sq(7, 7)] = b[sq(5, 7)]; b[sq(5, 7)] = EMPTY; }
        else { b[sq(0, 7)] = b[sq(3, 7)]; b[sq(3, 7)] = EMPTY; }
      }
      this.castle = this.uCastle[ply]; this.ep = this.uEp[ply]; this.halfmove = this.uHalf[ply];
      this.hashLo = this.uHashLo[ply]; this.hashHi = this.uHashHi[ply];
    }

    makeNull() {
      const ply = this.ply;
      this.uMove[ply] = 0; this.uCastle[ply] = this.castle; this.uEp[ply] = this.ep;
      this.uHalf[ply] = this.halfmove; this.uHashLo[ply] = this.hashLo; this.uHashHi[ply] = this.hashHi;
      this.uCaptured[ply] = 0;
      if (this.ep >= 0) { this.hashLo ^= Z_EP_LO[fileOf(this.ep)]; this.hashHi ^= Z_EP_HI[fileOf(this.ep)]; }
      this.ep = -1;
      this.side ^= 8;
      this.hashLo ^= Z_SIDE_LO; this.hashHi ^= Z_SIDE_HI;
      this.ply = ply + 1;
      this.histLo[this.ply] = this.hashLo; this.histHi[this.ply] = this.hashHi;
    }
    unmakeNull() {
      const ply = --this.ply;
      this.side ^= 8;
      this.castle = this.uCastle[ply]; this.ep = this.uEp[ply]; this.halfmove = this.uHalf[ply];
      this.hashLo = this.uHashLo[ply]; this.hashHi = this.uHashHi[ply];
    }

    // Has this exact position occurred earlier on the current line?
    isRepetition() {
      const end = this.ply - this.halfmove;
      for (let i = this.ply - 2; i >= end && i >= 0; i -= 2) {
        if (this.histLo[i] === this.hashLo && this.histHi[i] === this.hashHi) return true;
      }
      return false;
    }

    hasNonPawnMaterial(side) {
      const b = this.board;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = b[s];
        if (p && colorOf(p) === side) { const t = typeOf(p); if (t !== PAWN && t !== KING) return true; }
      }
      return false;
    }

    // ---------------------------------------------------------- evaluation
    // Returns the score from the side to move's point of view (centipawns).
    evaluate() {
      const b = this.board;
      let mg = 0, eg = 0, phase = 0;
      let wBishops = 0, bBishops = 0, nwp = 0, nbp = 0, nwr = 0, nbr = 0, wMat = 0, bMat = 0;
      const wPawnFiles = EV.wPawnFiles, bPawnFiles = EV.bPawnFiles;
      const wPawns = EV.wPawns, bPawns = EV.bPawns, wRooks = EV.wRooks, bRooks = EV.bRooks;
      wPawnFiles.fill(0); bPawnFiles.fill(0);
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = b[s];
        if (!p) continue;
        const t = typeOf(p), i = sq64(s);
        phase += PHASE_INC[t];
        if (colorOf(p) === WHITE) {
          mg += MG_TABLE[p][i]; eg += EG_TABLE[p][i]; wMat += MG_VALUE[t];
          if (t === PAWN) { wPawnFiles[fileOf(s)]++; wPawns[nwp++] = s; }
          else if (t === BISHOP) wBishops++;
          else if (t === ROOK) wRooks[nwr++] = s;
        } else {
          mg -= MG_TABLE[p][i]; eg -= EG_TABLE[p][i]; bMat += MG_VALUE[t];
          if (t === PAWN) { bPawnFiles[fileOf(s)]++; bPawns[nbp++] = s; }
          else if (t === BISHOP) bBishops++;
          else if (t === ROOK) bRooks[nbr++] = s;
        }
      }
      if (wBishops >= 2) { mg += BISHOP_PAIR_MG; eg += BISHOP_PAIR_EG; }
      if (bBishops >= 2) { mg -= BISHOP_PAIR_MG; eg -= BISHOP_PAIR_EG; }
      // pawn structure
      for (let pi = 0; pi < nwp; pi++) {
        const s = wPawns[pi], f = fileOf(s), r = rankOf(s);
        if (wPawnFiles[f] > 1) { mg -= DOUBLED_PENALTY / 2; eg -= DOUBLED_PENALTY; }
        if ((f === 0 || !wPawnFiles[f - 1]) && (f === 7 || !wPawnFiles[f + 1])) { mg -= ISOLATED_PENALTY; eg -= ISOLATED_PENALTY; }
        let passed = true;
        for (let rr = r + 1; rr < 7 && passed; rr++) {
          if (b[sq(f, rr)] === (BLACK | PAWN)) passed = false;
          if (f > 0 && b[sq(f - 1, rr)] === (BLACK | PAWN)) passed = false;
          if (f < 7 && b[sq(f + 1, rr)] === (BLACK | PAWN)) passed = false;
        }
        if (passed) { mg += PASSED_BONUS_MG[r]; eg += PASSED_BONUS_EG[r]; }
      }
      for (let pi = 0; pi < nbp; pi++) {
        const s = bPawns[pi], f = fileOf(s), r = rankOf(s);
        if (bPawnFiles[f] > 1) { mg += DOUBLED_PENALTY / 2; eg += DOUBLED_PENALTY; }
        if ((f === 0 || !bPawnFiles[f - 1]) && (f === 7 || !bPawnFiles[f + 1])) { mg += ISOLATED_PENALTY; eg += ISOLATED_PENALTY; }
        let passed = true;
        for (let rr = r - 1; rr > 0 && passed; rr--) {
          if (b[sq(f, rr)] === (WHITE | PAWN)) passed = false;
          if (f > 0 && b[sq(f - 1, rr)] === (WHITE | PAWN)) passed = false;
          if (f < 7 && b[sq(f + 1, rr)] === (WHITE | PAWN)) passed = false;
        }
        if (passed) { mg -= PASSED_BONUS_MG[7 - r]; eg -= PASSED_BONUS_EG[7 - r]; }
      }
      // rooks on open / semi-open files
      for (let ri = 0; ri < nwr; ri++) { const f = fileOf(wRooks[ri]); if (!wPawnFiles[f]) { mg += bPawnFiles[f] ? ROOK_SEMI_OPEN : ROOK_OPEN_FILE; } }
      for (let ri = 0; ri < nbr; ri++) { const f = fileOf(bRooks[ri]); if (!bPawnFiles[f]) { mg -= wPawnFiles[f] ? ROOK_SEMI_OPEN : ROOK_OPEN_FILE; } }
      // king pawn shield (middlegame only)
      mg += KING_SHIELD * this.shield(WHITE) - KING_SHIELD * this.shield(BLACK);
      // mobility for sliders (cheap version)
      const mob = this.sliderMobility(WHITE) - this.sliderMobility(BLACK);
      mg += 2 * mob; eg += 3 * mob;

      // mop-up: with a decisive material edge against a side with no pawns, drive
      // the defending king to the edge and bring our king closer (makes mates findable)
      if (nbp === 0 && wMat - bMat >= 400) eg += this.mopUp(WHITE);
      else if (nwp === 0 && bMat - wMat >= 400) eg -= this.mopUp(BLACK);

      if (phase > TOTAL_PHASE) phase = TOTAL_PHASE;
      let score = ((mg * phase) + (eg * (TOTAL_PHASE - phase))) / TOTAL_PHASE;
      // tempo
      score += 10 * (this.side === WHITE ? 1 : -1);
      return Math.round(this.side === WHITE ? score : -score);
    }

    mopUp(strong) {
      const k = this.kingSq[strong], e = this.kingSq[strong ^ 8];
      if (k < 0 || e < 0) return 0;
      const ef = fileOf(e), er = rankOf(e);
      const centerDist = Math.max(Math.abs(ef - 3.5), Math.abs(er - 3.5)) - 0.5;   // 0..3
      const kingDist = Math.max(Math.abs(fileOf(k) - ef), Math.abs(rankOf(k) - er));  // 1..7
      return Math.round(30 * centerDist + 12 * (7 - kingDist));
    }

    shield(side) {
      const k = this.kingSq[side];
      if (k < 0) return 0;
      const dir = side === WHITE ? 16 : -16, pawn = side | PAWN;
      let n = 0;
      for (let d = dir - 1; d <= dir + 1; d++) {
        const t = k + d;
        if ((t & 0x88) === 0 && this.board[t] === pawn) n++;
        const t2 = t + dir;
        if ((t2 & 0x88) === 0 && this.board[t2] === pawn) n++;
      }
      return n;
    }

    sliderMobility(side) {
      const b = this.board;
      let n = 0;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const p = b[s];
        if (!p || colorOf(p) !== side) continue;
        const t = typeOf(p);
        if (t !== BISHOP && t !== ROOK) continue;
        const offs = t === BISHOP ? BISHOP_OFFSETS : ROOK_OFFSETS;
        for (let i = 0; i < 4; i++) {
          const d = offs[i];
          for (let to = s + d; (to & 0x88) === 0; to += d) {
            const q = b[to];
            if (!q) { n++; continue; }
            if (colorOf(q) !== side) n++;
            break;
          }
        }
      }
      return n;
    }

    // ------------------------------------------------------------ notation
    moveToUci(m) {
      const promo = movePromo(m);
      return algebraic(moveFrom(m)) + algebraic(moveTo(m)) + (promo ? PIECE_CHARS[BLACK | promo] : '');
    }

    uciToMove(uci) {
      for (const m of this.legalMoves()) if (this.moveToUci(m) === uci) return m;
      return 0;
    }

    moveToSan(m) {
      const from = moveFrom(m), to = moveTo(m), promo = movePromo(m), flags = moveFlags(m);
      const piece = this.board[from], t = typeOf(piece);
      let san;
      if (flags & FLAG_CASTLE) san = fileOf(to) === 6 ? 'O-O' : 'O-O-O';
      else {
        san = '';
        if (t === PAWN) {
          if (flags & FLAG_CAPTURE) san += 'abcdefgh'[fileOf(from)] + 'x';
        } else {
          san += PIECE_CHARS[t];
          // disambiguation
          let sameFile = false, sameRank = false, others = 0;
          for (const o of this.legalMoves()) {
            if (o === m || moveTo(o) !== to || moveFrom(o) === from) continue;
            if (this.board[moveFrom(o)] !== piece) continue;
            others++;
            if (fileOf(moveFrom(o)) === fileOf(from)) sameFile = true;
            if (rankOf(moveFrom(o)) === rankOf(from)) sameRank = true;
          }
          if (others) {
            if (!sameFile) san += 'abcdefgh'[fileOf(from)];
            else if (!sameRank) san += (rankOf(from) + 1);
            else san += algebraic(from);
          }
          if (flags & FLAG_CAPTURE) san += 'x';
        }
        san += algebraic(to);
        if (promo) san += '=' + PIECE_CHARS[promo];
      }
      if (this.make(m)) {
        if (this.inCheck()) san += this.legalMoves().length ? '+' : '#';
        this.unmake();
      }
      return san;
    }

    sanToMove(san) {
      const clean = san.replace(/[+#!?]/g, '');
      for (const m of this.legalMoves()) if (this.moveToSan(m).replace(/[+#]/g, '') === clean) return m;
      return 0;
    }

    // Detailed status of the position for the UI.
    status() {
      const legal = this.legalMoves();
      const check = this.inCheck();
      if (!legal.length) return check ? 'checkmate' : 'stalemate';
      if (this.halfmove >= 100) return 'fifty-move';
      if (this.isInsufficientMaterial()) return 'insufficient';
      return check ? 'check' : 'ok';
    }

    isInsufficientMaterial() {
      let minors = 0;
      for (let s = 0; s < 128; s++) {
        if (s & 0x88) { s += 7; continue; }
        const t = typeOf(this.board[s]);
        if (t === PAWN || t === ROOK || t === QUEEN) return false;
        if (t === KNIGHT || t === BISHOP) minors++;
      }
      return minors <= 1;
    }
  }

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Validates a FEN string and explains what is wrong with it. Returns
  // {ok, fen, reason}. Repairs what it can (castling rights, ep square).
  function validateFen(fen) {
    let pos;
    try { pos = new Position(fen); } catch (e) { return { ok: false, reason: e.message }; }
    const b = pos.board;
    let wk = 0, bk = 0, wp = 0, bp = 0, wAll = 0, bAll = 0;
    for (let s = 0; s < 128; s++) {
      if (s & 0x88) { s += 7; continue; }
      const p = b[s];
      if (!p) continue;
      const t = typeOf(p), r = rankOf(s);
      if (t === PAWN && (r === 0 || r === 7)) return { ok: false, reason: 'A pawn is standing on the first or last rank (' + algebraic(s) + '). Pawns cannot be there.' };
      if (p === (WHITE | KING)) wk++;
      else if (p === (BLACK | KING)) bk++;
      else if (p === (WHITE | PAWN)) wp++;
      else if (p === (BLACK | PAWN)) bp++;
      if (colorOf(p) === WHITE) wAll++; else bAll++;
    }
    if (wk !== 1) return { ok: false, reason: wk ? 'White has more than one king.' : 'White has no king.' };
    if (bk !== 1) return { ok: false, reason: bk ? 'Black has more than one king.' : 'Black has no king.' };
    if (wp > 8 || bp > 8) return { ok: false, reason: (wp > 8 ? 'White' : 'Black') + ' has more than eight pawns.' };
    if (wAll > 16 || bAll > 16) return { ok: false, reason: (wAll > 16 ? 'White' : 'Black') + ' has more than sixteen pieces.' };
    if (pos.isAttacked(pos.kingSq[pos.side ^ 8], pos.side)) {
      return { ok: false, reason: 'The side NOT to move is in check, so it cannot be ' + (pos.side === WHITE ? "White's" : "Black's") + ' turn. Try switching the side to move.' };
    }
    return { ok: true, fen: pos.fen(), status: pos.status() };
  }

  // ================================================================= Search
  class Search {
    constructor() {
      this.ttLo = new Int32Array(TT_SIZE);
      this.ttHi = new Int32Array(TT_SIZE);
      this.ttMove = new Int32Array(TT_SIZE);
      this.ttScore = new Int16Array(TT_SIZE);
      this.ttDepth = new Int8Array(TT_SIZE);
      this.ttFlag = new Int8Array(TT_SIZE);
      this.killers = new Int32Array(MAX_PLY * 2);
      this.history = new Int32Array(16 * 128);
      this.moveLists = []; this.scoreLists = [];
      for (let i = 0; i < MAX_PLY + 2; i++) { this.moveLists.push([]); this.scoreLists.push(new Int32Array(256)); }
      this.nodes = 0;
      this.stopped = false;
      this.deadline = 0;
      this.onInfo = null;
    }

    clearTables() {
      this.ttLo.fill(0); this.ttHi.fill(0); this.ttMove.fill(0); this.ttDepth.fill(0); this.ttFlag.fill(0);
      this.killers.fill(0); this.history.fill(0);
    }

    // ---- transposition table
    ttProbe(pos) {
      const i = pos.hashLo & (TT_SIZE - 1);
      if (this.ttLo[i] === pos.hashLo && this.ttHi[i] === pos.hashHi && this.ttFlag[i]) return i;
      return -1;
    }
    ttStore(pos, depth, score, flag, move, ply) {
      const i = pos.hashLo & (TT_SIZE - 1);
      // prefer keeping deeper entries for the same position, else overwrite
      if (this.ttLo[i] === pos.hashLo && this.ttHi[i] === pos.hashHi && this.ttDepth[i] > depth && this.ttFlag[i] !== TT_EXACT && flag !== TT_EXACT) return;
      if (score > MATE_IN_MAX) score += ply; else if (score < -MATE_IN_MAX) score -= ply;
      this.ttLo[i] = pos.hashLo; this.ttHi[i] = pos.hashHi;
      this.ttMove[i] = move; this.ttScore[i] = score; this.ttDepth[i] = depth; this.ttFlag[i] = flag;
    }

    checkTime() {
      if ((this.nodes & 2047) === 0 && Date.now() >= this.deadline) this.stopped = true;
    }

    // ---- move ordering
    scoreMoves(pos, moves, scores, ttMove, ply) {
      const b = pos.board;
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (m === ttMove) { scores[i] = 2000000; continue; }
        const flags = moveFlags(m), promo = movePromo(m);
        if (flags & FLAG_CAPTURE) {
          const victim = (flags & FLAG_EP) ? PAWN : typeOf(b[moveTo(m)]);
          const attacker = typeOf(b[moveFrom(m)]);
          scores[i] = 1000000 + victim * 100 - attacker + (promo === QUEEN ? 500 : 0);
        } else if (promo) {
          scores[i] = promo === QUEEN ? 900000 : 100;
        } else if (m === this.killers[ply * 2]) scores[i] = 800000;
        else if (m === this.killers[ply * 2 + 1]) scores[i] = 700000;
        else scores[i] = this.history[b[moveFrom(m)] * 128 + moveTo(m)];
      }
    }
    pick(moves, scores, i) {
      let best = i;
      for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j;
      if (best !== i) {
        const tm = moves[i]; moves[i] = moves[best]; moves[best] = tm;
        const ts = scores[i]; scores[i] = scores[best]; scores[best] = ts;
      }
      return moves[i];
    }

    // ---- quiescence
    quiesce(pos, alpha, beta, ply) {
      this.nodes++;
      this.checkTime();
      if (this.stopped) return 0;
      if (ply >= MAX_PLY - 1) return pos.evaluate();
      const inCheck = pos.inCheck();
      let best;
      if (!inCheck) {
        best = pos.evaluate();
        if (best >= beta) return best;
        if (best > alpha) alpha = best;
      } else best = -INFINITY;
      const moves = this.moveLists[ply]; moves.length = 0;
      pos.generate(moves, !inCheck);
      const scores = this.scoreLists[ply];
      this.scoreMoves(pos, moves, scores, 0, ply);
      let legal = 0;
      for (let i = 0; i < moves.length; i++) {
        const m = this.pick(moves, scores, i);
        // delta pruning: skip captures that cannot possibly raise alpha
        if (!inCheck && (moveFlags(m) & FLAG_CAPTURE) && !movePromo(m)) {
          const victim = (moveFlags(m) & FLAG_EP) ? PAWN : typeOf(pos.board[moveTo(m)]);
          if (best + MG_VALUE[victim] + 200 < alpha) continue;
        }
        if (!pos.make(m)) continue;
        legal++;
        const score = -this.quiesce(pos, -beta, -alpha, ply + 1);
        pos.unmake();
        if (this.stopped) return 0;
        if (score > best) {
          best = score;
          if (score > alpha) { alpha = score; if (score >= beta) return best; }
        }
      }
      if (inCheck && legal === 0) return -MATE + ply;
      return best;
    }

    // ---- main alpha-beta (principal variation search)
    search(pos, depth, alpha, beta, ply, allowNull) {
      const isPv = beta - alpha > 1;
      if (ply > 0) {
        if (pos.isRepetition() || pos.halfmove >= 100) return 0;
        // mate distance pruning
        const mateAlpha = -MATE + ply, mateBeta = MATE - ply - 1;
        if (mateAlpha > alpha) alpha = mateAlpha;
        if (mateBeta < beta) beta = mateBeta;
        if (alpha >= beta) return alpha;
      }
      const inCheck = pos.inCheck();
      if (inCheck) depth++;
      if (depth <= 0) return this.quiesce(pos, alpha, beta, ply);
      this.nodes++;
      this.checkTime();
      if (this.stopped) return 0;
      if (ply >= MAX_PLY - 1) return pos.evaluate();

      // transposition table
      let ttMove = 0;
      const tt = this.ttProbe(pos);
      if (tt >= 0) {
        ttMove = this.ttMove[tt];
        if (this.ttDepth[tt] >= depth && ply > 0 && !isPv) {
          let s = this.ttScore[tt];
          if (s > MATE_IN_MAX) s -= ply; else if (s < -MATE_IN_MAX) s += ply;
          const f = this.ttFlag[tt];
          if (f === TT_EXACT) return s;
          if (f === TT_ALPHA && s <= alpha) return alpha;
          if (f === TT_BETA && s >= beta) return beta;
        }
      }

      let staticEval = 0;
      if (!inCheck) {
        staticEval = pos.evaluate();
        // reverse futility pruning
        if (!isPv && depth <= 3 && staticEval - 120 * depth >= beta && Math.abs(beta) < MATE_IN_MAX) return staticEval;
        // null move pruning
        if (allowNull && !isPv && depth >= 3 && staticEval >= beta && pos.hasNonPawnMaterial(pos.side)) {
          const R = depth >= 6 ? 3 : 2;
          pos.makeNull();
          const score = -this.search(pos, depth - 1 - R, -beta, -beta + 1, ply + 1, false);
          pos.unmakeNull();
          if (this.stopped) return 0;
          if (score >= beta && score < MATE_IN_MAX) return beta;
        }
      }

      // internal iterative deepening: find a move to order by when the TT has none
      if (isPv && !ttMove && depth >= 4) {
        this.search(pos, depth - 2, alpha, beta, ply, false);
        if (this.stopped) return 0;
        const t2 = this.ttProbe(pos);
        if (t2 >= 0) ttMove = this.ttMove[t2];
      }

      const moves = this.moveLists[ply]; moves.length = 0;
      pos.generate(moves, false);
      const scores = this.scoreLists[ply];
      this.scoreMoves(pos, moves, scores, ttMove, ply);

      let bestScore = -INFINITY, bestMove = 0, legal = 0, flag = TT_ALPHA;
      const futile = !inCheck && depth <= 2 && staticEval + 150 * depth <= alpha;
      for (let i = 0; i < moves.length; i++) {
        const m = this.pick(moves, scores, i);
        const quiet = !(moveFlags(m) & FLAG_CAPTURE) && !movePromo(m);
        if (!pos.make(m)) continue;
        legal++;
        const givesCheck = pos.inCheck();
        // futility pruning of quiet moves near the leaves
        if (futile && quiet && !givesCheck && legal > 1 && bestScore > -MATE_IN_MAX) { pos.unmake(); continue; }
        let score;
        if (legal === 1) {
          score = -this.search(pos, depth - 1, -beta, -alpha, ply + 1, true);
        } else {
          // late move reductions
          let reduction = 0;
          if (depth >= 3 && quiet && !inCheck && !givesCheck && legal > 3) {
            reduction = 1 + (legal > 8 ? 1 : 0) + (depth > 6 && legal > 14 ? 1 : 0);
            if (isPv) reduction = Math.max(0, reduction - 1);
          }
          score = -this.search(pos, depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
          if (score > alpha && reduction > 0 && !this.stopped) score = -this.search(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
          if (score > alpha && score < beta && !this.stopped) score = -this.search(pos, depth - 1, -beta, -alpha, ply + 1, true);
        }
        pos.unmake();
        if (this.stopped) return 0;
        if (score > bestScore) {
          bestScore = score;
          bestMove = m;
          if (score > alpha) {
            alpha = score; flag = TT_EXACT;
            if (score >= beta) {
              if (quiet) {
                const k = ply * 2;
                if (this.killers[k] !== m) { this.killers[k + 1] = this.killers[k]; this.killers[k] = m; }
                const h = pos.board[moveFrom(m)] * 128 + moveTo(m);
                this.history[h] += depth * depth;
                if (this.history[h] > 400000) { for (let j = 0; j < this.history.length; j++) this.history[j] >>= 1; }
              }
              this.ttStore(pos, depth, score, TT_BETA, m, ply);
              return score;
            }
          }
        }
      }
      if (legal === 0) return inCheck ? -MATE + ply : 0;
      this.ttStore(pos, depth, bestScore, flag, bestMove, ply);
      return bestScore;
    }

    // Extracts the principal variation from the TT as an array of moves.
    extractPv(pos, maxLen) {
      const pv = [];
      let made = 0;
      const seenLo = [], seenHi = [];
      while (pv.length < maxLen) {
        const tt = this.ttProbe(pos);
        if (tt < 0 || !this.ttMove[tt]) break;
        const m = this.ttMove[tt];
        if (!pos.legalMoves().includes(m)) break;
        // avoid cycling forever on repetitions
        let cycle = false;
        for (let i = 0; i < seenLo.length; i++) if (seenLo[i] === pos.hashLo && seenHi[i] === pos.hashHi) cycle = true;
        if (cycle) break;
        seenLo.push(pos.hashLo); seenHi.push(pos.hashHi);
        pv.push(m);
        pos.make(m); made++;
      }
      while (made--) pos.unmake();
      return pv;
    }

    // Iterative deepening driver. opts: {movetime (ms), depth, onInfo(info)}.
    go(pos, opts) {
      opts = opts || {};
      const movetime = opts.movetime || 3000, maxDepth = Math.min(opts.depth || 64, MAX_PLY - 4);
      this.nodes = 0; this.stopped = false;
      this.deadline = Date.now() + movetime;
      this.killers.fill(0);
      for (let j = 0; j < this.history.length; j++) this.history[j] >>= 3;
      const start = Date.now();
      const legal = pos.legalMoves();
      const result = { bestMove: 0, ponder: 0, score: 0, mate: null, depth: 0, nodes: 0, time: 0, pv: [], pvSan: [] };
      if (!legal.length) { result.status = pos.status(); return result; }
      if (legal.length === 1) {
        result.bestMove = legal[0]; result.depth = 1; result.pv = [legal[0]];
        result.pvSan = [pos.moveToSan(legal[0])]; result.bestSan = result.pvSan[0]; result.bestUci = pos.moveToUci(legal[0]);
        result.forced = true; result.score = 0;
        return result;
      }
      let alpha = -INFINITY, beta = INFINITY, lastScore = 0;
      for (let depth = 1; depth <= maxDepth; depth++) {
        let score, window = 40;
        // aspiration windows around the previous iteration's score
        if (depth >= 4) { alpha = lastScore - window; beta = lastScore + window; }
        for (;;) {
          score = this.search(pos, depth, alpha, beta, 0, false);
          if (this.stopped) break;
          if (score <= alpha) { alpha = Math.max(-INFINITY, alpha - window); window *= 2; continue; }
          if (score >= beta) { beta = Math.min(INFINITY, beta + window); window *= 2; continue; }
          break;
        }
        if (this.stopped) {
          // keep a partial iteration only if it improved on the previous best
          break;
        }
        lastScore = score;
        const pv = this.extractPv(pos, depth + 4);
        if (pv.length) {
          result.bestMove = pv[0]; result.pv = pv; result.depth = depth; result.score = score;
          result.pvSan = this.pvSan(pos, pv);
          result.bestSan = result.pvSan[0]; result.bestUci = pos.moveToUci(pv[0]);
          result.ponder = pv[1] || 0;
        }
        result.nodes = this.nodes; result.time = Date.now() - start;
        result.mate = Math.abs(score) > MATE_IN_MAX ? (score > 0 ? Math.ceil((MATE - score) / 2) : -Math.ceil((MATE + score) / 2)) : null;
        if (opts.onInfo) opts.onInfo(Object.assign({}, result));
        if (result.mate !== null && Math.abs(result.mate) * 2 <= depth) break;  // mate found; no need to go deeper
        // do not start an iteration we cannot plausibly finish
        const elapsed = Date.now() - start;
        if (elapsed > movetime * 0.5) break;
      }
      result.nodes = this.nodes; result.time = Date.now() - start;
      if (!result.bestMove) { result.bestMove = legal[0]; result.pv = [legal[0]]; result.pvSan = [pos.moveToSan(legal[0])]; result.bestSan = result.pvSan[0]; result.bestUci = pos.moveToUci(legal[0]); }
      return result;
    }

    pvSan(pos, pv) {
      const out = [];
      let made = 0;
      for (const m of pv) {
        if (!pos.legalMoves().includes(m)) break;
        out.push(pos.moveToSan(m));
        pos.make(m); made++;
      }
      while (made--) pos.unmake();
      return out;
    }
  }

  // ================================================================== perft
  function perft(pos, depth) {
    if (depth === 0) return 1;
    let n = 0;
    const moves = pos.generate([], false);
    for (const m of moves) {
      if (!pos.make(m)) continue;
      n += depth === 1 ? 1 : perft(pos, depth - 1);
      pos.unmake();
    }
    return n;
  }

  // ============================================================ worker glue
  function installWorker(scope) {
    let search = new Search();
    scope.onmessage = function (e) {
      const msg = e.data || {};
      if (msg.type === 'go') {
        let pos;
        try { pos = new Position(msg.fen); } catch (err) { scope.postMessage({ type: 'error', id: msg.id, message: err.message }); return; }
        const res = search.go(pos, {
          movetime: msg.movetime, depth: msg.depth,
          onInfo: (info) => scope.postMessage({ type: 'info', id: msg.id, info: publicResult(pos, info) }),
        });
        scope.postMessage({ type: 'best', id: msg.id, result: publicResult(pos, res) });
      } else if (msg.type === 'clear') {
        search.clearTables();
      }
    };
  }
  function publicResult(pos, r) {
    return {
      bestUci: r.bestUci || '', bestSan: r.bestSan || '', ponderSan: r.pv && r.pv.length > 1 ? r.pvSan[1] : '',
      score: r.score, mate: r.mate, depth: r.depth, nodes: r.nodes, time: r.time,
      pvSan: r.pvSan || [], pvUci: (r.pv || []).map((m) => pos.moveToUci(m)),
      forced: !!r.forced, status: r.status || pos.status(),
    };
  }

  return {
    Position, Search, perft, validateFen, installWorker, START_FEN,
    constants: { WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, MATE, MATE_IN_MAX },
    util: { moveFrom, moveTo, movePromo, moveFlags, algebraic, parseSquare, PIECE_CHARS, CHAR_PIECES },
  };
});
