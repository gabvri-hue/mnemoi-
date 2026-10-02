/*
 * Mnemoi: logica del server delle partite online.
 * Viene incollata dentro supabase/functions/partite/index.ts (vedi server/build.js)
 * e provata in locale con Node e Postgres.
 * deps: { sql (postgres.js), getUser(token) -> {id} | null, Engine, now() -> ms, rand() }
 */
function createHandler(deps) {
  'use strict';
  var sql = deps.sql, E = deps.Engine;
  var now = deps.now || function () { return Date.now(); };
  var rand = deps.rand || Math.random;

  var TC = {
    '1+0': [60, 0], '2+1': [120, 1], '3+0': [180, 0], '3+2': [180, 2],
    '5+0': [300, 0], '10+0': [600, 0], '15+10': [900, 10], '30+0': [1800, 0]
  };
  var FIRST_MOVE_MS = 30000;

  function HttpError(status, message) { this.status = status; this.message = message; }
  function fail(status, message) { throw new HttpError(status, message); }
  function isUuid(x) { return typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x); }

  function colorOf(m, uid) { return m.white === uid ? 'w' : m.black === uid ? 'b' : null; }
  function turnOf(m) { return m.ply % 2 === 0 ? 'w' : 'b'; }

  async function secretsOf(tx, id) {
    var rows = await tx`select color, square from public.match_secrets where match_id = ${id}`;
    if (!rows.length) return null;
    var h = {};
    rows.forEach(function (r) { h[r.color] = r.square; });
    return h;
  }

  async function replay(tx, m) {
    var g = new E.Game(m.variant, m.start_fen, m.variant === 'hidden' ? await secretsOf(tx, m.id) : null);
    for (var i = 0; i < m.moves.length; i++) {
      if (!g.play(m.moves[i].u)) throw new Error('Partita danneggiata alla mossa ' + (i + 1));
    }
    return g;
  }

  async function finish(tx, id, result, reason) {
    var rows = await tx`select * from public.finish_match(${id}, ${result}, ${reason})`;
    return rows[0];
  }

  function onlyKing(pos, c) {
    for (var s = 0; s < 64; s++) { var p = pos.b[s]; if (p && p.c === c && p.t !== 'k') return false; }
    return true;
  }

  // Controlla orologi e prime mosse; chiude la partita se serve. Va chiamata con la riga bloccata.
  async function sweep(tx, m) {
    if (m.status !== 'active') return m;
    var t = now(), last = new Date(m.last_move_at).getTime();
    if (m.ply < 2) {
      if (t - last > FIRST_MOVE_MS) return finish(tx, m.id, 'aborted', 'nessuna prima mossa');
      return m;
    }
    var side = turnOf(m);
    var left = (side === 'w' ? m.white_ms : m.black_ms) - (t - last);
    if (left > 0) return m;
    var g = await replay(tx, m);
    var winner = side === 'w' ? 'b' : 'w';
    if (m.variant !== 'antichess' && onlyKing(g.pos, winner)) return finish(tx, m.id, '1/2-1/2', 'tempo scaduto, materiale insufficiente');
    return finish(tx, m.id, winner === 'w' ? '1-0' : '0-1', 'tempo scaduto');
  }

  async function lockMatch(tx, id) {
    if (!isUuid(id)) fail(400, 'Partita non valida');
    var rows = await tx`select * from public.matches where id = ${id} for update`;
    if (!rows.length) fail(404, 'Partita non trovata');
    return rows[0];
  }

  function newStart(variant) {
    var st = E.startPosition(variant, rand);
    return { fen: st.fen, hw: st.hidden ? st.hidden.w : null, hb: st.hidden ? st.hidden.b : null };
  }

  async function activeMatchOf(tx, uid) {
    var rows = await tx`select * from public.matches where status = 'active' and (white = ${uid} or black = ${uid})
      order by created_at desc for update`;
    for (var i = 0; i < rows.length; i++) {
      var m = await sweep(tx, rows[i]);
      if (m.status === 'active') return m;
    }
    return null;
  }

  function checkSettings(b) {
    if (E.ORDER.indexOf(b.variant) < 0) fail(400, 'Variante non valida');
    if (!TC[b.tc]) fail(400, 'Cadenza non valida');
  }

  var actions = {
    queue: async function (uid, b) {
      checkSettings(b);
      return sql.begin(async function (tx) {
        var act = await activeMatchOf(tx, uid);
        if (act) return { match: act.id };
        var st = newStart(b.variant);
        var rows = await tx`select public.queue_join(${uid}, ${b.variant}, ${b.tc}, ${TC[b.tc][0]}, ${TC[b.tc][1]},
          ${st.fen}, ${st.hw}, ${st.hb}, ${rand() < 0.5}) as id`;
        return rows[0].id ? { match: rows[0].id } : { waiting: true };
      });
    },

    leave: async function (uid) {
      await sql`delete from public.queue where user_id = ${uid}`;
      return { ok: true };
    },

    sync: async function (uid, b) {
      if (!b.id) return { now: now() };
      return sql.begin(async function (tx) {
        var m = await sweep(tx, await lockMatch(tx, b.id));
        return { now: now(), status: m.status };
      });
    },

    move: async function (uid, b) {
      if (typeof b.uci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbnk]?$/.test(b.uci)) fail(400, 'Mossa non valida');
      return sql.begin(async function (tx) {
        var m = await lockMatch(tx, b.id);
        var me = colorOf(m, uid);
        if (!me) fail(403, 'Non giochi questa partita');
        m = await sweep(tx, m);
        if (m.status !== 'active') return { done: true, now: now() };
        if (b.ply !== m.ply || turnOf(m) !== me) fail(409, 'Non è il tuo turno');
        var g = await replay(tx, m);
        var rec = g.play(b.uci);
        if (!rec) fail(400, 'Mossa non valida');
        var t = now(), wms = m.white_ms, bms = m.black_ms;
        if (m.ply >= 2) {
          var used = t - new Date(m.last_move_at).getTime();
          if (me === 'w') wms = Math.max(0, wms - used) + m.inc_s * 1000;
          else bms = Math.max(0, bms - used) + m.inc_s * 1000;
        }
        var offer = m.draw_offer && m.draw_offer !== me ? null : m.draw_offer;
        var entry = { u: rec.u, s: rec.san };
        if (rec.rv.length) entry.rv = rec.rv;
        await tx`update public.matches set moves = moves || ${tx.json([entry])}, ply = ply + 1,
          white_ms = ${wms}, black_ms = ${bms}, last_move_at = ${new Date(t)}, draw_offer = ${offer}
          where id = ${m.id}`;
        var st = g.status();
        if (st) await finish(tx, m.id, st.result, st.reason);
        return { ok: true, now: t };
      });
    },

    resign: async function (uid, b) {
      return sql.begin(async function (tx) {
        var m = await lockMatch(tx, b.id);
        var me = colorOf(m, uid);
        if (!me) fail(403, 'Non giochi questa partita');
        m = await sweep(tx, m);
        if (m.status !== 'active') return { done: true };
        if (m.ply < 2) await finish(tx, m.id, 'aborted', 'annullata');
        else await finish(tx, m.id, me === 'w' ? '0-1' : '1-0', 'abbandono');
        return { ok: true };
      });
    },

    draw: async function (uid, b) {
      return sql.begin(async function (tx) {
        var m = await lockMatch(tx, b.id);
        var me = colorOf(m, uid);
        if (!me) fail(403, 'Non giochi questa partita');
        m = await sweep(tx, m);
        if (m.status !== 'active') return { done: true };
        if (b.decline) {
          if (m.draw_offer && m.draw_offer !== me) await tx`update public.matches set draw_offer = null where id = ${m.id}`;
          return { ok: true };
        }
        if (m.draw_offer && m.draw_offer !== me) {
          await finish(tx, m.id, '1/2-1/2', 'patta concordata');
          return { ok: true, drawn: true };
        }
        if (m.ply < 2) fail(400, 'Fai almeno una mossa prima di proporre patta');
        await tx`update public.matches set draw_offer = ${me} where id = ${m.id}`;
        return { ok: true, offered: true };
      });
    },

    flag: async function (uid, b) {
      return sql.begin(async function (tx) {
        var m = await sweep(tx, await lockMatch(tx, b.id));
        return { status: m.status, now: now() };
      });
    },

    challenge: async function (uid, b) {
      checkSettings(b);
      if (!isUuid(b.to) || b.to === uid) fail(400, 'Giocatore non valido');
      return sql.begin(async function (tx) {
        var ok = false;
        if (b.rematch_of) {
          if (!isUuid(b.rematch_of)) fail(400, 'Partita non valida');
          var r = await tx`select 1 from public.matches where id = ${b.rematch_of} and status <> 'active'
            and ((white = ${uid} and black = ${b.to}) or (black = ${uid} and white = ${b.to}))`;
          ok = r.length > 0;
        } else {
          var f = await tx`select 1 from public.friendships where status = 'accepted'
            and ((from_user = ${uid} and to_user = ${b.to}) or (from_user = ${b.to} and to_user = ${uid}))`;
          ok = f.length > 0;
        }
        if (!ok) fail(403, 'Puoi sfidare solo i tuoi amici');
        // se l'altro mi ha già proposto una rivincita uguale, la accetto
        if (b.rematch_of) {
          var back = await tx`select * from public.challenges where from_user = ${b.to} and to_user = ${uid}
            and rematch_of = ${b.rematch_of} and status = 'pending' for update`;
          if (back.length) return acceptChallenge(tx, uid, back[0]);
        }
        await tx`update public.challenges set status = 'cancelled' where from_user = ${uid} and to_user = ${b.to} and status = 'pending'`;
        var c = await tx`insert into public.challenges (from_user, to_user, variant, tc, rematch_of)
          values (${uid}, ${b.to}, ${b.variant}, ${b.tc}, ${b.rematch_of || null}) returning id`;
        return { challenge: c[0].id };
      });
    },

    accept: async function (uid, b) {
      if (!isUuid(b.id)) fail(400, 'Sfida non valida');
      return sql.begin(async function (tx) {
        var rows = await tx`select * from public.challenges where id = ${b.id} and to_user = ${uid} for update`;
        if (!rows.length) fail(404, 'Sfida non trovata');
        if (rows[0].status !== 'pending') fail(409, 'La sfida non è più valida');
        if (now() - new Date(rows[0].created_at).getTime() > 10 * 60000) fail(409, 'La sfida è scaduta');
        return acceptChallenge(tx, uid, rows[0]);
      });
    },

    decline: async function (uid, b) {
      if (!isUuid(b.id)) fail(400, 'Sfida non valida');
      await sql`update public.challenges set status = case when to_user = ${uid} then 'declined' else 'cancelled' end
        where id = ${b.id} and (to_user = ${uid} or from_user = ${uid}) and status = 'pending'`;
      return { ok: true };
    }
  };

  async function acceptChallenge(tx, uid, c) {
    var act = await activeMatchOf(tx, uid);
    if (act) fail(409, 'Finisci prima la partita in corso');
    var actOther = await activeMatchOf(tx, c.from_user);
    if (actOther) fail(409, 'L\'avversario sta già giocando');
    await tx`delete from public.queue where user_id in (${uid}, ${c.from_user})`;
    var white, black;
    if (c.rematch_of) {
      var prev = await tx`select white, black from public.matches where id = ${c.rematch_of}`;
      // a colori invertiti rispetto alla partita precedente
      if (prev.length && prev[0].white === c.from_user) { white = uid; black = c.from_user; }
      else { white = c.from_user; black = uid; }
    } else if (rand() < 0.5) { white = uid; black = c.from_user; }
    else { white = c.from_user; black = uid; }
    var st = newStart(c.variant);
    var t = TC[c.tc];
    var mid = await tx`select public._create_match(${c.variant}, ${c.tc}, ${t[0]}, ${t[1]}, ${white}, ${black},
      ${st.fen}, ${st.hw}, ${st.hb}) as id`;
    await tx`update public.challenges set status = 'accepted', match_id = ${mid[0].id} where id = ${c.id}`;
    return { match: mid[0].id };
  }

  // Risposta: { status, body }
  return async function handle(token, body) {
    try {
      if (!body || typeof body !== 'object' || !actions[body.action]) fail(400, 'Richiesta non valida');
      var user = token ? await deps.getUser(token) : null;
      if (!user || !user.id) fail(401, 'Devi accedere');
      var res = await actions[body.action](user.id, body);
      return { status: 200, body: res };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      console.error(e);
      return { status: 500, body: { error: 'Errore del server, riprova' } };
    }
  };
}

if (typeof module === 'object' && module.exports) module.exports = createHandler;
