#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const DEFAULT_SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

class CyberpunkBot extends EventEmitter {

  constructor(options = {}) {
    super();
    this.serverUrl = options.serverUrl || DEFAULT_SERVER_URL;
    this.machineId = options.machineId || process.env.MACHINE_ID || null;
    this.name      = options.name      || 'Bot';
    this.deck      = options.deck      || null;
    this.deckDef   = options.deckDef   || null;
    if (this.deckDef && !this.deck) this.deck = this.deckDef.name || 'Local Deck';
    this.roomId    = null;
    this.token     = null;
    this.pid       = null;
    this.gameData  = null;
    this.db        = {};
    this.scripts   = {};

    this.correlationId = options.correlationId || null;
    this.creatorToken  = options.creatorToken  || null;
    this.userId        = options.userId        || null;
    this.requester     = options.requester     || null;
    this.model         = options.model         || null; 
    this.seatRoom      = options.seatRoom  || null;
    this.seatToken     = options.seatToken || null;
    this.seatPid       = options.seatPid   || null;
    this.botInfo       = options.botInfo || { name: options.name || 'MyBot', owner: this.requester || 'cli' };
    this.humanDelay         = options.humanDelay || 0;
    this.isProcessing       = false;
    this.pendingStateChange = false;
    this.sseConnection      = null;
    this._stopped           = false;
    this.result             = null;
  }

  // ─── LOGGING ────────────────────────────────────────────────────────────────

  log(...args)   { console.log(`[${this.name} ${this.pid || '?'}]`, ...args); }
  error(...args) { console.error(`[${this.name} ERROR]`, ...args); }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  _humanTick() { const opts = [400, 500, 600, 700]; return opts[Math.floor(Math.random() * opts.length)]; }

  // ─── HTTP ───────────────────────────────────────────────────────────────────

  _client(url) { return url.protocol === 'https:' ? https : http; }

  _pin(path) {
    if (!this.machineId) return path;
    if (!path.startsWith('/api/rooms') && !path.startsWith('/api/lobby')) return path;
    return path + (path.includes('?') ? '&' : '?') + 'm=' + encodeURIComponent(this.machineId);
  }

