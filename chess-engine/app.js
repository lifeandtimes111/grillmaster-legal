/* Sightline app: board, editor, picture reading, engine wiring. */
(function () {
  'use strict';
  const E = window.SightlineEngine;
  const $ = (id) => document.getElementById(id);
  const FILES = 'abcdefgh';
  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  // Position shown when the page opens without a #fen= link: the walkthrough plays automatically.
  const SAMPLE_FEN = '3kNr2/pp2bQ2/2p1P2p/6q1/4B1b1/4P3/PPP5/2K2R2 w - - 0 1';

  // ------------------------------------------------------------------ state
  const state = {
    cells: new Array(64).fill(''),   // index = rank * 8 + file, a1 = 0; piece letters, '' empty
    side: 'w',
    ep: '-',
    halfmove: 0,
    fullmove: 1,
    flipped: false,
    tool: null,          // null = move mode, '' = erase, 'K'.. = place
    selected: -1,        // square selected in move mode
    history: [],
    lastImage: null,
    result: null,        // latest engine info/result
    searching: false,
    searchId: 0,
    valid: null,         // {ok, fen, reason}
  };

  // -------------------------------------------------------------- FEN glue
  function castlingString() {
    let c = '';
    if ($('c-K').checked) c += 'K';
    if ($('c-Q').checked) c += 'Q';
    if ($('c-k').checked) c += 'k';
    if ($('c-q').checked) c += 'q';
    return c || '-';
  }
  function placementString() {
    let out = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = state.cells[r * 8 + f];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        out += p;
      }
      if (empty) out += empty;
      if (r) out += '/';
    }
    return out;
  }
  function currentFen() {
    return placementString() + ' ' + state.side + ' ' + castlingString() + ' ' + state.ep + ' ' + state.halfmove + ' ' + state.fullmove;
  }
  function loadFen(fen, opts) {
    opts = opts || {};
    const check = E.validateFen(fen);
    if (!check.ok) {
      // Still show the placement so the user can fix it, if the placement itself parses.
      try {
        const pos = new E.Position(fen);
        cellsFromPosition(pos);
        state.side = pos.side === E.constants.WHITE ? 'w' : 'b';
        setCastlingBoxes(pos.castle);
        state.ep = '-'; state.halfmove = 0; state.fullmove = pos.fullmove;
      } catch (e) { /* unreadable placement: leave the board alone */ }
      state.valid = check;
      render();
      return check;
    }
    const pos = new E.Position(check.fen);
    cellsFromPosition(pos);
    state.side = pos.side === E.constants.WHITE ? 'w' : 'b';
    setCastlingBoxes(pos.castle);
    state.ep = check.fen.split(' ')[3];
    state.halfmove = pos.halfmove; state.fullmove = pos.fullmove;
    state.valid = check;
    render();
    if (!opts.silent) analyze();
    return check;
  }
  function cellsFromPosition(pos) {
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const p = pos.board[r * 16 + f];
      state.cells[r * 8 + f] = p ? E.util.PIECE_CHARS[p] : '';
    }
  }
  function setCastlingBoxes(bits) {
    $('c-K').checked = !!(bits & 1); $('c-Q').checked = !!(bits & 2);
    $('c-k').checked = !!(bits & 4); $('c-q').checked = !!(bits & 8);
  }
  // Castling rights the current placement allows (king and rook on their home squares).
  function autoCastling() {
    const c = state.cells;
    $('c-K').checked = c[4] === 'K' && c[7] === 'R';
    $('c-Q').checked = c[4] === 'K' && c[0] === 'R';
    $('c-k').checked = c[60] === 'k' && c[63] === 'r';
    $('c-q').checked = c[60] === 'k' && c[56] === 'r';
  }
  function revalidate() {
    state.valid = E.validateFen(currentFen());
    return state.valid;
  }

  // ---------------------------------------------------------------- render
  const boardEl = $('board');
  const squares = [];
  function buildBoard() {
    boardEl.innerHTML = '';
    for (let i = 0; i < 64; i++) {
      const d = document.createElement('div');
      d.className = 'sq';
      d.setAttribute('role', 'gridcell');
      d.addEventListener('click', () => onSquareClick(d.dataset.sq | 0));
      boardEl.appendChild(d);
      squares.push(d);
    }
  }
  function squareAtVisual(i) {
    // visual index i (0 = top-left) -> board square index (a1 = 0)
    const vr = Math.floor(i / 8), vf = i % 8;
    const r = state.flipped ? vr : 7 - vr;
    const f = state.flipped ? 7 - vf : vf;
    return r * 8 + f;
  }
  function render() {
    const r = state.result;
    let from = -1, to = -1;
    if (r && r.bestUci && state.valid && state.valid.ok) { from = sqIndex(r.bestUci.slice(0, 2)); to = sqIndex(r.bestUci.slice(2, 4)); }
    let checkSq = -1;
    if (state.valid && state.valid.ok && (state.valid.status === 'check' || state.valid.status === 'checkmate')) {
      checkSq = state.cells.indexOf(state.side === 'w' ? 'K' : 'k');
    }
    for (let i = 0; i < 64; i++) {
      const s = squareAtVisual(i);
      const rank = s >> 3, file = s & 7;
      const d = squares[i];
      d.dataset.sq = s;
      d.className = 'sq ' + (((rank + file) & 1) ? 'light' : 'dark');
      if (s === from) d.classList.add('from');
      if (s === to) d.classList.add('to');
      if (s === state.selected) d.classList.add('sel');
      if (s === checkSq) d.classList.add('check');
      d.setAttribute('aria-label', FILES[file] + (rank + 1) + (state.cells[s] ? ' ' + pieceName(state.cells[s]) : ' empty'));
      let html = '';
      const p = state.cells[s];
      if (p) html += '<span class="piece ' + (p === p.toUpperCase() ? 'w' : 'b') + '">' + GLYPH[p.toLowerCase()] + '</span>';
      const vr = Math.floor(i / 8), vf = i % 8;
      if (vr === 7) html += '<span class="coord file">' + FILES[file] + '</span>';
      if (vf === 0) html += '<span class="coord rank">' + (rank + 1) + '</span>';
      d.innerHTML = html;
    }
    drawArrows(from, to, r);
    $('evalbar').dataset.flipped = state.flipped;
    $('side-w').setAttribute('aria-pressed', state.side === 'w');
    $('side-b').setAttribute('aria-pressed', state.side === 'b');
    $('fen').value = currentFen();
    renderPositionNote();
    renderTurn();
  }
  function pieceName(p) {
    const names = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
    return (p === p.toUpperCase() ? 'white ' : 'black ') + names[p.toLowerCase()];
  }
  function sqIndex(alg) { return (alg.charCodeAt(1) - 49) * 8 + (alg.charCodeAt(0) - 97); }
  function center(s) {
    const rank = s >> 3, file = s & 7;
    const vf = state.flipped ? 7 - file : file;
    const vr = state.flipped ? rank : 7 - rank;
    return [vf * 10 + 5, vr * 10 + 5];
  }
  function drawArrows(from, to, r) {
    const svg = $('arrows');
    for (const g of svg.querySelectorAll('g')) g.remove();
    if (from < 0) return;
    svg.appendChild(arrow(from, to, 'best'));
    if (r && r.pvUci && r.pvUci.length > 1) {
      const p = r.pvUci[1];
      svg.appendChild(arrow(sqIndex(p.slice(0, 2)), sqIndex(p.slice(2, 4)), 'ponder'));
    }
  }
  function arrow(from, to, cls) {
    const [x1, y1] = center(from), [x2, y2] = center(to);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const sx = x1 + ux * 2.4, sy = y1 + uy * 2.4;       // leave the piece visible
    const ex = x2 - ux * 3.6, ey = y2 - uy * 3.6;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', cls);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', sx); line.setAttribute('y1', sy); line.setAttribute('x2', ex); line.setAttribute('y2', ey);
    g.appendChild(line);
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    const hw = 2.2, hl = 3.4;
    const tipX = x2 - ux * 1.6, tipY = y2 - uy * 1.6;
    const bx = tipX - ux * hl, by = tipY - uy * hl;
    head.setAttribute('points', `${tipX},${tipY} ${bx - uy * hw},${by + ux * hw} ${bx + uy * hw},${by - ux * hw}`);
    g.appendChild(head);
    return g;
  }
  function renderTurn() {
    const v = state.valid;
    let t = state.side === 'w' ? 'White to move' : 'Black to move';
    if (v && v.ok) {
      if (v.status === 'checkmate') t = 'Checkmate. ' + (state.side === 'w' ? 'Black' : 'White') + ' wins';
      else if (v.status === 'stalemate') t = 'Stalemate';
      else if (v.status === 'check') t += ', in check';
    }
    $('turn').textContent = t;
  }
  function renderPositionNote() {
    const n = $('posnote');
    const v = state.valid;
    if (!v) { n.textContent = ''; n.className = 'note'; return; }
    if (!v.ok) { n.textContent = v.reason; n.className = 'note warn'; return; }
    n.textContent = ''; n.className = 'note';
  }

  // ------------------------------------------------------------- verdict UI
  function fmtScore(r) {
    // r.score is from the side to move; show from White's side
    const sign = state.side === 'w' ? 1 : -1;
    if (r.mate !== null && r.mate !== undefined) {
      const m = r.mate * sign;
      const winner = m > 0 ? 'White' : 'Black';
      return { text: 'Mate in ' + Math.abs(m), who: winner + ' mates', white: m > 0 ? 1 : 0 };
    }
    const cp = r.score * sign;
    const pawns = (cp / 100);
    const text = (cp > 0 ? '+' : cp < 0 ? '−' : '') + Math.abs(pawns).toFixed(2);
    let who = 'Equal';
    if (cp > 150) who = 'White is winning'; else if (cp > 50) who = 'White is better'; else if (cp > 15) who = 'White is slightly better';
    else if (cp < -150) who = 'Black is winning'; else if (cp < -50) who = 'Black is better'; else if (cp < -15) who = 'Black is slightly better';
    return { text, who, white: 1 / (1 + Math.exp(-0.004 * cp)) };
  }
  function renderVerdict(r, final) {
    state.result = r;
    const bm = $('bestmove');
    if (!r || !r.bestSan) {
      bm.textContent = '…'; bm.className = 'move thinking';
      $('score').innerHTML = '<span class="who">Thinking</span>';
      $('pv').innerHTML = ''; $('stats').textContent = '';
      return;
    }
    bm.textContent = r.bestSan; bm.className = 'move' + (final ? '' : ' thinking');
    const s = fmtScore(r);
    $('score').innerHTML = '<span>' + s.text + '</span> <span class="who">· ' + s.who + (r.forced ? ' · only legal move' : '') + '</span>';
    $('evalwhite').style.height = Math.round(s.white * 100) + '%';
    // principal variation with move numbers
    const pv = $('pv');
    pv.innerHTML = '';
    let num = state.fullmove, white = state.side === 'w';
    r.pvSan.forEach((san, i) => {
      if (white || i === 0) {
        const n = document.createElement('span'); n.className = 'num';
        n.textContent = num + (white ? '.' : '…');
        pv.appendChild(n);
      }
      const m = document.createElement('span'); m.className = 'm' + (i === 0 ? ' first' : ''); m.textContent = san;
      pv.appendChild(m);
      if (!white) num++;
      white = !white;
    });
    const nps = r.time ? Math.round(r.nodes / r.time) : 0;
    $('stats').innerHTML = '<span>depth ' + r.depth + '</span><span>' + fmtNodes(r.nodes) + ' nodes</span><span>' + (nps ? nps + 'k n/s' : '') + '</span><span>' + (r.time / 1000).toFixed(1) + ' s</span>';
    render();
  }
  function fmtNodes(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n); }
  function renderTerminal(status) {
    const bm = $('bestmove');
    bm.className = 'move';
    const map = { checkmate: 'Mate', stalemate: 'Draw', 'fifty-move': 'Draw', insufficient: 'Draw' };
    bm.textContent = map[status] || '—';
    const who = status === 'checkmate' ? (state.side === 'w' ? 'Black' : 'White') + ' has won by checkmate'
      : status === 'stalemate' ? 'Stalemate: no legal moves' : status === 'fifty-move' ? 'Fifty-move rule' : 'Insufficient material';
    $('score').innerHTML = '<span class="who">' + who + '</span>';
    $('pv').innerHTML = ''; $('stats').textContent = '';
    $('evalwhite').style.height = status === 'checkmate' ? (state.side === 'w' ? '0%' : '100%') : '50%';
    $('progress').style.width = '0%';
    state.result = null;
    render();
  }

  // ------------------------------------------------------------- the engine
  let worker = null, workerBroken = false;
  function getWorker() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker('engine.js');
      worker.onmessage = onWorkerMessage;
      worker.onerror = () => { workerBroken = true; try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; if (state.searching) analyze(); };
    } catch (e) { workerBroken = true; worker = null; }
    return worker;
  }
  function onWorkerMessage(e) {
    const msg = e.data;
    if (msg.id !== state.searchId) return;
    if (msg.type === 'info') { renderVerdict(msg.info, false); $('progress').style.width = Math.min(100, 100 * msg.info.time / thinkMs()) + '%'; }
    else if (msg.type === 'best') finishSearch(msg.result);
    else if (msg.type === 'error') { finishSearch(null); $('posnote').textContent = msg.message; $('posnote').className = 'note warn'; }
  }
  function thinkMs() { return +$('think').value; }
  let inlineSearch = null;
  function analyze() {
    if (walk.running) stopWalk();
    $('watch').disabled = true;
    const v = revalidate();
    render();
    state.searchId++;
    if (!v.ok) { renderVerdict(null, true); $('bestmove').textContent = '—'; $('score').innerHTML = '<span class="who">Fix the position first</span>'; $('play').disabled = true; $('stop').disabled = true; return; }
    if (v.status === 'checkmate' || v.status === 'stalemate' || v.status === 'fifty-move' || v.status === 'insufficient') { renderTerminal(v.status); $('play').disabled = true; $('stop').disabled = true; return; }
    state.searching = true;
    writeHash();
    $('stop').disabled = false; $('play').disabled = true; $('analyze').disabled = true;
    renderVerdict(null, false);
    $('progress').style.width = '2%';
    const id = state.searchId, fen = v.fen, movetime = thinkMs();
    const w = getWorker();
    if (w) { w.postMessage({ type: 'go', id, fen, movetime, depth: 40 }); return; }
    // Fallback: search on the main thread (the page will be busy while it thinks).
    setTimeout(() => {
      if (id !== state.searchId) return;
      inlineSearch = inlineSearch || new E.Search();
      const pos = new E.Position(fen);
      const res = inlineSearch.go(pos, { movetime, depth: 40 });
      onWorkerMessage({ data: { type: 'best', id, result: publicResult(pos, res) } });
    }, 30);
  }
  function publicResult(pos, r) {
    return { bestUci: r.bestUci || '', bestSan: r.bestSan || '', score: r.score, mate: r.mate, depth: r.depth, nodes: r.nodes, time: r.time,
      pvSan: r.pvSan || [], pvUci: (r.pv || []).map((m) => pos.moveToUci(m)), forced: !!r.forced, status: pos.status() };
  }
  function finishSearch(result) {
    state.searching = false;
    $('stop').disabled = true; $('analyze').disabled = false;
    $('progress').style.width = '100%';
    if (result && result.bestSan) { renderVerdict(result, true); $('play').disabled = false; $('watch').disabled = false; if (autoWatch) { autoWatch = false; setTimeout(watchLine, 400); } }
    else { renderVerdict(null, true); $('play').disabled = true; $('watch').disabled = true; }
  }
  let autoWatch = false;
  function stopSearch() {
    if (!state.searching) return;
    state.searchId++;
    state.searching = false;
    if (worker) { worker.terminate(); worker = null; }
    const r = state.result;
    $('stop').disabled = true; $('analyze').disabled = false;
    if (r && r.bestSan) { renderVerdict(r, true); $('play').disabled = false; $('watch').disabled = false; }
  }

  // --------------------------------------------------------------- editing
  function pushHistory() { state.history.push(currentFen()); if (state.history.length > 200) state.history.shift(); $('undo').disabled = false; }
  function afterEdit(opts) {
    opts = opts || {};
    state.ep = '-';
    if (!opts.keepCastling) autoCastling();
    state.result = null;
    revalidate();
    render();
    scheduleAnalyze();
  }
  let analyzeTimer = 0;
  function scheduleAnalyze() { clearTimeout(analyzeTimer); analyzeTimer = setTimeout(analyze, 350); }

  function onSquareClick(s) {
    if (walk.running) return;
    if (state.tool !== null) {
      pushHistory();
      state.cells[s] = state.cells[s] === state.tool ? '' : state.tool;
      state.selected = -1;
      afterEdit();
      return;
    }
    // move mode
    if (state.selected < 0) {
      if (state.cells[s]) { state.selected = s; render(); }
      return;
    }
    if (state.selected === s) { state.selected = -1; render(); return; }
    const from = state.selected;
    state.selected = -1;
    pushHistory();
    // If this is a legal move for the side to move, play it properly (castling, en passant, promotion, turn change).
    if (state.valid && state.valid.ok) {
      const pos = new E.Position(state.valid.fen);
      const uci = alg(from) + alg(s);
      let m = pos.uciToMove(uci) || pos.uciToMove(uci + 'q');
      if (m) { applyMove(pos, m); return; }
    }
    // Otherwise just relocate the piece (editor move).
    state.cells[s] = state.cells[from]; state.cells[from] = '';
    afterEdit();
  }
  function alg(s) { return FILES[s & 7] + ((s >> 3) + 1); }
  function applyMove(pos, m) {
    pos.make(m);
    const fen = pos.fen();
    state.result = null;
    loadFen(fen, { silent: true });
    scheduleAnalyze();
  }

  $('palette').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const p = b.dataset.piece;
    state.tool = state.tool === p ? null : p;
    state.selected = -1;
    for (const x of $('palette').querySelectorAll('button')) x.setAttribute('aria-pressed', x.dataset.piece === state.tool && state.tool !== null ? 'true' : 'false');
    $('editorhint').textContent = state.tool === null ? 'Pick a piece above and click squares to place it. With nothing picked, click a piece and then its destination to move it.'
      : state.tool === '' ? 'Click squares to remove pieces. Click × again to stop.' : 'Click squares to place a ' + pieceName(state.tool) + '. Click the piece again to stop.';
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { state.tool = null; state.selected = -1; for (const x of $('palette').querySelectorAll('button')) x.setAttribute('aria-pressed', 'false'); render(); }
  });
  $('flip').addEventListener('click', () => { if (walk.running) return; state.flipped = !state.flipped; render(); writeHash(); });
  $('clear').addEventListener('click', () => { if (walk.running) stopWalk(); pushHistory(); state.cells.fill(''); state.side = 'w'; state.fullmove = 1; afterEdit(); });
  $('start').addEventListener('click', () => { if (walk.running) stopWalk(); pushHistory(); state.result = null; loadFen(E.START_FEN); });
  $('side-w').addEventListener('click', () => { if (state.side !== 'w') { pushHistory(); state.side = 'w'; afterEdit({ keepCastling: true }); } });
  $('side-b').addEventListener('click', () => { if (state.side !== 'b') { pushHistory(); state.side = 'b'; afterEdit({ keepCastling: true }); } });
  for (const id of ['c-K', 'c-Q', 'c-k', 'c-q']) $(id).addEventListener('change', () => { state.result = null; revalidate(); render(); scheduleAnalyze(); });
  $('fen').addEventListener('change', () => { const v = $('fen').value.trim(); if (v) { pushHistory(); state.result = null; loadFen(v); } });
  $('fen').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('fen').dispatchEvent(new Event('change')); } });
  $('analyze').addEventListener('click', () => { state.result = null; analyze(); });
  $('stop').addEventListener('click', stopSearch);
  $('think').addEventListener('change', () => { if (!state.searching) analyze(); });
  $('play').addEventListener('click', () => {
    const r = state.result;
    if (!r || !r.bestUci || !state.valid || !state.valid.ok) return;
    const pos = new E.Position(state.valid.fen);
    const m = pos.uciToMove(r.bestUci);
    if (!m) return;
    pushHistory();
    applyMove(pos, m);
  });
  $('undo').addEventListener('click', () => {
    const fen = state.history.pop();
    if (!fen) return;
    $('undo').disabled = state.history.length === 0;
    state.result = null;
    loadFen(fen);
  });

  // ------------------------------------------------------ line walkthrough
  // Animates the principal variation on the board: each piece glides to its
  // square with a caption, then the board returns to the analysed position.
  const walk = { running: false, token: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function visualRect(s) {
    const rank = s >> 3, file = s & 7;
    const vf = state.flipped ? 7 - file : file, vr = state.flipped ? rank : 7 - rank;
    return { x: vf * 12.5, y: vr * 12.5 };
  }
  function describeMove(pos, m, san) {
    const U = E.util, C = E.constants;
    const from = U.moveFrom(m), to = U.moveTo(m), flags = U.moveFlags(m), promo = U.movePromo(m);
    const piece = pos.board[from], names = { 1: 'pawn', 2: 'knight', 3: 'bishop', 4: 'rook', 5: 'queen', 6: 'king' };
    const who = pos.side === C.WHITE ? 'White' : 'Black';
    const name = names[piece & 7];
    let text;
    if (flags & 8) text = who + ' castles ' + ((to & 7) === 6 ? 'kingside' : 'queenside');
    else if (flags & 4) text = who + "'s pawn takes en passant";
    else if (flags & 1) {
      const victim = names[pos.board[to] & 7] || 'pawn';
      text = who + "'s " + name + ' takes the ' + victim + ' on ' + U.algebraic(to);
    } else text = who + "'s " + name + ' goes to ' + U.algebraic(to);
    if (promo) text += ' and becomes a ' + names[promo];
    if (san.endsWith('#')) text += '. Checkmate';
    else if (san.endsWith('+')) text += ', with check';
    return text;
  }
  async function watchLine() {
    const r = state.result;
    if (!r || !r.pvUci || !r.pvUci.length || !state.valid || !state.valid.ok) return;
    if (walk.running) { stopWalk(); return; }
    const token = ++walk.token;
    walk.running = true;
    const startFen = state.valid.fen, savedResult = r, savedFlip = state.flipped;
    walk.saved = { fen: startFen, result: savedResult, flip: savedFlip };
    $('watch').textContent = 'Stop';
    $('play').disabled = true; $('analyze').disabled = true;
    boardEl.parentElement.classList.add('playing');
    const cap = $('caption');
    const pos = new E.Position(startFen);
    let num = pos.fullmove, white = pos.side === E.constants.WHITE;
    const plies = r.pvUci.slice(0, 10);
    try {
      cap.innerHTML = 'Best move for ' + (white ? 'White' : 'Black') + ': <span>' + r.bestSan + '</span><small>Watch the line the engine expects</small>';
      cap.classList.add('show');
      await sleep(1100);
      for (let i = 0; i < plies.length; i++) {
        if (token !== walk.token) return;
        const m = pos.uciToMove(plies[i]);
        if (!m) break;
        const san = r.pvSan[i] || pos.moveToSan(m);
        const label = (white ? num + '. ' : num + '… ') + san;
        cap.innerHTML = '<span>' + label + '</span><small>' + describeMove(pos, m, san) + '</small>';
        await animateMove(pos, m, token);
        if (token !== walk.token) return;
        pos.make(m);
        cellsFromPosition(pos);
        state.side = pos.side === E.constants.WHITE ? 'w' : 'b';
        renderQuiet();
        markTrail(E.util.moveFrom(m), E.util.moveTo(m));
        await sleep(i === 0 ? 1500 : 1100);
        if (!white) num++;
        white = !white;
      }
      if (token !== walk.token) return;
      cap.innerHTML = '<span>Back to the position</span><small>Engine line shown from move one</small>';
      await sleep(1300);
    } finally {
      if (token === walk.token) restoreAfterWalk(startFen, savedResult, savedFlip);
    }
  }
  function markTrail(from, to) {
    for (const d of squares) d.classList.remove('trail');
    for (const d of squares) if ((d.dataset.sq | 0) === from || (d.dataset.sq | 0) === to) d.classList.add('trail');
  }
  function renderQuiet() {
    // render without arrows or the analysis highlight
    const saved = state.result; state.result = null;
    const savedValid = state.valid; state.valid = null;
    render();
    state.result = saved; state.valid = savedValid;
  }
  function animateMove(pos, m, token) {
    const U = E.util;
    const from = U.moveFrom(m), to = U.moveTo(m), flags = U.moveFlags(m);
    const jobs = [[from, to]];
    if (flags & 8) { // castling: the rook glides too
      const r = to >> 3;
      if ((to & 7) === 6) jobs.push([r * 8 + 7, r * 8 + 5]); else jobs.push([r * 8, r * 8 + 3]);
    }
    let capturedSq = (flags & 1) ? to : -1;
    if (flags & 4) capturedSq = to + (pos.side === E.constants.WHITE ? -8 : 8);
    const wrap = $('boardwrap');
    const ghosts = [];
    for (const [f, t] of jobs) {
      const fromEl = squares.find((d) => (d.dataset.sq | 0) === f);
      const pieceEl = fromEl && fromEl.querySelector('.piece');
      if (!pieceEl) continue;
      const g = document.createElement('div');
      g.className = 'ghost';
      const p = pieceEl.cloneNode(true);
      p.style.fontSize = getComputedStyle(pieceEl).fontSize;
      g.appendChild(p);
      const a = visualRect(f), b = visualRect(t);
      g.style.left = a.x + '%'; g.style.top = a.y + '%';
      g.style.transform = 'translate(0,0)';
      wrap.appendChild(g);
      pieceEl.style.visibility = 'hidden';
      ghosts.push({ g, pieceEl, dx: (b.x - a.x) / 12.5, dy: (b.y - a.y) / 12.5 });
    }
    if (capturedSq >= 0) {
      const el = squares.find((d) => (d.dataset.sq | 0) === capturedSq);
      const pe = el && el.querySelector('.piece');
      if (pe) pe.classList.add('fade');
    }
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const gh of ghosts) gh.g.style.transform = 'translate(' + (gh.dx * 100) + '%, ' + (gh.dy * 100) + '%)';
        setTimeout(() => {
          for (const gh of ghosts) { gh.g.remove(); gh.pieceEl.style.visibility = ''; }
          resolve();
        }, 740);
      }));
    });
  }
  function restoreAfterWalk(startFen, savedResult, savedFlip) {
    walk.running = false;
    $('caption').classList.remove('show');
    boardEl.parentElement.classList.remove('playing');
    for (const d of squares) d.classList.remove('trail');
    for (const g of document.querySelectorAll('.ghost')) g.remove();
    $('watch').textContent = 'Watch the line';
    state.flipped = savedFlip;
    const pos = new E.Position(startFen);
    cellsFromPosition(pos);
    state.side = pos.side === E.constants.WHITE ? 'w' : 'b';
    state.halfmove = pos.halfmove; state.fullmove = pos.fullmove;
    state.valid = E.validateFen(startFen);
    state.result = savedResult;
    render();
    $('play').disabled = false; $('analyze').disabled = false; $('watch').disabled = false;
  }
  function stopWalk() {
    if (!walk.running) return;
    walk.token++;
    // restore is handled by the running walk's finally via a fresh token check,
    // so do it here explicitly with the saved position
    const saved = walk.saved;
    if (saved) restoreAfterWalk(saved.fen, saved.result, saved.flip);
  }
  $('watch').addEventListener('click', watchLine);

  // ------------------------------------------------------ picture reading
  let sample = null, visionReady = false, imageLimits = null;
  const visionNote = $('visionnote');
  function setVisionNote(text, cls) { visionNote.textContent = text; visionNote.className = 'note' + (cls ? ' ' + cls : ''); visionNote.hidden = !text; }

  async function initVision() {
    if (!window.claude || typeof window.claude.use !== 'function') {
      setVisionNote('Reading pictures works when this page is opened from claude.ai, where it can ask Claude to read the board. Here, set up the position with the pieces above or paste a FEN.');
      return;
    }
    try {
      sample = await window.claude.use('sample');
      if (sample) imageLimits = await sample.limits().catch(() => null);
    } catch (e) { sample = null; }
    visionReady = !!(sample && imageLimits && imageLimits.images);
    if (!visionReady) setVisionNote('This viewer cannot send pictures to Claude, so paste a FEN or set up the pieces by hand instead.');
    else if (imageLimits.images.mediaTypes && imageLimits.images.mediaTypes.length) $('file').accept = imageLimits.images.mediaTypes.join(',');
  }
  initVision();

  function readPrompt() {
    return [
      'The attached image shows a chess position: a diagram, a screenshot from a chess website or app, or a photo of a real board.',
      'Read it square by square and report the exact position as JSON with these keys:',
      '- "rows": exactly 8 strings, the TOP row of the image first, each exactly 8 characters, left to right as seen in the image. Use uppercase KQRBNP for White\'s pieces (the light-coloured set), lowercase kqrbnp for Black\'s pieces (the dark-coloured set), and "." for an empty square. Highlighted or coloured squares are still just squares.',
      '- "white_at_bottom": true if White\'s side of the board is at the bottom of the image (rank 1 at the bottom, the "a" file on the left), false if Black is at the bottom. Use printed coordinates when visible; otherwise infer it from where the pawns are heading (pawns move away from their own back rank).',
      '- "side_to_move": "w", "b" or "unknown". Only answer w or b if the image shows it (text like "White to play", a clock or turn indicator, a last-move highlight); otherwise "unknown".',
      '- "notes": one short sentence naming anything you were unsure about, or an empty string.',
      'Be meticulous: check each of the 64 squares, tell bishops from pawns and queens from kings carefully, and count: each side has exactly one king and at most eight pawns.',
      'Reply with only the JSON object.',
    ].join('\n');
  }

  async function readImage(file, careful) {
    if (!file) return;
    state.lastImage = file;
    const thumb = $('thumb');
    thumb.classList.add('show');
    const url = URL.createObjectURL(file);
    $('thumbimg').src = url;
    if (!visionReady) {
      if (!sample && window.claude && typeof window.claude.use === 'function') await initVision();
      if (!visionReady) { $('readstatus').textContent = 'Cannot read pictures in this viewer.'; return; }
    }
    $('readstatus').textContent = careful ? 'Reading carefully…' : 'Reading the board…';
    $('reread').disabled = true;
    try {
      const data = await sample.json(readPrompt(), { images: file, modelTier: careful ? 'complex' : 'default', cache: !careful });
      const parsed = parseReading(data);
      pushHistory();
      state.flipped = !parsed.whiteAtBottom;
      state.result = null;
      let check = loadFen(parsed.fen, { silent: true });
      if (!check.ok && /cannot be .* turn/.test(check.reason || '')) {
        // The side to move was a guess: try the other side.
        state.side = state.side === 'w' ? 'b' : 'w';
        check = revalidate();
        render();
        if (check.ok) parsed.sideNote = 'Side to move was inferred from who is in check.';
      }
      let status = 'Read from the picture.';
      if (parsed.sideToMove === 'unknown') status += ' The picture does not say whose move it is; White is assumed. Switch below if needed.';
      if (parsed.sideNote) status += ' ' + parsed.sideNote;
      if (parsed.notes) status += ' Claude noted: ' + parsed.notes;
      if (!check.ok) status += ' ' + check.reason;
      $('readstatus').textContent = status + ' Check the pieces against the picture, then trust the move.';
      if (check.ok) analyze();
    } catch (err) {
      const code = err && err.code;
      let msg;
      if (code === 'not_granted') msg = 'Reading was declined, so the picture was not sent to Claude. Set the position up by hand or paste a FEN.';
      else if (code === 'rate_limited') msg = 'Too many reads at once. Wait a moment and choose "Read again".';
      else if (code === 'images_unavailable' || code === 'image_rejected') msg = 'That picture could not be sent. Try a PNG or JPEG screenshot of just the board.';
      else if (code === 'invalid_json' || (err && err.message && /rows/.test(err.message))) msg = 'Claude could not read a full board from that picture. Try a clearer, closer crop and choose "Read again, carefully".';
      else if (code === 'cancelled') msg = 'Reading stopped.';
      else msg = 'Reading failed' + (err && err.message ? ': ' + err.message : '.') + ' Try again, or set the position up by hand.';
      $('readstatus').textContent = msg;
    } finally {
      $('reread').disabled = false;
    }
  }
  function parseReading(data) {
    if (!data || !Array.isArray(data.rows) || data.rows.length !== 8) throw new Error('No rows in the reading');
    let rows = data.rows.map((r) => String(r).replace(/\s+/g, ''));
    for (const r of rows) if (r.length !== 8 || /[^KQRBNPkqrbnp.\-_0]/.test(r)) throw new Error('Bad rows in the reading');
    const whiteAtBottom = data.white_at_bottom !== false;
    if (!whiteAtBottom) rows = rows.slice().reverse().map((r) => r.split('').reverse().join(''));
    const placement = rows.map((r) => {
      let out = '', empty = 0;
      for (const ch of r) {
        if (/[KQRBNPkqrbnp]/.test(ch)) { if (empty) { out += empty; empty = 0; } out += ch; }
        else empty++;
      }
      if (empty) out += empty;
      return out;
    }).join('/');
    const stm = data.side_to_move === 'b' ? 'b' : data.side_to_move === 'w' ? 'w' : 'unknown';
    // castling: allow whatever the placement permits; validateFen prunes the rest
    const fen = placement + ' ' + (stm === 'b' ? 'b' : 'w') + ' KQkq - 0 1';
    return { fen, whiteAtBottom, sideToMove: stm, notes: typeof data.notes === 'string' ? data.notes.trim() : '' };
  }

  // paste, drop, file chooser
  const FEN_RE = /^([pnbrqkPNBRQK1-8]+\/){7}[pnbrqkPNBRQK1-8]+(\s+[wb](\s+(-|[KQkq]{1,4})(\s+(-|[a-h][36])(\s+\d+(\s+\d+)?)?)?)?)?\s*$/;
  document.addEventListener('paste', (e) => {
    if (e.target && (e.target.id === 'fen')) return;
    const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
    const img = items.find((it) => it.type && it.type.startsWith('image/'));
    if (img) { e.preventDefault(); readImage(img.getAsFile(), false); return; }
    const text = e.clipboardData ? e.clipboardData.getData('text') : '';
    if (text && FEN_RE.test(text.trim())) { e.preventDefault(); pushHistory(); state.result = null; loadFen(text.trim().split(/\s+/).length >= 2 ? text.trim() : text.trim() + ' w'); }
  });
  const wrap = $('boardwrap');
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragover'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('dragover'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault(); wrap.classList.remove('dragover');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) readImage(f, false);
  });
  $('pastetarget').addEventListener('click', () => $('file').click());
  $('pastetarget').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
  $('file').addEventListener('change', () => { const f = $('file').files && $('file').files[0]; if (f) readImage(f, false); $('file').value = ''; });
  $('reread').addEventListener('click', () => { if (state.lastImage) readImage(state.lastImage, true); });

  // ------------------------------------------------------------------ boot
  function readHash() {
    const h = location.hash.replace(/^#/, '');
    if (!h) return null;
    const q = new URLSearchParams(h);
    const fen = (q.get('fen') || '').trim();
    if (!fen || !FEN_RE.test(fen)) return null;
    return { fen: fen.split(/\s+/).length >= 2 ? fen : fen + ' w', flip: q.get('flip') === '1', play: q.get('play') === '1' };
  }
  function writeHash() {
    if (!state.valid || !state.valid.ok) return;
    const q = new URLSearchParams();
    q.set('fen', state.valid.fen);
    if (state.flipped) q.set('flip', '1');
    try { history.replaceState(null, '', '#' + q.toString().replace(/%20/g, '+')); } catch (e) { /* ignore */ }
  }
  buildBoard();
  const fromHash = readHash();
  if (fromHash) { state.flipped = fromHash.flip; autoWatch = fromHash.play; loadFen(fromHash.fen); }
  else { autoWatch = true; loadFen(SAMPLE_FEN); }
})();
