/*
 * Mnemoi: motore delle varianti di scacchi.
 * Usato sia dal browser sia dal server delle partite (supabase/functions/partite).
 * Caselle: 0 = a1, 7 = h1, 56 = a8, 63 = h8.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MnemoiEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VARIANTS = {
    standard:  { name: 'Classica', short: 'Le regole di sempre.' },
    chess960:  { name: 'Chess960', short: 'Pezzi della prima traversa mescolati a caso (960 posizioni possibili). Arrocco come negli scacchi classici: re e torre finiscono sulle solite case.' },
    atomic:    { name: 'Atomica', short: 'Ogni cattura fa esplodere i pezzi intorno (tranne i pedoni). Vince chi fa esplodere il re avversario o dà scacco matto. Il re non può catturare.' },
    hidden:    { name: 'Regina nascosta', short: 'La regina parte travestita da pedone: a inizio partita il sito ne sceglie uno a caso. Si svela quando si muove come una regina, quando arriva in fondo o quando attacca un re. Se porti il re sotto la regina nascosta senza saperlo, l\'avversario può catturarlo e vince.' },
    '3check':  { name: 'Tre scacchi', short: 'Vince chi dà scacco tre volte, oppure scacco matto.' },
    koth:      { name: 'Re della collina', short: 'Vince chi porta il proprio re in una delle quattro case centrali (d4, e4, d5, e5), oppure dà scacco matto.' },
    antichess: { name: 'Vinci-perdi', short: 'Catturare è obbligatorio e il re è un pezzo come gli altri. Vince chi perde tutti i pezzi o resta senza mosse.' },
    racing:    { name: 'Corsa dei re', short: 'Niente pedoni e niente scacchi: vince chi porta per primo il re in ottava traversa. Se il Bianco arriva per primo e il Nero lo raggiunge alla mossa successiva, è patta.' }
  };
  var ORDER = ['standard', 'chess960', 'atomic', 'hidden', '3check', 'koth', 'antichess', 'racing'];

  var START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  var START_FEN = {
    standard: START,
    atomic: START,
    '3check': START,
    koth: START,
    antichess: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1',
    racing: '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1',
    hidden: 'rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1'
  };

  var FILES = 'abcdefgh';
  var N_OFF = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  var K_OFF = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  var B_DIR = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  var R_DIR = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function fileOf(s) { return s & 7; }
  function rankOf(s) { return s >> 3; }
  function sq(f, r) { return r * 8 + f; }
  function onBoard(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }
  function sqName(s) { return FILES[fileOf(s)] + (rankOf(s) + 1); }
  function parseSq(n) { return sq(FILES.indexOf(n[0]), parseInt(n[1], 10) - 1); }
  function other(c) { return c === 'w' ? 'b' : 'w'; }
  function piece(c, t, extra) {
    var p = { c: c, t: t };
    if (extra) for (var k in extra) p[k] = extra[k];
    return p;
  }

  // ---------- FEN ----------
  function fromFen(fen, variant) {
    var parts = fen.trim().split(/\s+/);
    var b = new Array(64).fill(null);
    var rows = parts[0].split('/');
    for (var r = 0; r < 8; r++) {
      var f = 0;
      for (var i = 0; i < rows[r].length; i++) {
        var ch = rows[r][i];
        if (/\d/.test(ch)) f += parseInt(ch, 10);
        else {
          var c = ch === ch.toUpperCase() ? 'w' : 'b';
          b[sq(f, 7 - r)] = piece(c, ch.toLowerCase());
          f++;
        }
      }
    }
    var pos = {
      variant: variant || 'standard',
      b: b,
      turn: parts[1] || 'w',
      castle: { w: [], b: [] },
      ep: parts[3] && parts[3] !== '-' ? parseSq(parts[3]) : -1,
      half: parseInt(parts[4] || '0', 10),
      full: parseInt(parts[5] || '1', 10),
      checks: { w: 0, b: 0 },
      revealed: []
    };
    var cr = parts[2] || '-';
    if (cr !== '-') {
      for (var j = 0; j < cr.length; j++) {
        var ch2 = cr[j];
        var col = ch2 === ch2.toUpperCase() ? 'w' : 'b';
        var rank = col === 'w' ? 0 : 7;
        var k = findKing(pos, col);
        var L = ch2.toLowerCase();
        var rookSq = -1;
        if (L === 'k' || L === 'q') {
          var step = L === 'k' ? 1 : -1;
          for (var ff = L === 'k' ? 7 : 0; ff >= 0 && ff < 8; ff -= step) {
            var p = b[sq(ff, rank)];
            if (p && p.c === col && p.t === 'r') { rookSq = sq(ff, rank); break; }
          }
          if (k >= 0 && rookSq >= 0 && (L === 'k' ? fileOf(rookSq) < fileOf(k) : fileOf(rookSq) > fileOf(k))) rookSq = -1;
        } else {
          rookSq = sq(FILES.indexOf(L), rank);
        }
        if (rookSq >= 0 && pos.castle[col].indexOf(rookSq) < 0) pos.castle[col].push(rookSq);
      }
    }
    if (parts[6] && /^\d\+\d$/.test(parts[6])) {
      // contatore tre scacchi: "scacchi ancora da dare" come nei FEN di lichess (es. 3+3)
      var cc = parts[6].split('+');
      pos.checks.w = 3 - parseInt(cc[0], 10);
      pos.checks.b = 3 - parseInt(cc[1], 10);
    }
    return pos;
  }

  function toFen(pos) {
    var out = [];
    for (var r = 7; r >= 0; r--) {
      var row = '', empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = pos.b[sq(f, r)];
        if (!p) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        var t = p.t;
        if (p.h && !p.rv) t = 'p'; // la regina nascosta non revelata appare come pedone
        row += p.c === 'w' ? t.toUpperCase() : t;
      }
      if (empty) row += empty;
      out.push(row);
    }
    var cr = '';
    ['w', 'b'].forEach(function (c) {
      pos.castle[c].slice().sort(function (a, b) { return b - a; }).forEach(function (s) {
        var L = FILES[fileOf(s)];
        cr += c === 'w' ? L.toUpperCase() : L;
      });
    });
    return out.join('/') + ' ' + pos.turn + ' ' + (cr || '-') + ' ' + (pos.ep >= 0 ? sqName(pos.ep) : '-') + ' ' + pos.half + ' ' + pos.full;
  }

  function clonePos(pos) {
    return {
      variant: pos.variant,
      b: pos.b.slice(),
      turn: pos.turn,
      castle: { w: pos.castle.w.slice(), b: pos.castle.b.slice() },
      ep: pos.ep,
      half: pos.half,
      full: pos.full,
      checks: { w: pos.checks.w, b: pos.checks.b },
      revealed: []
    };
  }

  function findKing(pos, c) {
    for (var i = 0; i < 64; i++) { var p = pos.b[i]; if (p && p.c === c && p.t === 'k') return i; }
    return -1;
  }

  // Regina nascosta: segna il pedone in "s" come regina travestita
  function setHidden(pos, s) {
    var p = pos.b[s];
    if (!p || p.t !== 'p') throw new Error('La regina nascosta deve essere un pedone');
    pos.b[s] = piece(p.c, 'q', { h: true, rv: false });
  }
  function isDisguised(p) { return !!(p && p.h && !p.rv); }

  // ---------- Attacchi ----------
  // opts.noKing: il re non attacca (atomica). opts.hiddenAsPawn: le regine nascoste non svelate attaccano solo come pedoni.
  function attacked(pos, s, by, opts) {
    opts = opts || {};
    var b = pos.b, f = fileOf(s), r = rankOf(s);
    var pr = by === 'w' ? r - 1 : r + 1;
    for (var df = -1; df <= 1; df += 2) {
      if (onBoard(f + df, pr)) {
        var p = b[sq(f + df, pr)];
        if (p && p.c === by && (p.t === 'p' || isDisguised(p))) return true;
      }
    }
    for (var i = 0; i < 8; i++) {
      var nf = f + N_OFF[i][0], nr = r + N_OFF[i][1];
      if (onBoard(nf, nr)) { var pn = b[sq(nf, nr)]; if (pn && pn.c === by && pn.t === 'n') return true; }
    }
    if (!opts.noKing) {
      for (var k = 0; k < 8; k++) {
        var kf = f + K_OFF[k][0], kr = r + K_OFF[k][1];
        if (onBoard(kf, kr)) { var pk = b[sq(kf, kr)]; if (pk && pk.c === by && pk.t === 'k') return true; }
      }
    }
    function slide(dirs, types) {
      for (var d = 0; d < dirs.length; d++) {
        var cf = f + dirs[d][0], cr = r + dirs[d][1];
        while (onBoard(cf, cr)) {
          var q = b[sq(cf, cr)];
          if (q) {
            if (q.c === by && types.indexOf(q.t) >= 0 && !(opts.hiddenAsPawn && isDisguised(q))) return true;
            break;
          }
          cf += dirs[d][0]; cr += dirs[d][1];
        }
      }
      return false;
    }
    return slide(B_DIR, ['b', 'q']) || slide(R_DIR, ['r', 'q']);
  }

  function kingsAdjacent(pos) {
    var a = findKing(pos, 'w'), k = findKing(pos, 'b');
    if (a < 0 || k < 0) return false;
    return Math.abs(fileOf(a) - fileOf(k)) <= 1 && Math.abs(rankOf(a) - rankOf(k)) <= 1;
  }

  // È sotto scacco il re di colore c? (dal punto di vista delle regole della variante)
  function kingInCheck(pos, c, opts) {
    var v = pos.variant;
    if (v === 'antichess') return false;
    var k = findKing(pos, c);
    if (k < 0) return false;
    if (v === 'atomic') {
      if (kingsAdjacent(pos)) return false;
      return attacked(pos, k, other(c), { noKing: true });
    }
    return attacked(pos, k, other(c), opts);
  }

  function inCheck(pos) {
    return kingInCheck(pos, pos.turn, { hiddenAsPawn: pos.variant === 'hidden' });
  }

  // ---------- Generazione mosse ----------
  function pawnTargets(pos, s, p) {
    // mosse "da pedone" di un pezzo in s (pedone o regina travestita)
    var res = [];
    var b = pos.b, f = fileOf(s), r = rankOf(s);
    var dir = p.c === 'w' ? 1 : -1;
    var startRank = p.c === 'w' ? 1 : 6;
    var r1 = r + dir;
    if (!onBoard(f, r1)) return res;
    if (!b[sq(f, r1)]) {
      res.push({ to: sq(f, r1) });
      var r2 = r + 2 * dir;
      if (r === startRank && !b[sq(f, r2)]) res.push({ to: sq(f, r2), dbl: true });
    }
    for (var df = -1; df <= 1; df += 2) {
      if (!onBoard(f + df, r1)) continue;
      var t = sq(f + df, r1), q = b[t];
      if (q && q.c !== p.c) res.push({ to: t, cap: true });
      else if (!q && t === pos.ep) res.push({ to: t, ep: true, cap: true });
    }
    return res;
  }

  function pieceTargets(pos, s, p, type) {
    var res = [], b = pos.b, f = fileOf(s), r = rankOf(s);
    function step(offs) {
      for (var i = 0; i < offs.length; i++) {
        var nf = f + offs[i][0], nr = r + offs[i][1];
        if (!onBoard(nf, nr)) continue;
        var q = b[sq(nf, nr)];
        if (!q || q.c !== p.c) res.push(sq(nf, nr));
      }
    }
    function slide(dirs) {
      for (var d = 0; d < dirs.length; d++) {
        var cf = f + dirs[d][0], cr = r + dirs[d][1];
        while (onBoard(cf, cr)) {
          var q = b[sq(cf, cr)];
          if (!q) res.push(sq(cf, cr));
          else { if (q.c !== p.c) res.push(sq(cf, cr)); break; }
          cf += dirs[d][0]; cr += dirs[d][1];
        }
      }
    }
    if (type === 'n') step(N_OFF);
    else if (type === 'k') step(K_OFF);
    else if (type === 'b') slide(B_DIR);
    else if (type === 'r') slide(R_DIR);
    else if (type === 'q') { slide(B_DIR); slide(R_DIR); }
    return res;
  }

  function promoPieces(v) { return v === 'antichess' ? ['q', 'r', 'b', 'n', 'k'] : ['q', 'r', 'b', 'n']; }

  function pseudoMoves(pos) {
    var moves = [], c = pos.turn, v = pos.variant, b = pos.b;
    var lastRank = c === 'w' ? 7 : 0;
    for (var s = 0; s < 64; s++) {
      var p = b[s];
      if (!p || p.c !== c) continue;
      if (p.t === 'p' || isDisguised(p)) {
        var pts = pawnTargets(pos, s, p);
        for (var i = 0; i < pts.length; i++) {
          var t = pts[i];
          if (rankOf(t.to) === lastRank) {
            if (isDisguised(p)) moves.push({ from: s, to: t.to, ep: !!t.ep, dbl: false, pawnLike: true });
            else promoPieces(v).forEach(function (pr) { moves.push({ from: s, to: t.to, promo: pr }); });
          } else {
            moves.push({ from: s, to: t.to, ep: !!t.ep, dbl: !!t.dbl, pawnLike: isDisguised(p) || undefined });
          }
        }
        if (isDisguised(p)) {
          var seen = {};
          pts.forEach(function (t2) { seen[t2.to] = true; });
          pieceTargets(pos, s, p, 'q').forEach(function (to) {
            if (!seen[to]) moves.push({ from: s, to: to, queenLike: true });
          });
        }
        continue;
      }
      pieceTargets(pos, s, p, p.t).forEach(function (to) { moves.push({ from: s, to: to }); });
      if (p.t === 'k') castleMoves(pos, s, moves);
    }
    return moves;
  }

  function castleMoves(pos, kSq, moves) {
    var c = pos.turn, v = pos.variant;
    if (v === 'antichess' || v === 'racing') return;
    var rank = c === 'w' ? 0 : 7;
    if (rankOf(kSq) !== rank) return;
    var enemy = other(c);
    var hiddenOpt = { hiddenAsPawn: v === 'hidden' };
    if (kingInCheck(pos, c, hiddenOpt)) return;
    pos.castle[c].forEach(function (rSq) {
      var rook = pos.b[rSq];
      if (!rook || rook.c !== c || rook.t !== 'r') return;
      var kingSide = fileOf(rSq) > fileOf(kSq);
      var kTo = sq(kingSide ? 6 : 2, rank), rTo = sq(kingSide ? 5 : 3, rank);
      var lo = Math.min(kSq, kTo, rSq, rTo), hi = Math.max(kSq, kTo, rSq, rTo);
      for (var s = lo; s <= hi; s++) if (s !== kSq && s !== rSq && pos.b[s]) return;
      var a = Math.min(kSq, kTo), z = Math.max(kSq, kTo);
      for (var s2 = a; s2 <= z; s2++) {
        if (v === 'atomic') {
          // il re non è "sotto scacco" se è accanto al re avversario
          var ek = findKing(pos, enemy);
          var adj = ek >= 0 && Math.abs(fileOf(s2) - fileOf(ek)) <= 1 && Math.abs(rankOf(s2) - rankOf(ek)) <= 1;
          if (!adj && attackedWithout(pos, s2, enemy, [kSq, rSq], { noKing: true })) return;
        } else if (attackedWithout(pos, s2, enemy, [kSq, rSq], hiddenOpt)) return;
      }
      moves.push({ from: kSq, to: rSq, castle: true });
    });
  }

  // attacco calcolato togliendo dalla scacchiera alcuni pezzi (re e torre che arroccano)
  function attackedWithout(pos, s, by, removed, opts) {
    var saved = removed.map(function (x) { return pos.b[x]; });
    removed.forEach(function (x) { pos.b[x] = null; });
    var res = attacked(pos, s, by, opts);
    removed.forEach(function (x, i) { pos.b[x] = saved[i]; });
    return res;
  }

  // ---------- Esecuzione mossa ----------
  function makeMove(pos, m) {
    var n = clonePos(pos), b = n.b, c = pos.turn, v = pos.variant;
    var p = b[m.from];
    var captured = null;
    var isPawnMove = p.t === 'p' || isDisguised(p);
    n.ep = -1;
    if (m.castle) {
      var rook = b[m.to];
      var rank = c === 'w' ? 0 : 7;
      var kingSide = fileOf(m.to) > fileOf(m.from);
      b[m.from] = null; b[m.to] = null;
      b[sq(kingSide ? 6 : 2, rank)] = p;
      b[sq(kingSide ? 5 : 3, rank)] = rook;
      n.castle[c] = [];
    } else {
      var capSq = m.to;
      if (m.ep) capSq = m.to + (c === 'w' ? -8 : 8);
      captured = b[capSq];
      b[capSq] = null;
      b[m.from] = null;
      var moved = p;
      if (isDisguised(p)) {
        var lastRank = c === 'w' ? 7 : 0;
        if (m.queenLike || rankOf(m.to) === lastRank) moved = piece(p.c, 'q', { h: true, rv: true });
        else isPawnMove = true;
      } else if (m.promo) moved = piece(c, m.promo);
      b[m.to] = moved;
      if (moved !== p && moved.rv) n.revealed.push(m.to);
      if (m.dbl) n.ep = m.from + (c === 'w' ? 8 : -8);
      if (p.t === 'k') n.castle[c] = [];
      n.castle[c] = n.castle[c].filter(function (s) { return s !== m.from; });
      n.castle[other(c)] = n.castle[other(c)].filter(function (s) { return s !== capSq; });
      if (v === 'atomic' && captured) {
        b[m.to] = null;
        var f = fileOf(m.to), r = rankOf(m.to);
        for (var i = 0; i < 8; i++) {
          var nf = f + K_OFF[i][0], nr = r + K_OFF[i][1];
          if (!onBoard(nf, nr)) continue;
          var s = sq(nf, nr), q = b[s];
          if (q && q.t !== 'p') {
            b[s] = null;
            n.castle.w = n.castle.w.filter(function (x) { return x !== s; });
            n.castle.b = n.castle.b.filter(function (x) { return x !== s; });
            if (q.t === 'k') n.castle[q.c] = [];
          }
        }
      }
    }
    n.half = (isPawnMove || captured) ? 0 : pos.half + 1;
    if (c === 'b') n.full = pos.full + 1;
    n.turn = other(c);
    if (v === '3check' && kingInCheck(n, n.turn)) n.checks[c]++;
    if (v === 'hidden') {
      // ogni regina nascosta che attacca un re viene svelata
      for (var s3 = 0; s3 < 64; s3++) {
        var hq = b[s3];
        if (!isDisguised(hq)) continue;
        var ek = findKing(n, other(hq.c));
        if (ek >= 0 && pieceTargets(n, s3, hq, 'q').indexOf(ek) >= 0) {
          b[s3] = piece(hq.c, 'q', { h: true, rv: true });
          n.revealed.push(s3);
        }
      }
    }
    n.lastCapture = !!captured;
    return n;
  }

  // ---------- Legalità ----------
  function isLegalAfter(pos, m, n) {
    var c = pos.turn, v = pos.variant;
    if (v === 'antichess') return true;
    if (v === 'atomic') {
      var p = pos.b[m.from];
      if (p.t === 'k' && pos.b[m.to] && !m.castle) return false; // il re non cattura
      if (findKing(n, c) < 0) return false;                       // non puoi far esplodere il tuo re
      if (findKing(n, other(c)) < 0) return true;                 // il re avversario esplode: vinci
      return !kingInCheck(n, c);
    }
    if (v === 'hidden') {
      if (pos.b[m.to] && pos.b[m.to].t === 'k') return true;      // cattura del re
      return !kingInCheck(n, c, { hiddenAsPawn: true });
    }
    if (v === 'racing') {
      if (kingInCheck(n, c)) return false;
      if (kingInCheck(n, other(c))) return false;                 // vietato dare scacco
      return true;
    }
    return !kingInCheck(n, c);
  }

  function legalMoves(pos) {
    if (outcome(pos)) return [];
    var list = [];
    var ps = pseudoMoves(pos);
    for (var i = 0; i < ps.length; i++) {
      var n = makeMove(pos, ps[i]);
      if (isLegalAfter(pos, ps[i], n)) list.push(ps[i]);
    }
    if (pos.variant === 'antichess') {
      var caps = list.filter(function (m) { return !!pos.b[m.to] || m.ep; });
      if (caps.length) list = caps;
    }
    return list;
  }

  // ---------- Fine partita (senza ripetizioni, gestite da Game) ----------
  function insufficient(pos) {
    if (['standard', 'chess960'].indexOf(pos.variant) < 0) return false;
    var minors = [], others = 0;
    for (var i = 0; i < 64; i++) {
      var p = pos.b[i];
      if (!p || p.t === 'k') continue;
      if (p.t === 'n' || p.t === 'b') minors.push({ p: p, s: i });
      else others++;
    }
    if (others) return false;
    if (minors.length <= 1) return true;
    // solo alfieri tutti sullo stesso colore
    var allB = minors.every(function (x) { return x.p.t === 'b'; });
    if (allB) {
      var col = (fileOf(minors[0].s) + rankOf(minors[0].s)) % 2;
      return minors.every(function (x) { return (fileOf(x.s) + rankOf(x.s)) % 2 === col; });
    }
    return false;
  }

  function outcome(pos) {
    var v = pos.variant, c = pos.turn, e = other(c);
    var win = function (col, reason) { return { result: col === 'w' ? '1-0' : '0-1', winner: col, reason: reason }; };
    var draw = function (reason) { return { result: '1/2-1/2', winner: null, reason: reason }; };
    if (v === 'atomic') {
      if (findKing(pos, c) < 0) return win(e, 'esplosione');
      if (findKing(pos, e) < 0) return win(c, 'esplosione');
    }
    if (v === 'hidden') {
      if (findKing(pos, c) < 0) return win(e, 're catturato');
    }
    if (v === '3check') {
      if (pos.checks.w >= 3) return win('w', 'tre scacchi');
      if (pos.checks.b >= 3) return win('b', 'tre scacchi');
    }
    if (v === 'koth') {
      var hill = [27, 28, 35, 36];
      var ke = findKing(pos, e);
      if (hill.indexOf(ke) >= 0) return win(e, 're al centro');
    }
    if (v === 'racing') {
      var wk = findKing(pos, 'w'), bk = findKing(pos, 'b');
      var wGoal = rankOf(wk) === 7, bGoal = rankOf(bk) === 7;
      if (wGoal && bGoal) return draw('entrambi i re in fondo');
      if (bGoal) return win('b', 're in fondo');
      if (wGoal && c === 'b') {
        // il Nero ha un'ultima mossa per pareggiare
        var canTie = legalRaw(pos).some(function (m) { return pos.b[m.from].t === 'k' && rankOf(m.to) === 7; });
        if (!canTie) return win('w', 're in fondo');
      }
      if (wGoal && c === 'w') return win('w', 're in fondo');
    }
    if (v === 'antichess') {
      var has = false;
      for (var i = 0; i < 64; i++) if (pos.b[i] && pos.b[i].c === c) { has = true; break; }
      if (!has) return win(c, 'tutti i pezzi persi');
    }
    var moves = legalRaw(pos);
    if (!moves.length) {
      if (v === 'antichess') return win(c, 'senza mosse');
      if (inCheck(pos)) return win(e, 'scacco matto');
      return draw('stallo');
    }
    if (insufficient(pos)) return draw('materiale insufficiente');
    if (pos.half >= 100) return draw('regola delle 50 mosse');
    return null;
  }

  // mosse legali senza controllare prima la fine partita (evita ricorsione)
  function legalRaw(pos) {
    var list = [];
    var ps = pseudoMoves(pos);
    for (var i = 0; i < ps.length; i++) {
      var n = makeMove(pos, ps[i]);
      if (isLegalAfter(pos, ps[i], n)) list.push(ps[i]);
    }
    if (pos.variant === 'antichess') {
      var caps = list.filter(function (m) { return !!pos.b[m.to] || m.ep; });
      if (caps.length) list = caps;
    }
    return list;
  }

  // ---------- Notazione ----------
  function uci(m) { return sqName(m.from) + sqName(m.to) + (m.promo || ''); }

  // Trova la mossa legale corrispondente a una stringa UCI (accetta anche e1g1 per l'arrocco)
  function findMove(pos, u, moves) {
    moves = moves || legalRaw(pos);
    var from = parseSq(u.slice(0, 2)), to = parseSq(u.slice(2, 4)), promo = u[4] || undefined;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      if (m.from !== from) continue;
      if (m.to === to && (m.promo || undefined) === promo) return m;
      if (m.castle && !promo) {
        var kingSide = fileOf(m.to) > fileOf(m.from);
        if (to === sq(kingSide ? 6 : 2, rankOf(m.from)) && !pos.b[to]) return m;
        if (to === sq(kingSide ? 6 : 2, rankOf(m.from)) && to === m.to) return m;
      }
    }
    return null;
  }

  // Applica una mossa senza controllarne la legalità (vista parziale nella Regina nascosta)
  function applyUci(pos, u, reveal) {
    var from = parseSq(u.slice(0, 2)), to = parseSq(u.slice(2, 4)), promo = u[4];
    var p = pos.b[from];
    var m = { from: from, to: to };
    if (promo) m.promo = promo;
    var tgt = pos.b[to];
    if (p.t === 'k' && tgt && tgt.c === p.c && tgt.t === 'r') m.castle = true;
    else if (p.t === 'k' && Math.abs(fileOf(to) - fileOf(from)) === 2 && fileOf(from) === 4 && !tgt) {
      // arrocco in notazione classica
      var rookSq = sq(to > from ? 7 : 0, rankOf(from));
      m.to = rookSq; m.castle = true;
    }
    if ((p.t === 'p' || isDisguised(p)) && fileOf(from) !== fileOf(to) && !tgt && to === pos.ep) m.ep = true;
    if ((p.t === 'p' || isDisguised(p)) && Math.abs(to - from) === 16) m.dbl = true;
    if (isDisguised(p)) {
      var pl = pawnTargets(pos, from, p).some(function (t) { return t.to === to; });
      if (!pl) m.queenLike = true;
    }
    var n = makeMove(pos, m);
    (reveal || []).forEach(function (s) {
      if (typeof s === 'string') s = parseSq(s);
      var q = n.b[s];
      if (q && !(q.h && q.rv)) {
        n.b[s] = piece(q.c, 'q', { h: true, rv: true });
        if (n.revealed.indexOf(s) < 0) n.revealed.push(s);
      }
    });
    return { pos: n, move: m };
  }

  function san(pos, m) {
    var p = pos.b[m.from];
    var res;
    if (m.castle) res = fileOf(m.to) > fileOf(m.from) ? 'O-O' : 'O-O-O';
    else {
      var cap = !!pos.b[m.to] || m.ep;
      var t = isDisguised(p) && !m.queenLike ? 'p' : p.t;
      if (t === 'p') {
        res = (cap ? FILES[fileOf(m.from)] + 'x' : '') + sqName(m.to);
        if (m.promo) res += '=' + m.promo.toUpperCase();
      } else {
        var letter = t.toUpperCase();
        var amb = legalRaw(pos).filter(function (o) {
          return o !== m && o.to === m.to && o.from !== m.from && !o.castle && pos.b[o.from].t === p.t && !isDisguised(pos.b[o.from]);
        });
        var dis = '';
        if (amb.length) {
          var sameFile = amb.some(function (o) { return fileOf(o.from) === fileOf(m.from); });
          var sameRank = amb.some(function (o) { return rankOf(o.from) === rankOf(m.from); });
          if (!sameFile) dis = FILES[fileOf(m.from)];
          else if (!sameRank) dis = String(rankOf(m.from) + 1);
          else dis = sqName(m.from);
        }
        res = letter + dis + (cap ? 'x' : '') + sqName(m.to);
      }
    }
    var n = makeMove(pos, m);
    var o = outcome(n);
    if (o && o.reason === 'scacco matto') res += '#';
    else if (kingInCheck(n, n.turn, { hiddenAsPawn: pos.variant === 'hidden' })) res += '+';
    return res;
  }

  // ---------- Partita completa (con ripetizioni) ----------
  function posKey(pos) {
    var f = toFen(pos).split(' ').slice(0, 4).join(' ');
    return pos.variant === '3check' ? f + ' ' + pos.checks.w + pos.checks.b : f;
  }

  function Game(variant, startFen, hidden) {
    this.variant = variant;
    this.pos = fromFen(startFen, variant);
    if (hidden) Object.keys(hidden).forEach(function (c) { if (hidden[c] != null) setHidden(this.pos, hidden[c]); }, this);
    this.history = [];
    this.keys = [posKey(this.pos)];
  }
  Game.prototype.moves = function () { return this.status() ? [] : legalRaw(this.pos); };
  Game.prototype.play = function (u) {
    if (this.status()) return null;
    var m = findMove(this.pos, u);
    if (!m) return null;
    var s = san(this.pos, m);
    var n = makeMove(this.pos, m);
    var rec = { u: uci(m), san: s, rv: n.revealed.map(sqName) };
    this.pos = n;
    this.history.push(rec);
    this.keys.push(posKey(n));
    return rec;
  };
  Game.prototype.status = function () {
    var o = outcome(this.pos);
    if (o) return o;
    var k = this.keys[this.keys.length - 1], count = 0;
    for (var i = 0; i < this.keys.length; i++) if (this.keys[i] === k) count++;
    if (count >= 3) return { result: '1/2-1/2', winner: null, reason: 'triplice ripetizione' };
    return null;
  };

  // ---------- Posizioni iniziali ----------
  function random960(rand) {
    rand = rand || Math.random;
    var row = new Array(8).fill(null);
    var light = [1, 3, 5, 7], dark = [0, 2, 4, 6];
    row[light[Math.floor(rand() * 4)]] = 'b';
    row[dark[Math.floor(rand() * 4)]] = 'b';
    function free() { var f = []; row.forEach(function (x, i) { if (!x) f.push(i); }); return f; }
    var f1 = free(); row[f1[Math.floor(rand() * f1.length)]] = 'q';
    var f2 = free(); row[f2[Math.floor(rand() * f2.length)]] = 'n';
    var f3 = free(); row[f3[Math.floor(rand() * f3.length)]] = 'n';
    var f4 = free(); row[f4[0]] = 'r'; row[f4[1]] = 'k'; row[f4[2]] = 'r';
    var black = row.join('');
    var cr = FILES[f4[2]].toUpperCase() + FILES[f4[0]].toUpperCase() + FILES[f4[2]] + FILES[f4[0]];
    return black + '/pppppppp/8/8/8/8/PPPPPPPP/' + black.toUpperCase() + ' w ' + cr + ' - 0 1';
  }

  // Restituisce { fen, hidden: { w: casella, b: casella } | null }
  function startPosition(variant, rand) {
    rand = rand || Math.random;
    if (variant === 'chess960') return { fen: random960(rand), hidden: null };
    if (variant === 'hidden') {
      return { fen: START_FEN.hidden, hidden: { w: 8 + Math.floor(rand() * 8), b: 48 + Math.floor(rand() * 8) } };
    }
    return { fen: START_FEN[variant] || START, hidden: null };
  }

  function perft(pos, depth) {
    if (depth === 0) return 1;
    if (outcome(pos)) return 0;
    var ms = legalRaw(pos);
    if (depth === 1) return ms.length;
    var n = 0;
    for (var i = 0; i < ms.length; i++) n += perft(makeMove(pos, ms[i]), depth - 1);
    return n;
  }

  return {
    VARIANTS: VARIANTS, ORDER: ORDER,
    fromFen: fromFen, toFen: toFen, setHidden: setHidden,
    legalMoves: legalMoves, makeMove: makeMove, outcome: outcome, inCheck: inCheck,
    findMove: findMove, applyUci: applyUci, san: san, uci: uci,
    sqName: sqName, parseSq: parseSq, findKing: findKing, isDisguised: isDisguised,
    startPosition: startPosition, Game: Game, perft: perft, posKey: posKey
  };
});
