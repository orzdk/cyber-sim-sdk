#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  CyberpunkBot — base class for external bot developers ("Robot Wars" SDK)
//
//  Handles ALL networking, room setup, SSE state stream, action loop,
//  game-end detection. Subclass it and override:
//
//    chooseDeck()                → 'AlphaStarterMerc' | 'AlphaStarterArasaka' | ...
//    decideMulligan(board)       → true (keep) | false (redraw)
//    decideCoinToss(gameData)    → 'first' | 'second'  (called when you win the toss)
//    selectAction(wf, board)     → action object | null
//
//  Run with:  SERVER_URL=https://cyber-sim.fly.dev node my-bot.js
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const DEFAULT_SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

class CyberpunkBot extends EventEmitter {

  constructor(options = {}) {
    super();
    this.serverUrl = options.serverUrl || DEFAULT_SERVER_URL;
    // Optional Fly machine pin. When set, every /api/rooms* and /api/lobby*
    // request is suffixed with ?m=<id> so the server's fly-replay middleware
    // routes us there. Without a pin, the LB chooses arbitrarily — fine for a
    // single-machine deploy but means a multi-machine deploy will scatter
    // bot rooms across whichever machine the LB happens to pick.
    this.machineId = options.machineId || process.env.MACHINE_ID || null;
    this.name      = options.name      || 'Bot';
    this.deck      = options.deck      || null;
    this.roomId    = options.roomId    || null;
    this.token     = null;
    this.pid       = null;
    this.isHost    = options.host !== false;
    this.gameData  = null;
    this.db        = {};

    this.botInfo            = options.botInfo || null;
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

  // Append ?m=<machineId> when pinning is active and the path is one the
  // server's flyReplayPin middleware acts on (`/api/rooms*`, `/api/lobby*`).
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

  // ─── ROOM SETUP ─────────────────────────────────────────────────────────────

  async setupRoom() {
    this.log('Loading card database...');
    const cards = await this.httpGet('/api/cards');
    for (const card of cards) this.db[card.number] = card;
    this.log(`Loaded ${cards.length} cards`);

    const deckKey = this.deck || (this.chooseDeck ? await this.chooseDeck() : 'AlphaStarterMerc');
    this.deck = deckKey;

    if (this.isHost) {
      // Step 1: create the room (just reserves it, no player in yet)
      this.log('Creating room...');
      const created = await this.httpPost('/api/rooms', { name: this.name, deckKey, botInfo: this.botInfo });
      this.roomId     = created.roomId;
      this.ownerToken = created.ownerToken;
      this.log(`Created room ${this.roomId}`);

      // Step 2: enter the room as the owner
      this.log('Entering room...');
      const entered = await this.httpPost(`/api/rooms/${this.roomId}/enter`, { token: this.ownerToken });
      this.token = entered.token;
      this.pid   = entered.pid;
      this.log(`Entered as ${this.pid}`);
      this.emit('ready', { roomId: this.roomId, pid: this.pid });

    } else {
      this.log(`Joining room ${this.roomId}...`);
      const result = await this.httpPost(`/api/rooms/${this.roomId}/join`, { name: this.name, deckKey });
      this.token = result.token;
      this.pid   = result.pid;
      this.log(`Joined as ${this.pid}`);
    }

    const state = await this.httpGet(`/api/rooms/${this.roomId}/state`);
    this.gameData = state;
    this.log(`Initial status: ${state.status}`);
  }

  // ─── SSE ────────────────────────────────────────────────────────────────────

  async connectSSE() {
    return new Promise((resolve, reject) => {
      try {
        const url = new URL(this._pin(`/api/rooms/${this.roomId}/events`), this.serverUrl);
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
                const fresh = await this.httpGet(`/api/rooms/${this.roomId}/state`).catch(() => null);
                if (fresh) {
                  this.log(`SSE reconnected — re-syncing state: step=${fresh.waitingFor?.step} owner=${fresh.waitingFor?.owner}`);
                  this.gameData = fresh;
                  this.processState();
                }
              } catch (err) {
                this.error('SSE reconnect failed:', err?.message || err);
                // Room was evicted — host bots recreate their room automatically
                if (this.isHost && !this.result && /404/.test(err?.message)) {
                  this._rewarm();
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
        if (!this.isHost) this.emit('ready', { roomId: this.roomId, pid: this.pid });

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

        // Process immediately if we're past the waiting phase
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

  async processState() {
    if (this.isProcessing || !this.gameData) return;
    const wf = this.gameData.waitingFor;
    this.log(`processState: step=${wf?.step} owner=${wf?.owner}`);
    this.isProcessing = true;
    this.pendingStateChange = false;
    try {
      await this._actionLoop();
    } finally {
      this.isProcessing = false;
    }
    if (this.pendingStateChange) {
      this.pendingStateChange = false;
      this.processState();
    }
  }

  stop(reason = 'stopped') {
    if (this._stopped) return;
    this._stopped = true;
    try { if (this.sseConnection) this.sseConnection.destroy(); } catch (_) {}
    this.emit('fatal', new Error(reason));
  }

  async _actionLoop() {
    const MAX_ACTIONS = 200;
    let consecutive_failures = 0;

    for (let i = 0; i < MAX_ACTIONS; i++) {
      if (this._stopped) return;
      const gd = this.gameData;
      if (!gd) return;
      this.log(`  loop[${i}]: status=${gd.status} step=${gd.waitingFor?.step} owner=${gd.waitingFor?.owner}`);

      if (gd.status === 'finished') {
        await this._onGameFinished(gd);
        return;
      }

      // ── Coin toss ──
      if (gd.status === 'coin_toss') {
        const winner = gd.coinToss?.winner;
        if (winner === this.pid) {
          if (this.humanDelay) await this.sleep(this._humanTick());
          const choice = this.decideCoinToss ? this.decideCoinToss(gd) : 'first';
          this.log(`Coin toss won — picking: ${choice}`);
          await this._post_pick_order(choice);
        } else {
          this.log('Coin toss: waiting for opponent to pick order');
        }
        return;
      }

      // ── Mulligan ──
      if (gd.status === 'mulligan') {
        if (!gd.players[this.pid]?.mulliganed) {
          if (this.humanDelay) await this.sleep(this._humanTick());
          const keep = this.decideMulligan ? this.decideMulligan(gd.board) : true;
          await this._post_mulligan(keep);
        }
        return;
      }

      // ── Not our turn ──
      if (!gd.waitingFor) {
        this.log('  loop: no waitingFor, exiting');
        return;
      }
      if (gd.waitingFor.owner !== this.pid) {
        this.log(`  loop: not my turn (owner=${gd.waitingFor.owner}), exiting`);
        return;
      }

      // ── Select action ──
      const action = this.selectAction(gd.waitingFor, gd.board);
      if (!action) {
        consecutive_failures++;
        if (consecutive_failures > 3) {
          this.error('Too many consecutive failures, breaking');
          return;
        }
        const fb = this._fallbackAction(gd.waitingFor.step, gd.waitingFor);
        this.log(`No action found, fallback: ${fb.step}`);
        if (this.humanDelay) await this.sleep(this._humanTick());
        await this._post_step(fb);
        // Always exit; SSE will drive the next processState pass.
        return;
      }

      consecutive_failures = 0;
      if (this.humanDelay) await this.sleep(this._humanTick());
      const resp = await this._post_step(action);
      if (resp) {
        this.log(`ACK ${action.step}`);
      } else if (action.step === 'blocker') {
        this.log('Blocker rejected — falling back to pass_defensive');
        await this._post_step({ step: 'pass_defensive' });
      }
      // Exit after every post; the next state arrives via SSE and re-enters processState.
      return;
    }
    this.error(`Safety valve: ${MAX_ACTIONS} actions in one turn, breaking`);
  }

  async _onGameFinished(gd) {
    if (this.result) return;
    let result = gd.result || null;
    if (!result?.winner) {
      try {
        const fresh = await this.httpGet(`/api/rooms/${this.roomId}/state`);
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
      // Reset per-room state; keep db and deck loaded
      this.roomId     = null;
      this.token      = null;
      this.pid        = null;
      this.gameData   = null;
      this.result     = null;
      this.ownerToken = null;

      const created = await this.httpPost('/api/rooms', {
        name:    this.name,
        deckKey: this.deck,
        botInfo: this.botInfo,
      });
      this.roomId     = created.roomId;
      this.ownerToken = created.ownerToken;

      const entered = await this.httpPost(`/api/rooms/${this.roomId}/enter`, { token: this.ownerToken });
      this.token = entered.token;
      this.pid   = entered.pid;

      const state = await this.httpGet(`/api/rooms/${this.roomId}/state`);
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
    if (step === 'choose_gig_die')    return { step: 'choose_gig_die', sides: 4 };
    if (step === 'play_phase')        return { step: 'end_phase' };
    if (step === 'declare_attack')    return { step: 'end_attacks' };
    if (step === 'defensive_step')    return { step: 'pass_defensive' };
    if (step === 'choose_gig_to_steal') {
      const iid = (wf?.available_iids || [])[0];
      return iid ? { iids: [iid] } : { step: 'end_attacks' };
    }
    return { step: 'effect_choice_response', response: { accept: false, iid: null } };
  }

  async _post_step(action) {
    try {
      return await this.httpPost(`/api/rooms/${this.roomId}/step`, {
        token: this.token,
        input: action,
      });
    } catch (e) {
      this.error(`REJECTED ${action.step}: ${e.message}`);
      return null;
    }
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

  // ─── OVERRIDE IN YOUR BOT ───────────────────────────────────────────────────
  //   chooseDeck()              → return one of the deck keys (e.g. 'AlphaStarterMerc')
  //   decideMulligan(board)     → return true (keep) or false (redraw)
  //   decideCoinToss(gameData)  → return 'first' or 'second'
  //   selectAction(wf, board)   → return an action object { step: ..., ... } or null

  selectAction(/* wf, board */) { return null; }
}

module.exports = { CyberpunkBot };