  async httpGet(path) {
    return new Promise((resolve, reject) => {
      const url = new URL(this._pin(path), this.serverUrl);
      this._client(url).get(url, res => {
        if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(data ? JSON.parse(data) : {}); }
          catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        });
      }).on('error', reject);
    });
  }

  async httpPost(path, body) {
    return new Promise((resolve, reject) => {
      const url  = new URL(this._pin(path), this.serverUrl);
      const data = JSON.stringify(body);
      const req  = this._client(url).request({
        protocol: url.protocol,
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, res => {
        let response = '';
        res.on('data', c => response += c);
        res.on('end', () => {
          if (res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}: ${response}`)); return; }
          try { resolve(response ? JSON.parse(response) : {}); }
          catch (e) { reject(new Error(`Parse error: ${e.message}\nResponse: ${response}`)); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  async httpDelete(path, body) {
    return new Promise((resolve, reject) => {
      const url  = new URL(this._pin(path), this.serverUrl);
      const data = JSON.stringify(body);
      const req  = this._client(url).request({
        protocol: url.protocol,
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'DELETE',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, res => {
        let response = '';
        res.on('data', c => response += c);
        res.on('end', () => {
          try { resolve(response ? JSON.parse(response) : {}); }
          catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  // ─── HELPERS (exposed API for bot authors) ──────────────────────────────────

  card(cardId)        { return this.db[cardId] || null; }
  cardName(cardId)    { return (this.db[cardId] || {}).name || cardId; }
  myState()           { return this.gameData?.board?.[this.pid] || null; }
  opponentPid()       { return this.pid === 'p1' ? 'p2' : 'p1'; }
  opponentState()     { return this.gameData?.board?.[this.opponentPid()] || null; }

  availableEddies(playerState) {
    const p = playerState || this.myState();
    if (!p) return 0;
    const tapped = p.tapped || [];
    const e = (p.zones.eddies  || []).filter(x => x.state === 'ready' && !tapped.includes(x.iid)).length;
    const l = (p.zones.legends || []).filter(x => x.state === 'ready' && !tapped.includes(x.iid)).length;
    return e + l;
  }

  tappedCount(playerState) {
    const p = playerState || this.myState();
    return (p?.tapped || []).length;
  }

  readyUnitsOnField(playerState) {
    const p = playerState || this.myState();
    return (p?.zones.field || []).filter(u => u.state === 'ready');
  }

  spentUnitsOnField(playerState) {
    const p = playerState || this.myState();
    return (p?.zones.field || []).filter(u => u.state === 'spent');
  }

  unitPower(unit) {
    const def = this.card(unit.card_id);
    if (!def) return 0;
    let power = def.power || 0;
    for (const g of (unit.equipped_gear || [])) {
      const gear = this.card(g.card_id);
      if (gear) power += (gear.power || 0);
    }
    return power;
  }

  hasKeyword(cardIdOrRef, keyword) {
    const cardId = typeof cardIdOrRef === 'string' ? cardIdOrRef : cardIdOrRef.card_id;
    const def = this.card(cardId);
    if (!def || !def.keywords) return false;
    return def.keywords.toUpperCase().includes(keyword.toUpperCase());
  }

  readyResource(playerState) {
    const p = playerState || this.myState();
    const tapped = p.tapped || [];
    return (
      p.zones.eddies.find (e => e.state === 'ready' && !tapped.includes(e.iid)) ||
      p.zones.legends.find(l => l.state === 'ready' && !tapped.includes(l.iid)) ||
      null
    );
  }

  // ─── PRE-PLAY FEASIBILITY ────────────────────────────────────────────────────
  canPlayCard(ref, board) {
    const script = this.scripts?.[ref.card_id];
    if (!script?.onPlay) return true;

    const card = this.card(ref.card_id);
    if (card?.type === 'Program')
      return this._mandatoryTargetsResolve(script.onPlay, board, new Set());
    return this._effectListCouldFire(script.onPlay, board, new Set());
  }

  _mandatoryTargetsResolve(effects, board, activeBindings) {
    const BOARD_ZONES = new Set(['field', 'legends', 'equipped']);
    for (const eff of effects || []) {
      if (!eff || !eff.action) continue;
      if (eff.action === 'Optional' || eff.action === 'If') continue;
      const t = eff.target;
      if (!t) continue;
      if (this._targetCouldFire(t, board, activeBindings)) {
        if (t.bind) activeBindings.add(t.bind);
        continue;
      }
      const zone = t.zone || (t.type === 'Gig' ? 'gigs'
        : t.type === 'Gear'   ? 'equipped'
        : t.type === 'Legend' ? 'legends'
        :                       'field');
      if (BOARD_ZONES.has(zone)) return false;
    }
    return true;
  }

  _effectListCouldFire(effects, board, activeBindings) {
    let anyFired = false;
    for (const eff of effects || []) {
      if (this._effectCouldFire(eff, board, activeBindings)) anyFired = true;
    }
    return anyFired;
  }

  _effectCouldFire(eff, board, activeBindings) {
    if (!eff || !eff.action) return false;

    switch (eff.action) {
      case 'Optional':
        return this._effectListCouldFire(eff.body || [], board, new Set(activeBindings));

      case 'If':
        return true;

      default: {
        if (!eff.target) return true;
        const fires = this._targetCouldFire(eff.target, board, activeBindings);
        if (fires && eff.target.bind) activeBindings.add(eff.target.bind);
        return fires;
      }
    }
  }

  _targetCouldFire(target, board, activeBindings) {
    if (target.from_self || target.from_host || target.from_trigger_source || target.from_event)
      return true;
    if (target.from_binding)
      return activeBindings.has(target.from_binding);
    if (target.optional) return true;
    if (target.quantifier === 'all' || target.quantifier === 'upto_n') return true;

    const myPid  = this.pid;
    const oppPid = this.opponentPid();
    const side   = target.side;
    const pids   = side === 'opponent' ? [oppPid]
                 : side === 'both'     ? [myPid, oppPid]
                 :                       [myPid];

    const type = target.type;
    const zone = target.zone
      || (type === 'Gig'    ? 'gigs'
        : type === 'Gear'   ? 'equipped'
        : type === 'Legend' ? 'legends'
        :                     'field');
    const MIXED_ZONES = new Set(['hand', 'trash', 'deck']);
    const typeFilterActive = type && type !== 'CardRef' && MIXED_ZONES.has(zone);

    for (const pid of pids) {
      const p = board[pid];
      if (!p) continue;
      const raw = zone === 'equipped'
        ? [...(p.zones.field || []), ...(p.zones.legends || [])]
            .flatMap(u => (u.equipped_gear || []).map(g => ({ ...g, _host: u })))
        : (p.zones[zone] || []);
      let pool = raw;
      if (typeFilterActive) {
        pool = pool.filter(r => (this.db?.[r.card_id]?.type === type));
      }
      if (target.filter) {
        pool = pool.filter(r => this._botMatchFilter(r, target.filter));
      }
      if (pool.length > 0) return true;
    }
    return false; 
  }

  _botMatchFilter(ref, filter) {
    if (!filter) return true;
    const card = this.db?.[ref.card_id] || {};
    if (filter.state !== undefined && ref.state !== filter.state) return false;
    if (filter.face  !== undefined && ref.face  !== filter.face)  return false;
    if (filter.cost_lte  !== undefined && (card.cost ?? Infinity) > filter.cost_lte)  return false;
    if (filter.cost_eq   !== undefined && card.cost  !== filter.cost_eq)   return false;
    if (filter.power_lte !== undefined && (card.power ?? Infinity) > filter.power_lte) return false;
    if (filter.color !== undefined && (card.color || '').toLowerCase() !== String(filter.color).toLowerCase()) return false;
    if (filter.type  !== undefined && card.type !== filter.type)  return false;
    if (filter.subtype_has !== undefined) {
      const subs = (card.subtype || '').split(',').map(s => s.trim());
      if (!subs.includes(filter.subtype_has)) return false;
    }
    if (filter.faction !== undefined) {
      const subs = (card.subtype || '').split(',').map(s => s.trim().toLowerCase());
      if (!subs.includes(String(filter.faction).toLowerCase())) return false;
    }
    if (filter.has_equipped_gear !== undefined) {
      const has = (ref.equipped_gear || []).length > 0;
      if (has !== !!filter.has_equipped_gear) return false;
    }
    if (filter.gear_count !== undefined && (ref.equipped_gear || []).length !== filter.gear_count) return false;
    if (filter.exclude_self && ref.iid === this.selfIid) return false;
    return true;
  }

  // ─── ROOM SETUP ─────────────────────────────────────────────────────────────

  async setupRoom() {
    this.log('Loading card database...');
    const [cards, scriptList] = await Promise.all([
      this.httpGet('/api/cards'),
      this.httpGet('/api/scripts'),
    ]);
    for (const card of cards)   this.db[card.number]       = card;
    for (const s of scriptList) this.scripts[s.card_id]    = s;
    this.log(`Loaded ${cards.length} cards, ${scriptList.length} scripts`);

    // ── Seat mode: snapshot inject pre-arranged a slot for us ──
    if (this.seatToken && this.seatRoom && this.seatPid) {
      this.roomId = this.seatRoom;
      this.token  = this.seatToken;
      this.pid    = this.seatPid;
      this.log(`Taking pre-arranged seat ${this.pid} in injected room ${this.roomId}`);
      const state = await this.httpGet(`/api/rooms/${this.roomId}/state?token=${encodeURIComponent(this.token)}`);
      this.gameData = state;
      this.log(`Initial status: ${state.status}`);
      return;
    }

    const deckKey = this.deck || (this.chooseDeck ? await this.chooseDeck() : 'RRG_Arasaka_Onslaught');
    this.deck = deckKey;

    // Host mode — create the room and claim p1 via /enter.
    this.log('Creating room...');
    const created = await this.httpPost('/api/rooms', {
      name:          this.name,
      ...(this.deckDef
        ? { isLocal: true, deckDef: this.deckDef }
        : { deckKey }),
      botInfo:       this.botInfo,
      botModel:      this.model         || undefined,
      correlationId: this.correlationId || undefined,
      creatorToken:  this.creatorToken  || undefined,
      userId:        this.userId        || undefined,
    });
    this.roomId     = created.roomId;
    this.ownerToken = created.ownerToken;
    this.log(`Created room ${this.roomId}`);

    this.log('Entering room...');
    const entered = await this.httpPost(`/api/rooms/${this.roomId}/enter`, { token: this.ownerToken });
    this.token = entered.token;
    this.pid   = entered.pid;
    this.log(`Entered as ${this.pid}`);
    this.emit('ready', { roomId: this.roomId, pid: this.pid });

    const state = await this.httpGet(`/api/rooms/${this.roomId}/state?token=${encodeURIComponent(this.token)}`);
    this.gameData = state;
    this.log(`Initial status: ${state.status}`);
  }

  // ─── SSE ────────────────────────────────────────────────────────────────────

  async connectSSE() {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this._pin(`/api/rooms/${this.roomId}/events?token=${encodeURIComponent(this.token)}`), this.serverUrl);
        const req = this._client(url).get(url.toString(), res => {
          if (res.statusCode !== 200) { reject(new Error(`SSE failed: ${res.statusCode}`)); return; }

          let buffer = '';
          res.on('data', chunk => {
            buffer += chunk.toString();
            const parts = buffer.split('\n\n');
            buffer = parts.pop();
            for (const msg of parts) {
              if (!msg.trim()) continue;
              const match = msg.match(/event: (\w+)\ndata: ([\s\S]*)/);
              if (match && match[1] === 'state') {
                try { this.emit('state', JSON.parse(match[2])); }
                catch (e) { this.error('State parse error:', e.message); }
              } else if (match && match[1] === 'evicted') {
                this.log('Room evicted by server — shutting down.');
                this.stop('evicted');
              }
            }
          });

          res.on('end', () => {
            this.log('SSE closed');
            this.sseConnection = null;
            if (this._stopped || this.result) return;
            setTimeout(async () => {
              if (this._stopped || this.result) return;
              try {
                await this.connectSSE();
                const fresh = await this.httpGet(`/api/rooms/${this.roomId}/state?token=${encodeURIComponent(this.token)}`).catch(() => null);
                if (fresh) {
                  this.log(`SSE reconnected — re-syncing state: step=${fresh.waitingFor?.step} owner=${fresh.waitingFor?.owner}`);
                  this.gameData = fresh;
                  this.processState();
                }
              } catch (err) {
                this.error('SSE reconnect failed:', err?.message || err);
                const roomGone = /404/.test(String(err?.message || err));
                if (roomGone && !this.result) {
                  if (!this.seatToken) {
                    this._rewarm();
                  } else {
                    this.log('Seat room is gone (404) — shutting down.');
                    this.stop('room_gone');
                  }
                }
              }
            }, 2000);
          });

          res.on('error', e => {
            if (this._stopped || this.result) return;
            this.error('SSE error:', e.message);
          });

          this.sseConnection = req;
          resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  // ─── MAIN LOOP ──────────────────────────────────────────────────────────────

  async play() {
    return new Promise(async (resolve, reject) => {
      this.once('game_over', resolve);
      this.once('fatal',     reject);
      try {
        await this.setupRoom();

        this.on('state', (newState) => {
          this.gameData = newState;
          const wf = newState.waitingFor;
          this.log(`SSE state: status=${newState.status} step=${wf?.step} owner=${wf?.owner} isProcessing=${this.isProcessing}`);
          if (this.isProcessing) {
            this.pendingStateChange = true;
          } else {
            this.processState();
          }
        });

        await this.connectSSE();

        if (this.gameData.status !== 'waiting') {
          this.processState();
        } else {
          this.log('Waiting for opponent to join...');
        }
      } catch (e) {
        this.error('Fatal error:', e.message);
        this.emit('fatal', e);
      }
    });
  }

  _stateSig(gd) {
    if (!gd) return '';
    return [
      gd.status,
      gd.coinToss?.winner || '',
      gd.waitingFor?.step  || '',
      gd.waitingFor?.owner || '',
      gd.players?.p1?.mulliganed,
      gd.players?.p2?.mulliganed,
      gd.board?.turn_number || 0,
    ].join('|');
  }

  async processState() {
    if (this.isProcessing || !this.gameData) return;
    const wf = this.gameData.waitingFor;
    this.log(`processState: step=${wf?.step} owner=${wf?.owner}`);
    const sigBefore = this._stateSig(this.gameData);
    this.isProcessing = true;
    this.pendingStateChange = false;
    try {
      await this._actionLoop();
    } finally {
      this.isProcessing = false;
    }
    if (this.pendingStateChange) {
      this.pendingStateChange = false;
      if (this._stateSig(this.gameData) === sigBefore) {
        setTimeout(() => this.processState(), 50);
      } else {
        this.processState();
      }
    }
  }

  stop(reason = 'stopped') {
    if (this._stopped) return;
    this._stopped = true;
    try { if (this.sseConnection) this.sseConnection.destroy(); } catch (_) {}
    const payload = { stopped: true, reason };
    this.result = payload;
    this.log(`Stopping — reason: ${reason}`);
    this.emit('game_over', payload);
  }

  // Stable signature of an action — used to remember which moves the server
  // rejected at the current board state, so the same illegal move is never
  // posted twice in a row.
  _actionSig(a) { return a ? JSON.stringify(a) : ''; }

  // Guaranteed-legal fallbacks per waiting step, in priority order. The action
  // loop walks these (skipping any already rejected) when the strategy can't
  // produce an accepted move — so the bot always makes progress or yields its
  // turn instead of spinning on a rejected move.
  _terminalCandidates(wf) {
    switch (wf?.step) {
      case 'main_phase': {
        const out = [];
        // A compelled unit blocks end_turn; satisfy the compulsion by attacking
        // the Gig area (always legal for a normal Unit) before trying to yield.
        for (const iid of (wf.must_attack_iids || []))
          out.push({ step: 'declare_attack', attacker_iid: iid, target: { kind: 'gigs' } });
        out.push({ step: 'end_turn' });
        // Last resort: a Gig-area attack from any able unit (covers odd compulsions).
        for (const iid of (wf.attackable || []))
          out.push({ step: 'declare_attack', attacker_iid: iid, target: { kind: 'gigs' } });
        return out;
      }
      case 'defensive_step':          return [{ step: 'pass_defensive' }];
      case 'attacker_interrupt_step': return [{ step: 'pass_attacker_interrupt' }];
      case 'choose_gig_die':          return (wf.available || []).map(s => ({ step: 'choose_gig_die', sides: s }));
      case 'choose_gig_to_steal': {
        const iid = (wf.available_iids || [])[0];
        return iid ? [{ step: 'choose_gig_to_steal', iids: [iid] }] : [{ step: 'end_turn' }];
      }
      default: {
        const fb = this._fallbackAction(wf?.step, wf);
        return fb ? [fb] : [];
      }
    }
  }

  async _actionLoop() {
    let gd = this.gameData;
    if (!gd) return;

    if (gd.status === 'finished') { await this._onGameFinished(gd); return; }

    // ── Coin toss ──
    if (gd.status === 'coin_toss') {
      if (gd.coinToss?.winner === this.pid) {
        if (this.humanDelay) await this.sleep(this._humanTick());
        const choice = this.pickPlayOrder ? this.pickPlayOrder(gd) : 'first';
        this.log(`Coin toss won — picking: ${choice}`);
        await this._post_pick_order(choice);
      } else {
        this.log('Coin toss: waiting for opponent to pick order');
      }
      return;
    }

    // ── Mulligan ── (only act when actively awaiting our answer)
    if (gd.status === 'mulligan') {
      if (gd.players[this.pid]?.mulliganed === false) {
        if (this.humanDelay) await this.sleep(this._humanTick());
        const keep = this.decideMulligan ? this.decideMulligan(gd.board) : true;
        await this._post_mulligan(keep);
      }
      return;
    }

    if (!gd.waitingFor)                   { this.log('  loop: no waitingFor, exiting'); return; }
    if (gd.waitingFor.owner !== this.pid) { this.log(`  loop: not my turn (owner=${gd.waitingFor.owner}), exiting`); return; }

    // Per-decision-point rejection memory. Reset when the board state moves on;
    // an accepted action (below) also clears it, so it only accumulates across a
    // burst of consecutive rejections at one unchanged state.
    const dp = this._stateSig(gd);
    if (dp !== this._dpSig) { this._dpSig = dp; this._rejected = new Set(); }
    if (!this._rejected) this._rejected = new Set();

    // Re-decide on each rejection, bounded so the bot can never spin. The
    // terminal ladder guarantees a legal move (or a clean yield) when stuck.
    const MAX_TRIES = 8;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      if (this._stopped) return;
      gd = this.gameData;
      const wf = gd?.waitingFor;
      if (!wf || wf.owner !== this.pid) return;   // turn moved on mid-loop

      let action = null;
      try {
        action = this.selectAction(wf, gd.board, this._rejected);
      } catch (e) {
        this.error(`selectAction threw at ${wf.step}@${wf.owner} T${gd.board?.turn_number ?? '?'}: ${e?.message || e}`);
      }

      // Strategy gave nothing, or repeated a move the server already rejected at
      // this state → fall back to the guaranteed-legal terminal ladder.
      if (!action || this._rejected.has(this._actionSig(action))) {
        action = this._terminalCandidates(wf).find(a => a && !this._rejected.has(this._actionSig(a))) || null;
      }

      // Even the ladder is exhausted — nothing legal remains. Yield/exit cleanly
      // rather than spin. (Unreachable in normal play: end_turn or a Gig attack
      // is essentially always legal.)
      if (!action) {
        this.error(`No legal action at ${wf.step} T${gd.board?.turn_number ?? '?'} — stopping to yield turn`);
        this.stop('no-legal-action');
        return;
      }

      if (this.humanDelay) await this.sleep(this._humanTick());
      const resp = await this._post_step(action);
      if (resp) {
        this.log(`ACK ${action.step}`);
        this._rejected = new Set();   // board advanced — old rejections are moot
        return;
      }

      // Rejected (illegal): remember it so we never re-post it, then re-decide.
      this._rejected.add(this._actionSig(action));
      this.log(`Illegal ${action.step} rejected — re-deciding (${this._rejected.size} excluded at this state)`);
    }

    // Exhausted re-decisions without an accepted move — force a yield so the
    // turn always passes to the rival rather than the bot hanging.
    const wf = this.gameData?.waitingFor;
    this.error(`Exhausted ${MAX_TRIES} attempts at ${wf?.step} — forcing yield`);
    const yieldAction = wf?.step === 'main_phase' ? { step: 'end_turn' } : this._fallbackAction(wf?.step, wf);
    const ok = yieldAction ? await this._post_step(yieldAction) : null;
    if (!ok) this.stop('cannot-yield');
  }

  async _onGameFinished(gd) {
    if (this.result) return;
    let result = gd.result || null;
    if (!result?.winner) {
      try {
        const fresh = await this.httpGet(`/api/rooms/${this.roomId}/state?token=${encodeURIComponent(this.token)}`);
        result = fresh.result || result || {};
      } catch (_) { result = result || {}; }
    }
    const iWon = result.winner === this.pid;
    const payload = { ...result, myPid: this.pid, iWon };
    this.result = payload;
    this.log(`Game FINISHED — ${iWon ? '🏆 WON' : '💀 LOST'} (${result.turns ?? '?'} turns)`);
    console.log(`GAME_RESULT:${JSON.stringify(payload)}`);
    try { if (this.sseConnection) this.sseConnection.destroy(); } catch (_) {}
    this.emit('game_over', payload);
  }

  async _rewarm(attempt = 1) {
    const MAX = 5;
    if (attempt > MAX) {
      this.error('Re-warm failed after max attempts — giving up');
      this.emit('fatal', new Error('Re-warm failed'));
      return;
    }
    const delay = Math.min(4000 * attempt, 30000);
    this.log(`Room evicted — re-warming (attempt ${attempt}/${MAX}) in ${delay / 1000}s...`);
    await this.sleep(delay);
    if (this._stopped) return;

    try {
      this.roomId     = null;
      this.token      = null;
      this.pid        = null;
      this.gameData   = null;
      this.result     = null;
      this.ownerToken = null;

      const created = await this.httpPost('/api/rooms', {
        name:     this.name,
        ...(this.deckDef
          ? { isLocal: true, deckDef: this.deckDef }
          : { deckKey: this.deck }),
        botInfo:  this.botInfo,
        botModel: this.model || undefined,
        userId:   this.userId || undefined,
      });
      this.roomId     = created.roomId;
      this.ownerToken = created.ownerToken;

      const entered = await this.httpPost(`/api/rooms/${this.roomId}/enter`, { token: this.ownerToken });
      this.token = entered.token;
      this.pid   = entered.pid;

      const state = await this.httpGet(`/api/rooms/${this.roomId}/state?token=${encodeURIComponent(this.token)}`);
      this.gameData = state;

      this.emit('ready', { roomId: this.roomId, pid: this.pid });
      this.log(`Re-warmed into room ${this.roomId}`);

      await this.connectSSE();
    } catch (e) {
      this.error(`Re-warm attempt ${attempt} failed: ${e.message}`);
      this._rewarm(attempt + 1);
    }
  }

  _fallbackAction(step, wf) {
    if (step === 'choose_gig_die')         return { step: 'choose_gig_die', sides: 4 };
    if (step === 'main_phase')             return { step: 'end_turn' };
    if (step === 'defensive_step')         return { step: 'pass_defensive' };
    if (step === 'attacker_interrupt_step') return { step: 'pass_attacker_interrupt' };
    if (step === 'choose_gig_to_steal') {
      const iid = (wf?.available_iids || [])[0];
      return iid ? { iids: [iid] } : { step: 'end_turn' };
    }
    const cn = wf?.choice_needed;
    if (cn) return { step: 'effect_choice_response', response: this._safeChoiceResponse(cn) };
    return { step: 'effect_choice_response', response: { accept: false, iid: null } };
  }

  // Minimal legal answer for any effect_choice, keyed by response SHAPE not kind
  // (shapes live in engine/data/choice-types.json). Optional choices decline;
  // mandatory ones take the least legal commitment. This keeps every bot safe for
  // every choice kind — including kinds added after this bot was written — as long
  // as the kind reuses a known response shape. A genuinely new shape needs a branch.
  _safeChoiceResponse(cn) {
    if (Array.isArray(cn.options))                                             // card_type
      return { card_type: cn.options[0] };
    if (typeof cn.min === 'number') {                                          // amount
      const hi = typeof cn.max === 'number' ? cn.max : cn.min;
      return { amount: (cn.exclude_zero && cn.min === 0) ? Math.min(1, hi) : cn.min };
    }
    if (cn.eligible_iids !== undefined || cn.take_min !== undefined || cn.take_up_to !== undefined)  // selected_iids
      return { selected_iids: (cn.eligible_iids || []).slice(0, cn.take_min || 0) };
    if (cn.kind === 'acknowledge_reveal')                                      // acknowledge
      return { acknowledge: true };
    if (cn.kind === 'confirm_optional' || cn.pending_body || cn.otherwise_body)  // accept
      return { accept: false };
    return { iid: cn.optional ? null : ((cn.available_iids || [])[0] ?? null) };  // iid
  }

  async _post_step(action) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.httpPost(`/api/rooms/${this.roomId}/step`, {
          token: this.token,
          input: action,
        });
      } catch (e) {
        const msg          = String(e?.message || e);
        const isClientErr  = /HTTP 4\d\d/.test(msg);
        const isRateLimit  = /HTTP 429/.test(msg);
        const retryable    = !isClientErr || isRateLimit;
        if (retryable && attempt === 0) {
          this.log(`Transient /step error (will retry once): ${msg.slice(0, 200)}`);
          await this.sleep(120);
          continue;
        }
        const wfSummary  = this.gameData?.waitingFor
          ? `${this.gameData.waitingFor.step}@${this.gameData.waitingFor.owner}`
          : 'null';
        const turnNo     = this.gameData?.board?.turn_number ?? '?';
        this.error(`REJECTED ${action.step}: ${msg} | action=${JSON.stringify(action)} | wf=${wfSummary} | T${turnNo}`);
        return null;
      }
    }
    return null; 
  }

  async _post_mulligan(keep) {
    try {
      const resp = await this.httpPost(`/api/rooms/${this.roomId}/mulligan`, {
        token: this.token,
        keep,
      });
      this.log(`Mulligan: ${keep ? 'keeping' : 'redrawing'}`);
      return resp;
    } catch (e) {
      this.error(`Mulligan failed: ${e.message}`);
      return null;
    }
  }

  async _post_pick_order(choice) {
    try {
      const resp = await this.httpPost(`/api/rooms/${this.roomId}/pick_order`, {
        token: this.token,
        choice,
      });
      this.log(`Pick order: ${choice}`);
      return resp;
    } catch (e) {
      this.error(`Pick order failed: ${e.message}`);
      return null;
    }
  }

  selectAction(/* wf, board */) { return null; }
}

module.exports = { CyberpunkBot };
