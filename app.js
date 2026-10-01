(function () {
  'use strict';

  var GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  var FILES = 'abcdefgh';
  var STORE = 'mnemoi.game.v1';

  var game = new Chess();
  var boardEl = document.getElementById('board');
  var statusEl = document.getElementById('status');
  var movesEl = document.querySelector('#moves ol');
  var modeEl = document.getElementById('mode');
  var levelEl = document.getElementById('level');
  var colorEl = document.getElementById('color');

  var flipped = false;
  var selected = null;
  var lastMove = null;
  var thinking = false;
  var reported = false;   // risultato già inviato al profilo per questa partita

  // ---------- Salvataggio locale (solo nel browser dell'utente) ----------
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        pgn: game.pgn(), reported: reported, mode: modeEl.value, level: levelEl.value, color: colorEl.value, flipped: flipped
      }));
    } catch (e) {}
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (!s) return;
      modeEl.value = s.mode || 'ai';
      levelEl.value = s.level || '2';
      colorEl.value = s.color || 'w';
      flipped = !!s.flipped;
      reported = !!s.reported;
      if (s.pgn) game.load_pgn(s.pgn);
      var h = game.history({ verbose: true });
      if (h.length) lastMove = h[h.length - 1];
    } catch (e) { game.reset(); }
  }

  // ---------- Disegno ----------
  function squareName(r, f) { return FILES[f] + (8 - r); }

  function kingSquare(color) {
    var b = game.board();
    for (var r = 0; r < 8; r++) for (var f = 0; f < 8; f++) {
      var p = b[r][f];
      if (p && p.type === 'k' && p.color === color) return squareName(r, f);
    }
    return null;
  }

  function render() {
    var targets = {};
    if (selected) {
      game.moves({ square: selected, verbose: true }).forEach(function (m) {
        targets[m.to] = !!(m.captured || m.flags.indexOf('e') >= 0);
      });
    }
    var checkSq = game.in_check() ? kingSquare(game.turn()) : null;
    var b = game.board();
    var html = '';
    for (var i = 0; i < 8; i++) {
      for (var j = 0; j < 8; j++) {
        var r = flipped ? 7 - i : i;
        var f = flipped ? 7 - j : j;
        var sq = squareName(r, f);
        var cls = 'sq ' + ((r + f) % 2 === 0 ? 'l' : 'd');
        if (lastMove && (lastMove.from === sq || lastMove.to === sq)) cls += ' last';
        if (selected === sq) cls += ' sel';
        if (checkSq === sq) cls += ' check';
        if (sq in targets) cls += ' hint' + (targets[sq] ? ' cap' : '');
        var p = b[r][f];
        html += '<div class="' + cls + '" data-sq="' + sq + '">';
        if (j === 7) html += '<span class="coord r">' + (8 - r) + '</span>';
        if (i === 7) html += '<span class="coord f">' + FILES[f] + '</span>';
        if (p) html += '<span class="pc ' + p.color + '">' + GLYPH[p.type] + '</span>';
        html += '</div>';
      }
    }
    boardEl.innerHTML = html;
    renderMoves();
    renderCaptured();
    renderStatus();
    document.getElementById('undo').disabled = thinking || game.history().length === 0;
    document.getElementById('levelBox').style.display = modeEl.value === 'ai' ? '' : 'none';
    document.getElementById('colorBox').style.display = modeEl.value === 'ai' ? '' : 'none';
  }

  function renderMoves() {
    var h = game.history();
    var out = '';
    for (var i = 0; i < h.length; i += 2) {
      out += '<li>' + h[i] + (h[i + 1] ? '&nbsp;&nbsp;' + h[i + 1] : '') + '</li>';
    }
    movesEl.innerHTML = out;
    var box = movesEl.parentNode;
    box.scrollTop = box.scrollHeight;
  }

  function renderCaptured() {
    var capByW = [], capByB = [];
    game.history({ verbose: true }).forEach(function (m) {
      if (m.captured) (m.color === 'w' ? capByW : capByB).push(m.captured);
    });
    var order = 'qrbnp';
    function fmt(list, color) {
      return list.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); })
        .map(function (t) { return '<span class="pc ' + color + '">' + GLYPH[t] + '</span>'; }).join('');
    }
    document.getElementById('capW').innerHTML = fmt(capByW, 'b');
    document.getElementById('capB').innerHTML = fmt(capByB, 'w');
  }

  function renderStatus() {
    var side = game.turn() === 'w' ? 'Bianco' : 'Nero';
    var s;
    if (game.in_checkmate()) s = 'Scacco matto! Vince il ' + (game.turn() === 'w' ? 'Nero' : 'Bianco') + '.';
    else if (game.in_stalemate()) s = 'Patta per stallo.';
    else if (game.in_threefold_repetition()) s = 'Patta per triplice ripetizione.';
    else if (game.insufficient_material()) s = 'Patta per materiale insufficiente.';
    else if (game.in_draw()) s = 'Patta (regola delle 50 mosse).';
    else if (thinking) s = 'Il computer sta pensando…';
    else s = 'Tocca al ' + side + (game.in_check() ? ' (scacco!)' : '') + '.';
    statusEl.textContent = s;
  }

  // ---------- Interazione ----------
  function humanTurn() {
    if (game.game_over() || thinking) return false;
    return modeEl.value === 'local' || game.turn() === colorEl.value;
  }

  boardEl.addEventListener('click', function (e) {
    var el = e.target.closest('.sq');
    if (!el || !humanTurn()) return;
    var sq = el.getAttribute('data-sq');
    var piece = game.get(sq);

    if (selected) {
      var legal = game.moves({ square: selected, verbose: true }).filter(function (m) { return m.to === sq; });
      if (legal.length) {
        var from = selected;
        selected = null;
        if (legal[0].flags.indexOf('p') >= 0) askPromotion(game.turn(), function (pr) { doMove({ from: from, to: sq, promotion: pr }); });
        else doMove({ from: from, to: sq });
        return;
      }
    }
    selected = (piece && piece.color === game.turn() && selected !== sq) ? sq : null;
    render();
  });

  function askPromotion(color, cb) {
    var dlg = document.getElementById('promoDlg');
    var box = document.getElementById('promoBtns');
    box.innerHTML = '';
    ['q', 'r', 'b', 'n'].forEach(function (t) {
      var btn = document.createElement('button');
      btn.innerHTML = '<span class="pc ' + color + '">' + GLYPH[t] + '</span>';
      btn.onclick = function () { dlg.close(); cb(t); };
      box.appendChild(btn);
    });
    if (dlg.showModal) dlg.showModal(); else cb('q');
  }

  function doMove(m) {
    var res = game.move(m);
    if (!res) { render(); return; }
    lastMove = res;
    save();
    render();
    reportIfOver();
    maybeComputer();
  }

  // A fine partita contro il computer comunica il risultato all'account (monete e statistiche)
  function reportIfOver() {
    if (reported || !game.game_over() || modeEl.value !== 'ai') return;
    reported = true;
    save();
    var result = 'draw';
    if (game.in_checkmate()) result = game.turn() === colorEl.value ? 'loss' : 'win';
    if (window.MnemoiAccount) window.MnemoiAccount.onGameEnd(result, parseInt(levelEl.value, 10), Math.ceil(game.history().length / 2));
  }

  function maybeComputer() {
    if (modeEl.value !== 'ai' || game.game_over() || game.turn() === colorEl.value) return;
    thinking = true;
    render();
    setTimeout(function () {
      var mv = bestMove(parseInt(levelEl.value, 10));
      thinking = false;
      if (mv) { lastMove = game.move(mv); save(); }
      render();
      reportIfOver();
    }, 250);
  }

  document.getElementById('newGame').onclick = function () {
    game.reset(); selected = null; lastMove = null; thinking = false; reported = false;
    if (modeEl.value === 'ai') flipped = colorEl.value === 'b';
    save(); render(); maybeComputer();
  };
  document.getElementById('undo').onclick = function () {
    if (thinking) return;
    game.undo();
    // Contro il computer annulla anche la sua risposta, così torna il turno del giocatore
    if (modeEl.value === 'ai' && game.turn() !== colorEl.value) game.undo();
    var h = game.history({ verbose: true });
    lastMove = h.length ? h[h.length - 1] : null;
    selected = null; save(); render(); maybeComputer();
  };
  document.getElementById('flip').onclick = function () { flipped = !flipped; save(); render(); };
  modeEl.onchange = levelEl.onchange = function () { save(); render(); maybeComputer(); };
  colorEl.onchange = function () { flipped = colorEl.value === 'b'; save(); render(); maybeComputer(); };

  // ---------- Motore: alfa-beta con tabelle posizionali ----------
  var VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  // Tabelle dal punto di vista del Bianco, riga 0 = ottava traversa
  var PST = {
    p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
        0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
    n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
        -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
    b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
        -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
    r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
        -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
    q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5,
        0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
    k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
        -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20]
  };

  // Valutazione dal punto di vista di chi deve muovere
  function evaluate() {
    var b = game.board(), score = 0;
    for (var r = 0; r < 8; r++) for (var f = 0; f < 8; f++) {
      var p = b[r][f];
      if (!p) continue;
      var idx = p.color === 'w' ? r * 8 + f : (7 - r) * 8 + f;
      var v = VAL[p.type] + PST[p.type][idx];
      score += p.color === 'w' ? v : -v;
    }
    return game.turn() === 'w' ? score : -score;
  }

  function ordered(moves) {
    return moves.sort(function (a, b) {
      return (b.captured ? 10 * VAL[b.captured] - VAL[b.piece] : 0) + (b.promotion ? 800 : 0) -
             ((a.captured ? 10 * VAL[a.captured] - VAL[a.piece] : 0) + (a.promotion ? 800 : 0));
    });
  }

  var MATE = 100000;
  function negamax(depth, alpha, beta, ply) {
    if (game.in_checkmate()) return -MATE + ply;
    if (game.in_draw() || game.in_stalemate()) return 0;
    if (depth === 0) return evaluate();
    var moves = ordered(game.moves({ verbose: true }));
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      game.move(moves[i]);
      var s = -negamax(depth - 1, -beta, -alpha, ply + 1);
      game.undo();
      if (s > best) best = s;
      if (s > alpha) alpha = s;
      if (alpha >= beta) break;
    }
    return best;
  }

  function bestMove(level) {
    var moves = ordered(game.moves({ verbose: true }));
    if (!moves.length) return null;
    var depth = level === 1 ? 1 : level === 2 ? 2 : 3;
    var noise = level === 1 ? 120 : level === 2 ? 25 : 0;
    var best = null, bestScore = -Infinity, alpha = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      game.move(moves[i]);
      var s = -negamax(depth - 1, -Infinity, -alpha, 1) + (noise ? Math.random() * noise : 0);
      game.undo();
      if (s > bestScore) { bestScore = s; best = moves[i]; }
      if (s > alpha && !noise) alpha = s;
    }
    return best;
  }

  // ---------- Avviso informativo (nessun consenso necessario: solo archiviazione tecnica) ----------
  var notice = document.getElementById('notice');
  try { if (!localStorage.getItem('mnemoi.notice')) notice.classList.add('show'); } catch (e) {}
  document.getElementById('noticeOk').onclick = function () {
    notice.classList.remove('show');
    try { localStorage.setItem('mnemoi.notice', '1'); } catch (e) {}
  };
  document.getElementById('yr').textContent = new Date().getFullYear();

  load();
  render();
  maybeComputer();
})();
