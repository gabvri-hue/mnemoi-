(function () {
  'use strict';

  // Spicchi della ruota: stesso ordine dei premi in spin_wheel() (supabase/schema.sql)
  var WHEEL = [10, 50, 20, 100, 10, 30, 20, 500];
  var WHEEL_COLORS = ['#7a4b2a', '#c9a227', '#5b7c4f', '#2f5d8a', '#7a4b2a', '#8a4f7d', '#5b7c4f', '#b23a3a'];
  var GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };

  var cfg = window.MNEMOI_CONFIG || {};
  var enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  var sb = enabled ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

  var user = null;       // utente di Supabase Auth
  var profile = null;    // riga di public.profiles
  var items = [];        // catalogo
  var owned = {};        // id oggetto -> true
  var wheelRot = 0;
  var spinning = false;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function errText(e) {
    var m = (e && (e.message || e.error_description)) || 'Qualcosa è andato storto, riprova.';
    if (/Invalid login credentials/i.test(m)) return 'Email o password non corretti.';
    if (/Email not confirmed/i.test(m)) return 'Conferma prima l\'indirizzo email: ti abbiamo mandato un link.';
    if (/User already registered/i.test(m)) return 'Esiste già un account con questa email.';
    if (/Password should be at least/i.test(m)) return 'La password deve avere almeno 8 caratteri.';
    if (/rate limit/i.test(m)) return 'Troppi tentativi, riprova tra qualche minuto.';
    return m;
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }
  function romeDay() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  }
  function avatarHtml(p) {
    if (p && p.avatar_url) return '<img src="' + esc(p.avatar_url) + '" alt="">';
    return esc(((p && p.username) || '?').charAt(0).toUpperCase());
  }

  // ---------- Cosmetiche ----------
  function applyCosmetics() {
    var root = document.documentElement.style;
    var board = itemById(profile ? profile.board_theme : 'board_classico');
    var pieces = itemById(profile ? profile.piece_style : 'pieces_classico');
    ['--light', '--dark', '--pw', '--pws', '--pb', '--pbs'].forEach(function (v) { root.removeProperty(v); });
    if (board && board.data) { root.setProperty('--light', board.data.light); root.setProperty('--dark', board.data.dark); }
    if (pieces && pieces.data) {
      root.setProperty('--pw', pieces.data.w); root.setProperty('--pws', pieces.data.ws);
      root.setProperty('--pb', pieces.data.b); root.setProperty('--pbs', pieces.data.bs);
    }
  }
  function itemById(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  // ---------- Stato account ----------
  function setProfile(p) {
    profile = p;
    renderHeader();
    renderProfile();
    renderShop();
    renderWheelState();
    applyCosmetics();
  }

  function loadProfile() {
    if (!user) { owned = {}; setProfile(null); return Promise.resolve(); }
    return Promise.all([
      sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
      sb.from('inventory').select('item_id').eq('user_id', user.id)
    ]).then(function (res) {
      owned = {};
      (res[1].data || []).forEach(function (r) { owned[r.item_id] = true; });
      setProfile(res[0].data || null);
    });
  }

  function loadItems() {
    return sb.from('items').select('*').order('kind').order('sort').then(function (r) {
      items = r.data || [];
      renderShop();
      applyCosmetics();
    });
  }

  function renderHeader() {
    $('loginBtn').hidden = !enabled || !!user;
    $('meBox').hidden = !profile;
    if (profile) {
      $('meCoins').textContent = profile.coins;
      $('meAvatar').innerHTML = avatarHtml(profile);
    }
    $('earnHint').hidden = !!user;
    var needs = document.querySelectorAll('.needs-account');
    for (var i = 0; i < needs.length; i++) {
      var el = needs[i];
      if (!enabled) {
        el.innerHTML = 'Gli account saranno disponibili a breve.';
        el.hidden = false;
      } else if (!user) {
        el.innerHTML = '<button class="primary" data-open-auth="signup">Crea un account</button> o <button class="link" data-open-auth="login">accedi</button> ' + esc(el.getAttribute('data-msg')) + '.';
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    }
  }

  // ---------- Accesso e registrazione ----------
  var authMode = 'login';
  function openAuth(mode) {
    if (!enabled) { toast('Gli account saranno disponibili a breve.'); return; }
    setAuthMode(mode || 'login');
    $('auMsg').textContent = '';
    $('authDlg').showModal();
  }
  function setAuthMode(mode) {
    authMode = mode;
    var tabs = document.querySelectorAll('#authDlg [data-tab]');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === mode);
    var parts = document.querySelectorAll('#authDlg [data-only]');
    for (var j = 0; j < parts.length; j++) parts[j].hidden = parts[j].getAttribute('data-only').split(' ').indexOf(mode) < 0;
    $('auSubmit').textContent = mode === 'signup' ? 'Crea account' : mode === 'reset' ? 'Invia link' : 'Accedi';
    $('auPassword').required = mode !== 'reset';
    $('auPassword').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('auUsername').required = mode === 'signup';
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-open-auth]');
    if (b) { e.preventDefault(); openAuth(b.getAttribute('data-open-auth')); }
    var tab = e.target.closest('#authDlg [data-tab]');
    if (tab) { setAuthMode(tab.getAttribute('data-tab')); $('auMsg').textContent = ''; }
  });
  $('loginBtn').onclick = function () { openAuth('login'); };
  $('auClose').onclick = function () { $('authDlg').close(); };
  $('auForgot').onclick = function () { setAuthMode('reset'); $('auMsg').textContent = 'Inserisci la tua email: ti mandiamo un link per scegliere una nuova password.'; };

  $('authForm').onsubmit = function (e) {
    e.preventDefault();
    var email = $('auEmail').value.trim();
    var pass = $('auPassword').value;
    var msg = $('auMsg');
    var btn = $('auSubmit');
    var redirect = location.origin + location.pathname;
    var p;
    if (authMode === 'signup') {
      var name = $('auUsername').value.trim();
      if (!/^[A-Za-z0-9_.]{3,20}$/.test(name)) { msg.textContent = 'Il nome deve avere da 3 a 20 caratteri tra lettere, numeri, punto e trattino basso.'; return; }
      if (!$('auConsent').checked) { msg.textContent = 'Per registrarti conferma di avere almeno 14 anni e di aver letto la privacy policy.'; return; }
      p = sb.from('profiles').select('id').ilike('username', name.replace(/[_%\\]/g, '\\$&')).maybeSingle().then(function (r) {
        if (r.data) throw new Error('Nome già in uso, scegline un altro.');
        return sb.auth.signUp({ email: email, password: pass, options: { data: { username: name }, emailRedirectTo: redirect } });
      }).then(function (r) {
        if (r.error) throw r.error;
        if (r.data.session) { $('authDlg').close(); toast('Benvenuto su Mnemoi! Hai 50 monete di benvenuto.'); }
        else msg.textContent = 'Fatto! Ti abbiamo mandato una email: apri il link per confermare l\'account, poi accedi.';
      });
    } else if (authMode === 'reset') {
      p = sb.auth.resetPasswordForEmail(email, { redirectTo: redirect }).then(function (r) {
        if (r.error) throw r.error;
        msg.textContent = 'Se l\'email è registrata, riceverai un link per scegliere una nuova password.';
      });
    } else {
      p = sb.auth.signInWithPassword({ email: email, password: pass }).then(function (r) {
        if (r.error) throw r.error;
        $('authDlg').close();
        toast('Bentornato!');
      });
    }
    btn.disabled = true;
    p.catch(function (err) { msg.textContent = errText(err); }).then(function () { btn.disabled = false; });
  };

  $('pwForm').onsubmit = function (e) {
    e.preventDefault();
    sb.auth.updateUser({ password: $('pwNew').value }).then(function (r) {
      if (r.error) { $('pwMsg').textContent = errText(r.error); return; }
      $('pwDlg').close();
      toast('Password aggiornata.');
    });
  };

  // ---------- Profilo ----------
  function renderProfile() {
    $('profileBox').hidden = !profile;
    if (!profile) return;
    $('pfAvatar').innerHTML = avatarHtml(profile);
    $('pfName').textContent = profile.username;
    $('pfEmail').textContent = user ? user.email : '';
    if (document.activeElement !== $('pfUsername')) $('pfUsername').value = profile.username;
    $('stCoins').textContent = profile.coins;
    $('stWins').textContent = profile.wins;
    $('stLosses').textContent = profile.losses;
    $('stDraws').textContent = profile.draws;
    $('pfRemoveAvatar').hidden = !profile.avatar_url;
  }

  // Ridimensiona l'immagine a 256x256 (ritaglio quadrato al centro)
  function resizeImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(img.width, img.height);
        var c = document.createElement('canvas');
        c.width = c.height = 256;
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
        URL.revokeObjectURL(img.src);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('Immagine non valida')); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { reject(new Error('Non riesco a leggere questa immagine.')); };
      img.src = URL.createObjectURL(file);
    });
  }

  function saveProfile(avatarUrl) {
    return sb.rpc('update_profile', { p_username: $('pfUsername').value.trim(), p_avatar_url: avatarUrl || '' })
      .then(function (r) { if (r.error) throw r.error; setProfile(r.data); });
  }

  function removeOldAvatars(keepPath) {
    return sb.storage.from('avatars').list(user.id).then(function (r) {
      var old = (r.data || []).map(function (f) { return user.id + '/' + f.name; })
        .filter(function (p) { return p !== keepPath; });
      if (old.length) return sb.storage.from('avatars').remove(old);
    });
  }

  $('pfForm').onsubmit = function (e) {
    e.preventDefault();
    var msg = $('pfMsg');
    var file = $('pfFile').files[0];
    msg.textContent = 'Salvataggio…';
    var chain;
    if (file) {
      var path = user.id + '/avatar-' + Date.now() + '.jpg';
      chain = resizeImage(file).then(function (blob) {
        return sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
      }).then(function (r) {
        if (r.error) throw r.error;
        var url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
        return saveProfile(url).then(function () { return removeOldAvatars(path); });
      });
    } else {
      chain = saveProfile(profile.avatar_url);
    }
    chain.then(function () { msg.textContent = 'Profilo salvato.'; $('pfFile').value = ''; })
      .catch(function (err) { msg.textContent = errText(err); });
  };

  $('pfRemoveAvatar').onclick = function () {
    saveProfile('').then(function () { return removeOldAvatars(null); })
      .then(function () { $('pfMsg').textContent = 'Immagine rimossa.'; })
      .catch(function (err) { $('pfMsg').textContent = errText(err); });
  };

  $('logoutBtn').onclick = function () { sb.auth.signOut().then(function () { location.hash = '#gioca'; toast('Sei uscito.'); }); };

  $('deleteBtn').onclick = function () {
    if (!confirm('Vuoi davvero eliminare il tuo account? Perderai monete, oggetti e statistiche. L\'operazione non si può annullare.')) return;
    sb.rpc('delete_account').then(function (r) {
      if (r.error) { toast(errText(r.error)); return; }
      return sb.auth.signOut().then(function () { location.hash = '#gioca'; toast('Account eliminato.'); });
    });
  };

  // ---------- Negozio ----------
  function previewHtml(it) {
    if (it.kind === 'board') {
      var h = '<div class="pv-board">';
      for (var i = 0; i < 16; i++) {
        var light = (Math.floor(i / 4) + i) % 2 === 0;
        h += '<i style="background:' + esc(light ? it.data.light : it.data.dark) + '"></i>';
      }
      return h + '</div>';
    }
    var cur = itemById(profile ? profile.board_theme : 'board_classico') || { data: { light: '#f0d9b5', dark: '#b58863' } };
    return '<div class="pv-pieces" style="background:linear-gradient(90deg,' + esc(cur.data.light) + ' 50%,' + esc(cur.data.dark) + ' 50%)">' +
      ['k', 'q', 'n'].map(function (t) { return '<span style="color:' + esc(it.data.w) + ';text-shadow:' + esc(it.data.ws) + '">' + GLYPH[t] + '</span>'; }).join('') +
      ['k', 'q', 'n'].map(function (t) { return '<span style="color:' + esc(it.data.b) + ';text-shadow:' + esc(it.data.bs) + '">' + GLYPH[t] + '</span>'; }).join('') +
      '</div>';
  }

  function renderShop() {
    var boards = '', pieces = '';
    items.forEach(function (it) {
      var have = it.price === 0 || owned[it.id];
      var inUse = profile && (profile.board_theme === it.id || profile.piece_style === it.id);
      var action;
      if (!profile) action = '<span class="price">' + (it.price ? '<span class="coin-ic"></span>' + it.price : 'Gratis') + '</span>';
      else if (inUse) action = '<button disabled>In uso</button>';
      else if (have) action = '<button data-equip="' + esc(it.id) + '">Usa</button>';
      else action = '<button class="primary" data-buy="' + esc(it.id) + '"' + (profile.coins < it.price ? ' disabled' : '') + '><span class="coin-ic"></span>' + it.price + '</button>';
      var card = '<div class="card' + (inUse ? ' using' : '') + '">' + previewHtml(it) +
        '<div class="card-b"><b>' + esc(it.name) + '</b>' + action + '</div></div>';
      if (it.kind === 'board') boards += card; else pieces += card;
    });
    $('shopBoards').innerHTML = boards || '<p class="muted">Il negozio sarà disponibile a breve.</p>';
    $('shopPieces').innerHTML = pieces;
  }

  document.addEventListener('click', function (e) {
    var buy = e.target.closest('[data-buy]');
    var eq = e.target.closest('[data-equip]');
    if (!buy && !eq) return;
    var id = (buy || eq).getAttribute(buy ? 'data-buy' : 'data-equip');
    var it = itemById(id);
    if (buy && !confirm('Comprare "' + it.name + '" per ' + it.price + ' monete?')) return;
    (buy || eq).disabled = true;
    var p = buy ? sb.rpc('buy_item', { p_item: id }).then(function (r) {
      if (r.error) throw r.error;
      owned[id] = true;
      profile = r.data;
      return sb.rpc('equip_item', { p_item: id });
    }) : sb.rpc('equip_item', { p_item: id });
    p.then(function (r) {
      if (r.error) throw r.error;
      setProfile(r.data);
      toast(buy ? 'Acquistato e in uso!' : 'Fatto!');
    }).catch(function (err) { toast(errText(err)); renderShop(); });
  });

  // ---------- Ruota della fortuna ----------
  function drawWheel() {
    var n = WHEEL.length, svg = '', step = 360 / n;
    for (var i = 0; i < n; i++) {
      var a0 = (i * step - 90) * Math.PI / 180, a1 = ((i + 1) * step - 90) * Math.PI / 180;
      var x0 = 95 * Math.cos(a0), y0 = 95 * Math.sin(a0), x1 = 95 * Math.cos(a1), y1 = 95 * Math.sin(a1);
      svg += '<path d="M0 0 L' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' A95 95 0 0 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' Z" fill="' + WHEEL_COLORS[i] + '" stroke="#fff" stroke-width="1.5"/>';
      var mid = i * step + step / 2;
      svg += '<text transform="rotate(' + mid + ') translate(0 -62)" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="15" font-weight="700">' + WHEEL[i] + '</text>';
    }
    svg += '<circle r="14" fill="#fff" stroke="#00000033"/><text text-anchor="middle" dominant-baseline="central" font-size="15">♞</text>';
    $('wheel').innerHTML = svg;
  }

  function renderWheelState() {
    var btn = $('spinBtn'), msg = $('wheelMsg');
    if (spinning) return;
    if (!enabled || !profile) { btn.disabled = true; msg.textContent = ''; return; }
    var done = profile.last_spin_day === romeDay();
    btn.disabled = done;
    msg.textContent = done ? 'Hai già girato oggi. Torna domani per un nuovo giro!' : 'Hai un giro disponibile.';
  }

  $('spinBtn').onclick = function () {
    if (spinning || !profile) return;
    spinning = true;
    $('spinBtn').disabled = true;
    $('wheelMsg').textContent = 'La ruota gira…';
    sb.rpc('spin_wheel').then(function (r) {
      if (r.error) throw r.error;
      var res = r.data, step = 360 / WHEEL.length;
      var center = res.index * step + step / 2;
      var target = wheelRot - (wheelRot % 360) + 360 * 6 + (360 - center) + (Math.random() - 0.5) * step * 0.6;
      wheelRot = target;
      $('wheel').style.transform = 'rotate(' + target + 'deg)';
      setTimeout(function () {
        spinning = false;
        profile.coins = res.coins;
        profile.last_spin_day = romeDay();
        setProfile(profile);
        $('wheelMsg').textContent = 'Hai vinto ' + res.prize + ' monete! Torna domani per un nuovo giro.';
        toast('+' + res.prize + ' monete!');
      }, 5200);
    }).catch(function (err) {
      spinning = false;
      $('wheelMsg').textContent = errText(err);
      loadProfile();
    });
  };

  // ---------- Classifica ----------
  function loadRanking() {
    var body = $('rankBody');
    if (!enabled) { body.innerHTML = '<tr><td colspan="4">La classifica sarà disponibile a breve.</td></tr>'; return; }
    sb.from('profiles').select('id, username, avatar_url, wins, coins')
      .order('wins', { ascending: false }).order('coins', { ascending: false }).limit(50)
      .then(function (r) {
        var rows = r.data || [];
        if (!rows.length) { body.innerHTML = '<tr><td colspan="4">Ancora nessun giocatore. Sii il primo!</td></tr>'; return; }
        body.innerHTML = rows.map(function (p, i) {
          return '<tr' + (user && p.id === user.id ? ' class="me-row"' : '') + '><td>' + (i + 1) + '</td><td><span class="who"><span class="avatar sm">' +
            avatarHtml(p) + '</span>' + esc(p.username) + '</span></td><td>' + p.wins + '</td><td>' + p.coins + '</td></tr>';
        }).join('');
      });
  }

  // ---------- Navigazione ----------
  var VIEWS = ['gioca', 'negozio', 'ruota', 'classifica', 'profilo'];
  function route() {
    var v = (location.hash || '#gioca').slice(1);
    if (VIEWS.indexOf(v) < 0) v = 'gioca';
    var secs = document.querySelectorAll('.view');
    for (var i = 0; i < secs.length; i++) secs[i].hidden = secs[i].getAttribute('data-view') !== v;
    var links = document.querySelectorAll('[data-nav]');
    for (var j = 0; j < links.length; j++) links[j].classList.toggle('on', links[j].getAttribute('data-nav') === v);
    if (v === 'classifica') loadRanking();
    if (v === 'profilo' || v === 'negozio') renderShop();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', function () {
    if (VIEWS.indexOf(location.hash.slice(1)) >= 0 || !location.hash) route();
  });

  // ---------- Partite: chiamato da app.js a fine partita ----------
  function onGameEnd(result, level, moves) {
    if (!sb || !user) return;
    sb.rpc('report_game', { p_result: result, p_level: level, p_moves: moves }).then(function (r) {
      if (r.error) return;
      if (profile) { profile.coins = r.data.coins; profile[result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws']++; setProfile(profile); }
      if (r.data.reward > 0) toast('Vittoria! +' + r.data.reward + ' monete');
      else if (result === 'win') toast('Vittoria! (nessuna moneta: partita troppo corta o limite raggiunto)');
    });
  }

  window.MnemoiAccount = { onGameEnd: onGameEnd, isLoggedIn: function () { return !!user; } };

  // ---------- Avvio ----------
  drawWheel();
  route();
  renderHeader();
  renderShop();
  renderWheelState();
  if (!enabled) { loadRanking(); return; }

  loadItems();
  sb.auth.onAuthStateChange(function (event, session) {
    var newUser = session ? session.user : null;
    var changed = (newUser && newUser.id) !== (user && user.id);
    user = newUser;
    if (event === 'PASSWORD_RECOVERY') { $('pwMsg').textContent = ''; $('pwDlg').showModal(); }
    if (changed || event === 'SIGNED_IN') setTimeout(loadProfile, 0);
  });
})();
