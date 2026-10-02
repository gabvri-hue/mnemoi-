(function () {
  'use strict';

  var A = window.MnemoiAccount, E = window.MnemoiEngine;
  var sb = A.sb;
  var esc = A.esc, toast = A.toast;
  function $(id) { return document.getElementById(id); }

  var GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  var TCS = ['1+0', '2+1', '3+0', '3+2', '5+0', '10+0', '15+10', '30+0'];
  var TC_KIND = { '1+0': 'Bullet', '2+1': 'Bullet', '3+0': 'Blitz', '3+2': 'Blitz', '5+0': 'Blitz', '10+0': 'Rapid', '15+10': 'Rapid', '30+0': 'Lenta' };
  var PREFS = 'mnemoi.online.v1';

  var prefs = { variant: 'standard', tc: '5+0' };
  try { var sp = JSON.parse(localStorage.getItem(PREFS) || 'null'); if (sp && E.VARIANTS[sp.variant] && TCS.indexOf(sp.tc) >= 0) prefs = sp; } catch (e) {}
  function savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (e) {} }

  function me() { var u = A.user(); return u ? u.id : null; }
  function tcLabel(tc) { return tc + ' · ' + TC_KIND[tc]; }
  function vname(v) { return E.VARIANTS[v] ? E.VARIANTS[v].name : v; }

  // ---------- Chiamate al server delle partite ----------
  var offset = 0; // differenza tra l'orologio del server e quello del dispositivo
  function api(action, params) {
    var body = Object.assign({ action: action }, params || {});
    return sb.functions.invoke('partite', { body: body }).then(function (r) {
      if (r.error) {
        var ctx = r.error.context;
        var p = ctx && typeof ctx.json === 'function' ? ctx.json().catch(function () { return null; }) : Promise.resolve(null);
        return p.then(function (j) {
          var err = new Error((j && j.error) || 'Il server delle partite non risponde. Riprova tra poco.');
          err.status = ctx && ctx.status;
          throw err;
        });
      }
      if (r.data && r.data.now) offset = r.data.now - Date.now();
      return r.data;
    });
  }

  // ---------- Profili (con cache) ----------
  var people = {};
  function loadPeople(ids) {
    var miss = ids.filter(function (id) { return id && !people[id]; });
    if (!miss.length) return Promise.resolve(people);
    return sb.from('profiles').select('id, username, avatar_url, xp, ratings').in('id', miss).then(function (r) {
      (r.data || []).forEach(function (p) { people[p.id] = p; });
      return people;
    });
  }
  function personHtml(p, extra) {
    p = p || { username: 'Giocatore eliminato' };
    return '<span class="who"><span class="avatar sm">' + A.avatarHtml(p) + '</span><span><b>' + esc(p.username) + '</b>' +
      (extra ? '<br><span class="muted small">' + extra + '</span>' : '') + '</span></span>';
  }

  // ================= Lobby =================
  function renderLobby() {
    $('variantPick').innerHTML = E.ORDER.map(function (v) {
      return '<button type="button" class="vcard' + (prefs.variant === v ? ' on' : '') + '" data-variant="' + v + '"><b>' +
        esc(E.VARIANTS[v].name) + '</b><span>' + esc(E.VARIANTS[v].short) + '</span></button>';
    }).join('');
    $('tcPick').innerHTML = TCS.map(function (tc) {
      return '<button type="button" class="chip' + (prefs.tc === tc ? ' on' : '') + '" data-tc="' + tc + '"><b>' + tc + '</b><span>' + TC_KIND[tc] + '</span></button>';
    }).join('');
    $('rulesList').innerHTML = '<dl>' + E.ORDER.map(function (v) {
      return '<dt>' + esc(E.VARIANTS[v].name) + '</dt><dd>' + esc(E.VARIANTS[v].short) + '</dd>';
    }).join('') + '</dl><p class="muted">Nel tempo, "3+2" significa 3 minuti a testa più 2 secondi aggiunti a ogni mossa. Il tuo orologio parte dopo la tua prima mossa; se non muovi entro 30 secondi la partita viene annullata.</p>';
  }
  document.addEventListener('click', function (e) {
    var v = e.target.closest('[data-variant]');
    if (v) { prefs.variant = v.getAttribute('data-variant'); savePrefs(); renderLobby(); return; }
    var t = e.target.closest('[data-tc]');
    if (t) { prefs.tc = t.getAttribute('data-tc'); savePrefs(); renderLobby(); return; }
    var play = e.target.closest('[data-play]');
    if (play) {
      var mode = $('mode');
      if (mode && mode.value !== play.getAttribute('data-play')) {
        mode.value = play.getAttribute('data-play');
        mode.dispatchEvent(new Event('change'));
      }
    }
  });

  // ---------- Ricerca avversario ----------
  var seek = null; // { t0, timer, busy }
  function startSeek() {
    if (!A.enabled) { toast('Il gioco online sarà disponibile a breve.'); return; }
    if (!me()) { A.openAuth('signup'); return; }
    if (seek) return;
    seek = { t0: Date.now(), busy: false };
    $('seekBtn').hidden = true;
    $('seekBox').hidden = false;
    tickSeek();
    seek.timer = setInterval(tickSeek, 1000);
  }
  function tickSeek() {
    if (!seek) return;
    var s = Math.floor((Date.now() - seek.t0) / 1000);
    $('seekText').textContent = 'Cerco un avversario per ' + vname(prefs.variant) + ' ' + prefs.tc + '… ' +
      Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    if (seek.busy || (s % 3 !== 0 && s > 0)) return;
    seek.busy = true;
    var mine = seek;
    api('queue', { variant: prefs.variant, tc: prefs.tc }).then(function (r) {
      if (seek !== mine) return;
      seek.busy = false;
      if (r.match) { stopSeek(false); location.hash = '#partita/' + r.match; }
    }).catch(function (err) {
      if (seek !== mine) return;
      stopSeek(false);
      toast(err.message);
    });
  }
  function stopSeek(leave) {
    if (!seek) return;
    clearInterval(seek.timer);
    seek = null;
    $('seekBtn').hidden = false;
    $('seekBox').hidden = true;
    if (leave) api('leave').catch(function () {});
  }
  $('seekBtn').onclick = startSeek;
  $('seekCancel').onclick = function () { stopSeek(true); };

  // Partita in corso: banner nella lobby
  function checkActive() {
    if (!me()) { $('activeBanner').hidden = true; return; }
    var uid = me();
    sb.from('matches').select('id').eq('status', 'active').or('white.eq.' + uid + ',black.eq.' + uid)
      .order('created_at', { ascending: false }).limit(1).then(function (r) {
        var m = r.data && r.data[0];
        $('activeBanner').hidden = !m;
        if (m) $('activeLink').href = '#partita/' + m.id;
      });
  }

  // ================= Partita online =================
  var G = null;

  function closeMatch() {
    if (!G) return;
    if (G.channel) sb.removeChannel(G.channel);
    clearInterval(G.clock);
    clearInterval(G.poll);
    G = null;
  }

  function openMatch(id) {
    if (G && G.id === id) { refresh(); return; }
    closeMatch();
    G = { id: id, m: null, pos: null, legal: [], sel: null, flipped: false, secret: null, flagAt: 0, before: null, ended: false, rematchSent: false };
    $('oBoard').innerHTML = '';
    $('oStatus').textContent = 'Caricamento della partita…';
    $('oEnd').hidden = true;
    $('oOffer').hidden = true;
    $('oMoves').innerHTML = '';
    $('oSecret').hidden = true;
    var g = G;
    sb.from('matches').select('*').eq('id', id).maybeSingle().then(function (r) {
      if (G !== g) return;
      if (!r.data) { $('oStatus').textContent = 'Partita non trovata.'; return; }
      var m = r.data;
      var uid = me();
      g.color = m.white === uid ? 'w' : m.black === uid ? 'b' : null;
      g.flipped = g.color === 'b';
      var p = p0(m, uid);
      if (g.color && m.status === 'active') {
        var pr = A.profile();
        if (pr) g.before = { xp: pr.xp || 0, coins: pr.coins };
      }
      return p.then(function () {
        if (G !== g) return;
        applyRow(m);
        subscribe(g);
        if (m.status === 'active') api('sync', { id: id }).then(function () { if (G === g) refresh(); }).catch(function () {});
      });
    });
  }
  function p0(m, uid) {
    var jobs = [loadPeople([m.white, m.black])];
    if (m.variant === 'hidden' && (m.white === uid || m.black === uid)) {
      jobs.push(sb.from('match_secrets').select('color, square').eq('match_id', m.id).then(function (r) {
        var s = (r.data || [])[0];
        if (s && G) G.secret = s.square;
      }));
    }
    return Promise.all(jobs);
  }

  function subscribe(g) {
    g.channel = sb.channel('match-' + g.id)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'matches', filter: 'id=eq.' + g.id }, function (payload) {
        if (G === g && payload.new) applyRow(payload.new);
      })
      .subscribe(function (status) { g.live = status === 'SUBSCRIBED'; });
    g.clock = setInterval(tickClock, 200);
    // controllo di sicurezza se il tempo reale si interrompe
    g.poll = setInterval(function () { if (G === g && g.m && g.m.status === 'active' && (!g.live || Date.now() % 15000 < 3000)) refresh(); }, 3000);
  }

  function refresh() {
    var g = G;
    if (!g) return;
    sb.from('matches').select('*').eq('id', g.id).maybeSingle().then(function (r) {
      if (G === g && r.data) applyRow(r.data);
    });
  }

  function applyRow(m) {
    var g = G;
    if (g.m && m.ply < g.m.ply) return;
    if (g.pending && m.ply <= g.pendingPly && m.status === 'active') return;
    var wasActive = g.m && g.m.status === 'active';
    g.m = m;
    var pos = E.fromFen(m.start_fen, m.variant);
    if (g.secret != null) { try { E.setHidden(pos, g.secret); } catch (e) {} }
    for (var i = 0; i < m.moves.length; i++) pos = E.applyUci(pos, m.moves[i].u, m.moves[i].rv).pos;
    g.pos = pos;
    g.pending = false;
    var myTurn = m.status === 'active' && g.color && pos.turn === g.color;
    g.legal = myTurn ? E.legalMoves(pos) : [];
    if (!myTurn) g.sel = null;
    renderMatch();
    if (m.status !== 'active' && !g.ended) {
      g.ended = true;
      onEnd(wasActive);
    }
  }

  function lastSquares(m) {
    if (!m.moves.length) return [];
    var u = m.moves[m.moves.length - 1].u;
    return [E.parseSq(u.slice(0, 2)), E.parseSq(u.slice(2, 4))];
  }

  function targetsFrom(s) {
    var t = {};
    G.legal.forEach(function (mv) {
      if (mv.from !== s) return;
      t[mv.to] = mv;
      if (mv.castle) {
        var kingSide = (mv.to & 7) > (mv.from & 7);
        t[(mv.from & ~7) + (kingSide ? 6 : 2)] = mv;
      }
    });
    return t;
  }

  function renderBoard() {
    var g = G, pos = g.pos, m = g.m;
    var last = lastSquares(m);
    var targets = g.sel != null ? targetsFrom(g.sel) : {};
    var checkSq = -1;
    if (m.status === 'active' && E.inCheck(pos)) checkSq = E.findKing(pos, pos.turn);
    var html = '';
    for (var i = 0; i < 8; i++) {
      for (var j = 0; j < 8; j++) {
        var r = g.flipped ? i : 7 - i, f = g.flipped ? 7 - j : j;
        var s = r * 8 + f;
        var cls = 'sq ' + ((r + f) % 2 === 1 ? 'l' : 'd');
        if (last.indexOf(s) >= 0) cls += ' last';
        if (g.sel === s) cls += ' sel';
        if (checkSq === s) cls += ' check';
        if (s in targets) cls += ' hint' + (pos.b[s] && pos.b[s].c !== pos.turn ? ' cap' : '');
        var p = pos.b[s];
        html += '<div class="' + cls + '" data-s="' + s + '">';
        if (j === 7) html += '<span class="coord r">' + (r + 1) + '</span>';
        if (i === 7) html += '<span class="coord f">' + 'abcdefgh'[f] + '</span>';
        if (p) {
          var disguised = E.isDisguised(p);
          html += '<span class="pc ' + p.c + (disguised ? ' hq' : '') + '"' + (disguised ? ' title="La tua regina nascosta"' : '') + '>' +
            GLYPH[disguised ? 'p' : p.t] + '</span>';
        }
        html += '</div>';
      }
    }
    $('oBoard').innerHTML = html;
  }

  function clockMs(color) {
    var m = G.m;
    var base = color === 'w' ? m.white_ms : m.black_ms;
    if (m.status !== 'active' || m.ply < 2 || G.pos.turn !== color) return base;
    return base - (Date.now() + offset - new Date(m.last_move_at).getTime());
  }
  function fmtClock(ms) {
    ms = Math.max(0, ms);
    var s = Math.ceil(ms / 1000);
    if (ms < 10000) return (ms / 1000).toFixed(1);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  function barHtml(color) {
    var m = G.m, id = color === 'w' ? m.white : m.black;
    var p = people[id];
    var rating = color === 'w' ? m.white_rating : m.black_rating;
    if (rating == null) rating = (p && p.ratings && p.ratings[m.variant]) || 1200;
    var change = color === 'w' ? m.white_change : m.black_change;
    var extra = 'Liv. ' + A.levelOf(p ? p.xp : 0).level + ' · ' + rating +
      (change != null && m.status === 'finished' ? ' <span class="' + (change >= 0 ? 'up' : 'down') + '">' + (change >= 0 ? '+' : '') + change + '</span>' : '');
    var running = m.status === 'active' && m.ply >= 2 && G.pos.turn === color;
    return personHtml(p, extra) + '<span class="clock' + (running ? ' run' : '') + '" data-clock="' + color + '">' + fmtClock(clockMs(color)) + '</span>';
  }

  function resultText(m) {
    if (m.status === 'aborted') return 'Partita annullata' + (m.reason && m.reason !== 'annullata' ? ' (' + esc(m.reason) + ')' : '') + '.';
    var who = m.result === '1-0' ? 'w' : m.result === '0-1' ? 'b' : null;
    var reason = m.reason ? ' (' + esc(m.reason) + ')' : '';
    if (!who) return 'Patta' + reason + '.';
    if (G.color) return (who === G.color ? 'Hai vinto' : 'Hai perso') + reason + '.';
    return 'Vince il ' + (who === 'w' ? 'Bianco' : 'Nero') + reason + '.';
  }

  function statusText() {
    var m = G.m, pos = G.pos;
    if (m.status !== 'active') return resultText(m);
    var side = pos.turn === 'w' ? 'Bianco' : 'Nero';
    var mine = G.color && pos.turn === G.color;
    if (m.ply < 2) {
      var left = Math.max(0, Math.ceil((30000 - (Date.now() + offset - new Date(m.last_move_at).getTime())) / 1000));
      return (mine ? 'Tocca a te: fai la prima mossa' : 'In attesa della prima mossa del ' + side) + ' (' + left + ' s).';
    }
    var chk = E.inCheck(pos) ? ' Scacco!' : '';
    if (m.variant === '3check') chk += ' Scacchi dati: Bianco ' + pos.checks.w + ', Nero ' + pos.checks.b + '.';
    return (mine ? 'Tocca a te.' : G.color ? 'Tocca all\'avversario.' : 'Tocca al ' + side + '.') + chk;
  }

  function renderMatch() {
    var g = G, m = g.m;
    var top = g.flipped ? 'w' : 'b', bottom = g.flipped ? 'b' : 'w';
    $('oppBar').innerHTML = barHtml(top);
    $('myBar').innerHTML = barHtml(bottom);
    $('oTitle').textContent = vname(m.variant) + ' · ' + tcLabel(m.tc);
    $('oRules').textContent = m.variant === 'standard' ? '' : E.VARIANTS[m.variant].short;
    if (g.secret != null && m.status === 'active') {
      var still = false;
      for (var s = 0; s < 64; s++) if (E.isDisguised(g.pos.b[s]) && g.pos.b[s].c === g.color) { still = E.sqName(s); break; }
      $('oSecret').hidden = !still;
      if (still) $('oSecret').innerHTML = 'La tua regina nascosta è il pedone in <b>' + still + '</b> (segnato sulla scacchiera). L\'avversario non lo sa.';
    } else $('oSecret').hidden = true;
    $('oStatus').textContent = m.status === 'active' ? statusText() : '';
    var active = m.status === 'active' && !!g.color;
    $('oActions').hidden = !active;
    $('oResign').textContent = m.ply < 2 ? 'Annulla partita' : 'Abbandona';
    $('oDrawBtn').disabled = m.ply < 2 || m.draw_offer === g.color;
    $('oDrawBtn').textContent = m.draw_offer === g.color ? 'Patta proposta' : 'Proponi patta';
    $('oOffer').hidden = !(active && m.draw_offer && m.draw_offer !== g.color);
    var h = '';
    for (var i = 0; i < m.moves.length; i += 2) {
      h += '<li>' + esc(m.moves[i].s) + (m.moves[i + 1] ? '&nbsp;&nbsp;' + esc(m.moves[i + 1].s) : '') + '</li>';
    }
    $('oMoves').innerHTML = h;
    var box = $('oMoves').parentNode;
    box.scrollTop = box.scrollHeight;
    renderBoard();
  }

  function tickClock() {
    var g = G;
    if (!g || !g.m) return;
    var els = document.querySelectorAll('[data-clock]');
    for (var i = 0; i < els.length; i++) {
      var c = els[i].getAttribute('data-clock');
      var ms = clockMs(c);
      els[i].textContent = fmtClock(ms);
      els[i].classList.toggle('low', ms < 20000 && g.m.status === 'active');
    }
    if (g.m.status !== 'active') return;
    if (g.m.ply < 2) $('oStatus').textContent = statusText();
    var elapsed = Date.now() + offset - new Date(g.m.last_move_at).getTime();
    var over = g.m.ply < 2 ? elapsed > 30500 : clockMs(g.pos.turn) <= 0;
    if (over && g.color && Date.now() - g.flagAt > 3000) {
      g.flagAt = Date.now();
      api('flag', { id: g.id }).then(function () { if (G === g) refresh(); }).catch(function () {});
    }
  }

  // ---------- Mosse ----------
  $('oBoard').addEventListener('click', function (e) {
    var g = G;
    var el = e.target.closest('.sq');
    if (!g || !el || !g.legal.length || g.pending) return;
    var s = parseInt(el.getAttribute('data-s'), 10);
    if (g.sel != null) {
      var t = targetsFrom(g.sel);
      if (s in t) {
        var from = g.sel;
        var options = g.legal.filter(function (mv) { return mv.from === from && mv.to === t[s].to && !!mv.castle === !!t[s].castle; });
        g.sel = null;
        if (options.length > 1 && options[0].promo) {
          askPromo(g.color, options.map(function (o) { return o.promo; }), function (pr) {
            send(options.filter(function (o) { return o.promo === pr; })[0]);
          });
        } else send(t[s]);
        return;
      }
    }
    var p = g.pos.b[s];
    g.sel = (p && p.c === g.color && g.sel !== s) ? s : null;
    renderBoard();
  });

  function askPromo(color, list, cb) {
    var dlg = $('promoDlg'), box = $('promoBtns');
    box.innerHTML = '';
    list.forEach(function (t) {
      var btn = document.createElement('button');
      btn.innerHTML = '<span class="pc ' + color + '">' + GLYPH[t] + '</span>';
      btn.onclick = function () { dlg.close(); cb(t); };
      box.appendChild(btn);
    });
    dlg.showModal();
  }

  function send(mv) {
    var g = G, m = g.m;
    var u = E.uci(mv);
    g.pending = true;
    g.pendingPly = m.ply;
    // mostra subito la mossa, poi conferma dal server
    var san = E.san(g.pos, mv);
    g.pos = E.applyUci(g.pos, u, []).pos;
    g.legal = [];
    g.m = Object.assign({}, m, { moves: m.moves.concat([{ u: u, s: san }]) });
    renderBoard();
    $('oStatus').textContent = 'Invio della mossa…';
    api('move', { id: g.id, ply: m.ply, uci: u }).then(function () {
      if (G === g) refresh();
    }).catch(function (err) {
      if (G !== g) return;
      toast(err.message);
      g.m = m;
      g.pending = false;
      refresh();
    });
  }

  $('oFlip').onclick = function () { if (G) { G.flipped = !G.flipped; renderMatch(); } };
  $('oResign').onclick = function () {
    if (!G || !G.m) return;
    var abort = G.m.ply < 2;
    if (!confirm(abort ? 'Annullare la partita? Non conta per il punteggio.' : 'Vuoi davvero abbandonare? La partita sarà persa.')) return;
    api('resign', { id: G.id }).then(refresh).catch(function (err) { toast(err.message); });
  };
  $('oDrawBtn').onclick = function () {
    if (!G) return;
    api('draw', { id: G.id }).then(function (r) { if (r.offered) toast('Hai proposto patta.'); refresh(); }).catch(function (err) { toast(err.message); });
  };
  $('oAcceptDraw').onclick = function () { api('draw', { id: G.id }).then(refresh).catch(function (err) { toast(err.message); }); };
  $('oDeclineDraw').onclick = function () { api('draw', { id: G.id, decline: true }).then(refresh).catch(function (err) { toast(err.message); }); };

  // ---------- Fine partita ----------
  function onEnd(justNow) {
    var g = G, m = g.m;
    var box = $('oEnd');
    var html = '<div class="end-title">' + resultText(m) + '</div><div class="end-gain" id="oGain"></div><div class="row">';
    if (g.color && m.status === 'finished') {
      var opp = g.color === 'w' ? m.black : m.white;
      if (opp) html += '<button class="primary" id="oRematch">Rivincita</button>';
    }
    html += '<button id="oAgain"' + (g.color && m.status !== 'finished' ? ' class="primary"' : '') + '>Nuova partita</button><a class="btn" href="#gioca">Torna alla lobby</a></div>';
    box.innerHTML = html;
    box.hidden = false;
    var again = $('oAgain');
    again.onclick = function () {
      prefs.variant = m.variant; prefs.tc = m.tc; savePrefs(); renderLobby();
      location.hash = '#gioca';
      setTimeout(startSeek, 50);
    };
    var rm = $('oRematch');
    if (rm) rm.onclick = function () {
      rm.disabled = true;
      api('challenge', { to: g.color === 'w' ? m.black : m.white, variant: m.variant, tc: m.tc, rematch_of: m.id }).then(function (r) {
        if (r.match) location.hash = '#partita/' + r.match;
        else { rm.textContent = 'Rivincita proposta…'; g.rematchSent = true; }
      }).catch(function (err) { rm.disabled = false; toast(err.message); });
    };
    if (g.color && justNow && g.before) {
      var before = g.before;
      A.reloadProfile().then(function () {
        var p = A.profile();
        if (!p || G !== g) return;
        var dx = (p.xp || 0) - before.xp, dc = p.coins - before.coins;
        var parts = [];
        if (dx > 0) parts.push('+' + dx + ' exp');
        if (dc > 0) parts.push('+' + dc + ' monete');
        var el = $('oGain');
        if (el) el.textContent = parts.length ? parts.join(' · ') : (m.status === 'finished' ? 'Partita troppo corta: niente esperienza né monete.' : '');
        if (A.levelOf(p.xp).level > A.levelOf(before.xp).level) toast('Sei salito al livello ' + A.levelOf(p.xp).level + '!');
      });
    }
    checkActive();
  }

  // ================= Amici =================
  var friends = { rows: [], online: {} };

  function loadFriends() {
    var uid = me();
    if (!uid) return Promise.resolve();
    return sb.from('friendships').select('*').or('from_user.eq.' + uid + ',to_user.eq.' + uid).then(function (r) {
      friends.rows = r.data || [];
      var ids = friends.rows.map(function (f) { return f.from_user === uid ? f.to_user : f.from_user; });
      // aggiorna i profili degli amici (livello e foto possono cambiare)
      ids.forEach(function (id) { delete people[id]; });
      return loadPeople(ids);
    }).then(renderFriends);
  }

  function renderFriends() {
    var uid = me();
    if (!uid) return;
    var reqs = '', sent = '', list = [];
    friends.rows.forEach(function (f) {
      var other = f.from_user === uid ? f.to_user : f.from_user;
      var p = people[other];
      var lv = 'Liv. ' + A.levelOf(p ? p.xp : 0).level;
      if (f.status === 'pending' && f.to_user === uid) {
        reqs += '<div class="prow">' + personHtml(p, lv) + '<span class="acts"><button class="primary" data-fr-accept="' + other + '">Accetta</button><button data-fr-decline="' + other + '">Rifiuta</button></span></div>';
      } else if (f.status === 'pending') {
        sent += '<div class="prow">' + personHtml(p, lv + ' · in attesa') + '<span class="acts"><button data-fr-remove="' + other + '">Annulla</button></span></div>';
      } else list.push({ id: other, p: p, lv: lv });
    });
    list.sort(function (a, b) {
      var oa = friends.online[a.id] ? 0 : 1, ob = friends.online[b.id] ? 0 : 1;
      return oa - ob || ((a.p && a.p.username) || '').localeCompare((b.p && b.p.username) || '');
    });
    $('friendReqs').innerHTML = reqs;
    $('friendReqsBox').hidden = !reqs;
    $('friendSent').innerHTML = sent;
    $('friendSentBox').hidden = !sent;
    $('friendList').innerHTML = list.length ? list.map(function (x) {
      var on = !!friends.online[x.id];
      return '<div class="prow"><span class="presence' + (on ? ' on' : '') + '" title="' + (on ? 'Online' : 'Offline') + '"></span>' +
        personHtml(x.p, x.lv + ' · ' + (on ? 'online' : 'offline')) +
        '<span class="acts"><button class="primary" data-fr-challenge="' + x.id + '">Sfida</button><button class="icon" title="Rimuovi amico" data-fr-remove="' + x.id + '" data-confirm="1">✕</button></span></div>';
    }).join('') : '<p class="muted">Non hai ancora amici. Cerca il loro nome in gioco qui accanto.</p>';
    var pending = friends.rows.filter(function (f) { return f.status === 'pending' && f.to_user === uid; }).length;
    $('friendBadge').hidden = !pending;
    $('friendBadge').textContent = pending || '';
  }

  $('addFriend').onsubmit = function (e) {
    e.preventDefault();
    var name = $('friendName').value.trim();
    var msg = $('friendMsg');
    msg.textContent = 'Invio…';
    sb.rpc('friend_request', { p_username: name }).then(function (r) {
      if (r.error) throw r.error;
      msg.textContent = r.data && r.data.status === 'accepted' ? 'Ora siete amici!' : 'Richiesta inviata a ' + name + '.';
      $('friendName').value = '';
      loadFriends();
    }).catch(function (err) { msg.textContent = A.errText(err); });
  };

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-fr-accept],[data-fr-decline],[data-fr-remove],[data-fr-challenge]');
    if (!b) return;
    var id;
    if ((id = b.getAttribute('data-fr-accept')) || (id = b.getAttribute('data-fr-decline'))) {
      var accept = b.hasAttribute('data-fr-accept');
      sb.rpc('friend_respond', { p_from: id, p_accept: accept }).then(function (r) {
        if (r.error) throw r.error;
        if (accept) toast('Ora siete amici!');
        loadFriends();
      }).catch(function (err) { toast(A.errText(err)); });
    } else if ((id = b.getAttribute('data-fr-remove'))) {
      if (b.getAttribute('data-confirm') && !confirm('Rimuovere ' + ((people[id] && people[id].username) || 'questo amico') + ' dagli amici?')) return;
      sb.rpc('friend_remove', { p_other: id }).then(function (r) { if (r.error) throw r.error; loadFriends(); })
        .catch(function (err) { toast(A.errText(err)); });
    } else if ((id = b.getAttribute('data-fr-challenge'))) {
      openChallenge(id);
    }
  });

  // ---------- Sfide ----------
  var chTarget = null;
  function openChallenge(id) {
    chTarget = id;
    $('chName').textContent = (people[id] && people[id].username) || '';
    $('chVariant').innerHTML = E.ORDER.map(function (v) { return '<option value="' + v + '"' + (v === prefs.variant ? ' selected' : '') + '>' + esc(E.VARIANTS[v].name) + '</option>'; }).join('');
    $('chTc').innerHTML = TCS.map(function (tc) { return '<option value="' + tc + '"' + (tc === prefs.tc ? ' selected' : '') + '>' + tcLabel(tc) + '</option>'; }).join('');
    $('chMsg').textContent = '';
    $('chDlg').showModal();
  }
  $('chClose').onclick = function () { $('chDlg').close(); };
  $('chForm').onsubmit = function (e) {
    e.preventDefault();
    var v = $('chVariant').value, tc = $('chTc').value;
    $('chMsg').textContent = 'Invio…';
    api('challenge', { to: chTarget, variant: v, tc: tc }).then(function (r) {
      if (r.match) { $('chDlg').close(); location.hash = '#partita/' + r.match; return; }
      $('chDlg').close();
      toast('Sfida inviata! Ti portiamo alla partita quando accetta.');
    }).catch(function (err) { $('chMsg').textContent = err.message; });
  };

  var invites = {};
  function showInvite(c) {
    if (invites[c.id] || c.status !== 'pending') return;
    if (Date.now() - new Date(c.created_at).getTime() > 10 * 60000) return;
    invites[c.id] = c;
    loadPeople([c.from_user]).then(function () {
      if (!invites[c.id]) return;
      var p = people[c.from_user];
      var el = document.createElement('div');
      el.className = 'invite';
      el.id = 'inv-' + c.id;
      el.innerHTML = personHtml(p, (c.rematch_of ? 'vuole la rivincita: ' : 'ti sfida: ') + esc(vname(c.variant)) + ' · ' + esc(c.tc)) +
        '<span class="acts"><button class="primary">Accetta</button><button>Rifiuta</button></span>';
      var btns = el.querySelectorAll('button');
      btns[0].onclick = function () {
        btns[0].disabled = true;
        api('accept', { id: c.id }).then(function (r) { dropInvite(c.id); location.hash = '#partita/' + r.match; })
          .catch(function (err) { dropInvite(c.id); toast(err.message); });
      };
      btns[1].onclick = function () { dropInvite(c.id); api('decline', { id: c.id }).catch(function () {}); };
      $('invites').appendChild(el);
      setTimeout(function () { dropInvite(c.id); }, 10 * 60000 - (Date.now() - new Date(c.created_at).getTime()));
    });
  }
  function dropInvite(id) {
    delete invites[id];
    var el = $('inv-' + id);
    if (el) el.remove();
  }

  // ---------- Tempo reale: sfide, amici, presenza ----------
  var live = null;
  function startLive() {
    stopLive();
    var uid = me();
    if (!uid) return;
    live = {};
    live.ch = sb.channel('me-' + uid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'challenges', filter: 'to_user=eq.' + uid }, function (pl) { showInvite(pl.new); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'challenges', filter: 'to_user=eq.' + uid }, function (pl) {
        if (pl.new.status !== 'pending') dropInvite(pl.new.id);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'challenges', filter: 'from_user=eq.' + uid }, function (pl) {
        var c = pl.new;
        if (c.status === 'accepted' && c.match_id) location.hash = '#partita/' + c.match_id;
        else if (c.status === 'declined') {
          loadPeople([c.to_user]).then(function () { toast(((people[c.to_user] || {}).username || 'L\'avversario') + ' ha rifiutato la sfida.'); });
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: 'to_user=eq.' + uid }, function (pl) {
        if (pl.eventType === 'INSERT') loadPeople([pl.new.from_user]).then(function () { toast(((people[pl.new.from_user] || {}).username || 'Qualcuno') + ' ti ha inviato una richiesta di amicizia.'); });
        loadFriends();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships', filter: 'from_user=eq.' + uid }, function () { loadFriends(); })
      .subscribe();
    live.presence = sb.channel('online', { config: { presence: { key: uid } } });
    live.presence.on('presence', { event: 'sync' }, function () {
      var st = live && live.presence ? live.presence.presenceState() : {};
      friends.online = {};
      Object.keys(st).forEach(function (k) { friends.online[k] = true; });
      renderFriends();
    }).subscribe(function (status) {
      if (status === 'SUBSCRIBED' && live) live.presence.track({ at: Date.now() });
    });
    // sfide arrivate mentre non eri sul sito
    sb.from('challenges').select('*').eq('to_user', uid).eq('status', 'pending')
      .gte('created_at', new Date(Date.now() - 10 * 60000).toISOString()).then(function (r) {
        (r.data || []).forEach(showInvite);
      });
    loadFriends();
    checkActive();
  }
  function stopLive() {
    if (!live) return;
    if (live.ch) sb.removeChannel(live.ch);
    if (live.presence) sb.removeChannel(live.presence);
    live = null;
    Object.keys(invites).forEach(dropInvite);
    friends = { rows: [], online: {} };
  }

  // ---------- Ultime partite nel profilo ----------
  function loadHistory() {
    var uid = me();
    if (!uid) return;
    sb.from('matches').select('id, variant, tc, white, black, status, result, reason, white_change, black_change, finished_at')
      .or('white.eq.' + uid + ',black.eq.' + uid).neq('status', 'aborted')
      .order('created_at', { ascending: false }).limit(10).then(function (r) {
        var rows = r.data || [];
        if (!rows.length) { $('pfGames').innerHTML = '<p class="muted">Nessuna partita online ancora.</p>'; return; }
        loadPeople(rows.map(function (m) { return m.white === uid ? m.black : m.white; })).then(function () {
          $('pfGames').innerHTML = rows.map(function (m) {
            var col = m.white === uid ? 'w' : 'b';
            var opp = people[col === 'w' ? m.black : m.white];
            var res = m.status === 'active' ? 'in corso' : !m.result ? '' : m.result === '1/2-1/2' ? 'patta' :
              ((m.result === '1-0') === (col === 'w') ? 'vinta' : 'persa');
            var ch = col === 'w' ? m.white_change : m.black_change;
            var cls = res === 'vinta' ? 'up' : res === 'persa' ? 'down' : '';
            return '<a class="prow link-row" href="#partita/' + m.id + '">' + personHtml(opp, esc(vname(m.variant)) + ' · ' + esc(m.tc)) +
              '<span class="acts"><span class="' + cls + '">' + res + (ch != null && m.status === 'finished' ? ' (' + (ch >= 0 ? '+' : '') + ch + ')' : '') + '</span></span></a>';
          }).join('');
        });
      });
  }

  // ---------- Navigazione ----------
  document.addEventListener('mnemoi:route', function (e) {
    var d = e.detail;
    if (d.view !== 'gioca' && seek) stopSeek(true);
    if (d.view === 'partita') {
      if (!A.enabled) { $('oStatus').textContent = 'Il gioco online sarà disponibile a breve.'; return; }
      openMatch(d.arg);
    } else closeMatch();
    if (d.view === 'gioca') checkActive();
    if (d.view === 'amici') { $('friendsBox').hidden = !me(); loadFriends(); }
    if (d.view === 'profilo') loadHistory();
  });
  document.addEventListener('mnemoi:user', function () {
    if (me()) startLive(); else stopLive();
    $('friendsBox').hidden = !me();
    stopSeek(false);
    var cur = (location.hash || '').slice(1).split('/');
    if (cur[0] === 'partita' && cur[1]) { closeMatch(); openMatch(cur[1]); }
    if (cur[0] === 'profilo') loadHistory();
  });
  window.addEventListener('beforeunload', function () { if (seek) api('leave').catch(function () {}); });

  renderLobby();
})();
