#!/usr/bin/env node
'use strict';

const { CyberpunkBot } = require('./server-ai');

const ENGINE = (() => {
  for (const id of ['../engine', 'cyber-sim-engine', '../cyber-sim-engine']) {
    try {
      const e = require(id);
      if (e.step && e.applyStaticPower && e.legendCallCost && e.legendSpendable) return e;
    } catch (_) {}
  }
  return null;
})();

const WIN = 1e6;

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = 0 | Math.random() * (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class MyBot extends CyberpunkBot {

  constructor(options = {}) {
    super(options);
    if (options.name) this.name = options.name;
    this.depth  = options.depth  ?? 2; 
    this.budget = options.budget ?? 3000;
    this._queue = [];
    this._seen  = {};
  }

  chooseDeck() { return 'RRG_Arasaka_Onslaught'; }
  pickPlayOrder() { return 'first'; }

  decideMulligan(board) {
    const hand = board?.[this.pid]?.zones?.hand || [];
    const cards = hand.map(r => this.card(r.card_id)).filter(Boolean);
    if (cards.length === 0) return true;
    const units    = cards.filter(c => c.type === 'Unit');
    const sellable = cards.filter(c => c.eddie).length;
    const early    = units.filter(c => (c.cost || 0) <= 4).length;
    const keep = units.length >= 2 && sellable >= 1 && early >= 1;
    this.log(`Mulligan check: ${units.length} Units (${early} early), ${sellable} sellable → ${keep ? 'keep' : 'redraw'}`);
    return keep;
  }

  async setupRoom() {
    await super.setupRoom();
    if (this.deckDef) {
      this._deckList = {};
      for (const id of (this.deckDef.legends || [])) this._deckList[id] = (this._deckList[id] || 0) + 1;
      for (const c of (this.deckDef.cards || []))   this._deckList[c.card_id] = (this._deckList[c.card_id] || 0) + c.count;
      return;
    }
    const key = this.deck || this.gameData?.players?.[this.pid]?.deckKey;
    if (!key) return;
    try { this._deckList = (await this.httpGet(`/api/decks/${encodeURIComponent(key)}`)).cards || null; }
    catch (_) { this._deckList = null; }
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  _effectiveKeywords(unit) {
    const kws = new Set();
    const def = this.card(unit.card_id);
    if (def?.keywords) {
      def.keywords.toUpperCase().split(/[\s,]+/).filter(Boolean).forEach(k => kws.add(k));
    }
    for (const g of (unit.equipped_gear || [])) {
      const gs = this.scripts?.[g.card_id];
      if (!gs) continue;
      for (const s of (gs.statics || [])) {
        if (s.kind === 'AuraKeyword' && s.affects?.is === 'equipped_host' && s.keyword) {
          kws.add(s.keyword.toUpperCase());
        }
      }
    }
    return kws;
  }

  _gearGrantsBlocker(gearCardId) {
    const gs = this.scripts?.[gearCardId];
    if (!gs) return false;
    return (gs.statics || []).some(s =>
      s.kind === 'AuraKeyword' && s.keyword === 'BLOCKER' && s.affects?.is === 'equipped_host'
    );
  }


  _legendWantsGear(legend, gearCardId) {
    const gs = this.scripts?.[gearCardId], ls = this.scripts?.[legend.card_id];
    const onSpent  = (gs?.abilities || []).some(a => a.trigger?.event === 'OnSpent' && a.trigger?.by === 'host');
    const goSolo   = (ls?.statics || []).some(st => st.kind === 'SelfKeyword' && st.keyword === 'GO_SOLO');
    const usesGear = JSON.stringify(ls || {}).includes('"equipped_to"');
    return onSpent || goSolo || usesGear;
  }

  _bestGearHost(gearCardId, allHosts) {

    const eligible = allHosts.filter(h =>
      !(h.equipped_gear || []).some(g => g.card_id === gearCardId) &&
      (h.face === undefined || this._legendWantsGear(h, gearCardId))   // face ⇒ still in the legends area
    );
    if (eligible.length === 0) return null;

    const ready = eligible.filter(h => h.state === 'ready');
    const candidates = ready.length > 0 ? ready : eligible;

    if (this._gearGrantsBlocker(gearCardId)) {
      const needsBlocker = candidates.filter(h => !this._effectiveKeywords(h).has('BLOCKER'));
      if (needsBlocker.length === 0) return null; 
      return needsBlocker.sort((a, b) => this.unitPower(b) - this.unitPower(a))[0];
    }

    return candidates.sort((a, b) => this.unitPower(b) - this.unitPower(a))[0];
  }

  _sellingEnablesPlay(p) {
    const tapped    = this.tappedCount(p);
    const available = this.availableEddies(p);
    const totalNow  = tapped + available;
    return p.zones.hand.some(ref => {
      const card = this.card(ref.card_id);
      if (!card || card.type === 'Legend') return false;
      const cost = ref.effective_cost ?? card.cost ?? 0;
      return cost > totalNow && cost <= totalNow + 1;
    });
  }

  _bestCardToSell(hand) {
    const sellable = hand.filter(ref => (this.card(ref.card_id) || {}).eddie);
    if (sellable.length === 0) return null;
    return sellable.sort((a, b) =>
      (this.card(a.card_id)?.power || 0) - (this.card(b.card_id)?.power || 0)
    )[0];
  }

  _spendAbilityWorthFiring(sp, board) {
    const script = this.scripts?.[sp.card_id];
    if (!script) return true;
    for (const ab of (script.abilities || [])) {
      if (ab.kind !== 'spend_activated') continue;
      if (ab.effect?.length && !this._effectListCouldFire(ab.effect, board, new Set())) return false;
    }
    return true;
  }

  _legendHasOnCallEffect(legendCardId) {
    return !!(this.scripts?.[legendCardId]?.onCall?.length);
  }

  _attackerPower(attackerIid, board) {
    const opp = board[this.opponentPid()];
    const u   = (opp?.zones?.field || []).find(u => u.iid === attackerIid);
    return u ? this.unitPower(u) : 0;
  }

  // ─── MAIN DECISION FUNCTION ─────────────────────────────────────────────────

  selectAction(wf, board, rejected) {
    if (!this._modeLogged) {
      this._modeLogged = true;
      this.log(ENGINE ? `Look-ahead ON (depth ${this.depth}) — moves are tried on the rules engine first`
                      : 'Look-ahead OFF — rules engine not found; playing on the fallback heuristics');
    }
    if (ENGINE) {
      try {
        const action = this._simSelect(wf, board, rejected);
        if (action) return action;
      } catch (e) {
        this._queue = [];
        this.error(`look-ahead failed at ${wf.step}: ${e?.message || e}`);
      }
    }
    return this._heuristicAction(wf, board);
  }

  _heuristicAction(wf, board) {
    const p = board[this.pid];

    if (wf.step === 'choose_gig_die') {
      const die = (wf.available || [])[0];
      if (die === undefined) return null;
      this.log(`Choosing die d${die}`);
      return { step: 'choose_gig_die', sides: die };
    }

    if (wf.step === 'main_phase') {

      for (const sp of (wf.spend_activatable_iids || [])) {
        if (!this._spendAbilityWorthFiring(sp, board)) {
          this.log(`Skipping ${this.cardName(sp.card_id)} spend ability — no live targets`);
          continue;
        }
        this.log(`Activating ${this.cardName(sp.card_id)}`);
        return { step: 'activate_anytime_spend', iid: sp.iid, ability_idx: sp.ability_idx };
      }

      for (const ref of p.zones.hand) {
        const card = this.card(ref.card_id);
        if (!card || card.type === 'Legend') continue;

        const cost        = ref.effective_cost ?? card.cost ?? 0;
        const tapped      = this.tappedCount(p);
        const available   = this.availableEddies(p);
        const neededToTap = cost - tapped;

        if (card.type === 'Gear') {
          const allHosts = p.zones.field.concat(p.zones.legends.filter(l => l.face === 'face_up'));

          const host = this._bestGearHost(ref.card_id, allHosts);
          if (!host) {
            this.log(`Skipping ${card.name} — no suitable host`);
            continue;
          }
          if (!this.canPlayCard(ref, board)) {
            this.log(`Skipping ${card.name} — no valid effect candidates`);
            continue;
          }
          if (neededToTap > 0 && available >= neededToTap) {
            const r = this.readyResource(p);
            if (r) {
              this.log(`Tapping for ${card.name} (cost ${cost}, tapped=${tapped})`);
              return { step: 'tap_resource', iid: r.iid };
            }
          }
          if (tapped >= cost) {
            this.log(`Playing ${card.name} → ${this.cardName(host.card_id)}`);
            return { step: 'play_card', iid: ref.iid, equip_to: host.iid };
          }

        } else {
          if (!this.canPlayCard(ref, board)) {
            this.log(`Skipping ${card.name} — no valid effect candidates`);
            continue;
          }
          if (neededToTap > 0 && available >= neededToTap) {
            const r = this.readyResource(p);
            if (r) {
              this.log(`Tapping for ${card.name} (cost ${cost}, tapped=${tapped})`);
              return { step: 'tap_resource', iid: r.iid };
            }
          }
          if (tapped >= cost) {
            this.log(`Playing ${card.name}`);
            return { step: 'play_card', iid: ref.iid };
          }
        }
      }

      if (!p.sold_card_this_turn && this._sellingEnablesPlay(p)) {
        const toSell = this._bestCardToSell(p.zones.hand);
        if (toSell) {
          this.log(`Selling ${this.cardName(toSell.card_id)} (enables a play)`);
          return { step: 'sell_card', iid: toSell.iid };
        }
      }

      if (!p.called_legend_this_turn) {
        const faceDownLegend = p.zones.legends.find(l => l.face === 'face_down');
        if (faceDownLegend) {
          const tappedNow = this.tappedCount(p);
          if (tappedNow >= 1) {
            this.log('Calling a legend');
            return { step: 'call_legend', iid: faceDownLegend.iid };
          }
          if (this.availableEddies(p) >= 1) {
            const r = this.readyResource(p);
            if (r) {
              this.log('Tapping resource to call legend');
              return { step: 'tap_resource', iid: r.iid };
            }
          }
        }
      }

      if (wf.attackable && wf.attackable.length > 0) {
        const opp           = board[this.opponentPid()];
        const oppGigs       = opp?.zones?.gigs   || [];
        const oppSpentUnits = this.spentUnitsOnField(opp);
        const mustAttack    = new Set(wf.must_attack_iids || []);

        for (const attackerIid of wf.attackable) {
          const unit = p.zones.field.find(u => u.iid === attackerIid);
          if (!unit) continue;
          const myPower   = this.unitPower(unit);
          const compelled = mustAttack.has(attackerIid);

          const tgt       = (wf.attack_targets && wf.attack_targets[attackerIid]) || { gigs: false, unit_iids: [] };
          const legalUnit = new Set(tgt.unit_iids || []);

          const winnableSpent = oppSpentUnits.filter(u => legalUnit.has(u.iid) && this.unitPower(u) <= myPower);
          if (winnableSpent.length > 0) {
            const target = winnableSpent.sort((a, z) => this.unitPower(z) - this.unitPower(a))[0];
            this.log(`${this.cardName(unit.card_id)} (${myPower}) attacking spent ${this.cardName(target.card_id)} (${this.unitPower(target)})`);
            return { step: 'declare_attack', attacker_iid: attackerIid, target: { kind: 'unit', iid: target.iid } };
          }

          if (tgt.gigs && myPower > 0 && oppGigs.length > 0) {
            this.log(`${this.cardName(unit.card_id)} (${myPower}) attacking gigs`);
            return { step: 'declare_attack', attacker_iid: attackerIid, target: { kind: 'gigs' } };
          }

          if (compelled) {
            const legalSpent = oppSpentUnits.filter(u => legalUnit.has(u.iid));
            if (legalSpent.length > 0) {
              const target = legalSpent.sort((a, z) => this.unitPower(a) - this.unitPower(z))[0];
              this.log(`${this.cardName(unit.card_id)} compelled — attacking spent ${this.cardName(target.card_id)} (unfavorable)`);
              return { step: 'declare_attack', attacker_iid: attackerIid, target: { kind: 'unit', iid: target.iid } };
            }
            if (tgt.gigs) {
              this.log(`${this.cardName(unit.card_id)} compelled — attacking gigs`);
              return { step: 'declare_attack', attacker_iid: attackerIid, target: { kind: 'gigs' } };
            }
          }
        }
      }

      this.log('Ending turn');
      return { step: 'end_turn' };

    }

    if (wf.step === 'choose_gig_to_steal') {
      const chosen = (wf.available_iids || []).slice(0, wf.count);
      this.log(`Stealing ${chosen.length} gig(s)`);
      return { step: 'choose_gig_to_steal', iids: chosen };
    }

    if (wf.step === 'effect_choice') {
      const need = wf.choice_needed;
      if (!need) return null;

      if (need.kind === 'confirm_optional') {
        this.log('Accepting optional effect');
        return { step: 'effect_choice_response', response: { accept: true } };
      }
      if (need.kind === 'choose_amount') {
        let amt = need.max;
        if (need.exclude_zero && amt === 0) amt = need.min;
        this.log(`Choosing amount ${amt}`);
        return { step: 'effect_choice_response', response: { amount: amt } };
      }
      if (need.kind === 'choose_units') {
        const ids = (need.available_iids || []).slice(0, need.take_up_to || 1);
        this.log(`Multi-pick: ${ids.length} unit(s)`);
        return { step: 'effect_choice_response', response: { selected_iids: ids } };
      }
      if (need.kind === 'choose_card_type') {
        const t = (need.options || [])[0];
        this.log(`Choosing card type: ${t}`);
        return { step: 'effect_choice_response', response: { card_type: t } };
      }
      if (need.kind === 'choose_from_top_n') {

        const eligible = need.eligible_iids || [];
        const want = need.scry_trash
          ? (need.take_min || 0)
          : Math.min(need.take_up_to ?? eligible.length, eligible.length);
        const ids = eligible.slice(0, Math.max(want, need.take_min || 0));
        this.log(`Top-N pick: ${ids.length} card(s)`);
        return { step: 'effect_choice_response', response: { selected_iids: ids } };
      }
      const iid = this.pickIid(need);
      if (iid !== null) {
        this.log(`Choosing: ${iid}`);
        return { step: 'effect_choice_response', response: { iid } };
      }
      return { step: 'effect_choice_response', response: { iid: null } };
    }

    if (wf.step === 'attacker_interrupt_step') {
      this.log('Passing attacker interrupt');
      return { step: 'pass_attacker_interrupt' };
    }

    if (wf.step === 'defensive_step') {

      if (wf.blocker_iids && wf.blocker_iids.length > 0) {

        const attackerPower = this._attackerPower(wf.attacker_iid, board);
        const targetKind    = wf.target?.kind;

        let bestBlocker = null;
        for (const iid of wf.blocker_iids) {
          const unit = p.zones.field.find(u => u.iid === iid);
          if (!unit) continue;
          const pw = this.unitPower(unit);
          if (!bestBlocker || pw > bestBlocker.power) bestBlocker = { iid, power: pw };
        }

        if (targetKind === 'gigs') {
          if (bestBlocker) {
            this.log(`Blocking gig attack with ${bestBlocker.power} vs attacker ${attackerPower}`);
            return { step: 'blocker', iid: bestBlocker.iid };
          }
        } else {

          if (bestBlocker && bestBlocker.power >= attackerPower) {
            this.log(`Blocking unit attack (${bestBlocker.power} >= ${attackerPower})`);
            return { step: 'blocker', iid: bestBlocker.iid };
          }
          this.log(`Passing block — our best (${bestBlocker?.power ?? 0}) dies to attacker (${attackerPower})`);
        }
      }

      if (wf.can_call_legend && this.availableEddies(p) >= 1) {
        const faceDownLegend = p.zones.legends.find(l => l.face === 'face_down');
        if (faceDownLegend && !p.called_legend_defensive_this_turn) {
          if (this._legendHasOnCallEffect(faceDownLegend.card_id)) {
            this.log('Calling legend defensively (has onCall effect)');
            return { step: 'call_legend_defensive', iid: faceDownLegend.iid };
          }
          this.log('Skipping defensive legend call — no onCall effect');
        }
      }

      this.log('Passing defense');
      return { step: 'pass_defensive' };
    }

    return null;

  }

  // ─── LOOK-AHEAD ─────────────────────────────────────────────────────────────

  _simSelect(wf, board, rejected) {
    if (wf.step === 'choose_gig_die') return null;
    const turn = board.turn_number;
    if (rejected?.size || wf.step !== 'main_phase' || this._queueTurn !== turn) this._queue = [];
    if (this._queue.length) return this._queue.shift();

    this._steps = 0;
    const b    = this._prepBoard(board);
    const pick = this._decide(b, wf);
    if (!pick) return null;
    this.log(`${this._describe(b, pick.macro)}  [${pick.v.toFixed(1)}, ${this._steps} sims]`);
    this._queue     = pick.macro.slice(1);
    this._queueTurn = turn;
    return pick.macro[0];
  }

  _describe(b, macro) {
    const last = macro[macro.length - 1];
    const z    = b[this.pid].zones;
    const name = iid => this.cardName(([...z.hand, ...z.field, ...z.legends].find(r => r.iid === iid) || {}).card_id || '?');
    if (last.step === 'declare_attack') return `Attack: ${name(last.attacker_iid)} → ${last.target.kind}`;
    if (last.step === 'call_legend')    return 'call_legend';   // face-down: identity is a guess
    if (last.equip_to) return `Play ${name(last.iid)} → ${name(last.equip_to)}`;
    if (last.iid)      return `${last.step} ${name(last.iid)}`;
    return last.response ? `Choice ${JSON.stringify(last.response)}` : last.step;
  }

  _prepBoard(board) {
    const b = structuredClone(ENGINE.cleanBoardForExternal(board));
    b._trace = null;
    const mine = b[this.pid].zones, theirs = b[this.opponentPid()].zones;
    const fill = this._fillers();

    for (const r of [...mine.hand, ...mine.trash, ...mine.field]) if (r.card_id) this._seen[r.iid] = r.card_id;
    for (const e of mine.eddies)   if (!e.card_id) e.card_id = this._seen[e.iid] || fill.unit;
    for (const e of theirs.eddies) if (!e.card_id) e.card_id = fill.unit;

    this._deal(mine.deck, () => this._unseenDeckCards(mine), fill.unit);
    this._deal([...theirs.hand, ...theirs.deck], () => [], fill.unit);
    this._deal(mine.legends.filter(l => l.face === 'face_down' && !l._peeked), () => this._unseenLegends(mine), fill.legend);
    this._deal(theirs.legends.filter(l => l.face === 'face_down'), () => [], fill.legend);
    return b;
  }

  _deal(refs, pool, filler) {
    const ids = shuffleInPlace(refs.every(r => r.card_id) ? refs.map(r => r.card_id) : pool());
    refs.forEach((r, i) => { r.card_id = ids[i] || filler; });
  }

  _fillers() {
    if (this._fill) return this._fill;
    const all   = Object.values(this.db);
    const blank = c => Object.keys(this.scripts[c.number] || {}).every(k => k === 'card_id');
    const pick  = type => (all.find(c => c.type === type && blank(c)) || all.find(c => c.type === type) || {}).number;
    return (this._fill = { unit: pick('Unit'), legend: pick('Legend') });
  }

  _unseenDeckCards(mine) {
    if (!this._deckList) return [];
    const left = { ...this._deckList };
    const take = id => { if (left[id] > 0) left[id]--; };
    for (const r of [...mine.hand, ...mine.trash, ...mine.removed, ...mine.field, ...mine.legends]) {
      take(r.card_id);
      for (const g of (r.equipped_gear || [])) take(g.card_id);
    }
    for (const e of mine.eddies) take(this._seen[e.iid]);
    const out = [];
    for (const [id, n] of Object.entries(left))
      if (this.card(id)?.type !== 'Legend') for (let i = 0; i < n; i++) out.push(id);
    return out;
  }

  _unseenLegends(mine) {
    const known = new Set([...mine.legends, ...mine.field, ...mine.removed, ...mine.trash].map(r => r.card_id));
    return Object.keys(this._deckList || {}).filter(id => this.card(id)?.type === 'Legend' && !known.has(id));
  }

  _sim(b, input) {
    this._steps++;
    try { return ENGINE.step(b, input); } catch (_) { return null; }   // illegal → not a candidate
  }

  _macro(b, inputs) {
    let r = { board: b, waitingFor: null };
    for (const input of inputs) { r = this._sim(r.board, input); if (!r) return null; }
    return r;
  }

  _decide(b, wf) {
    const main  = wf.step === 'main_phase';
    const cands = main
      ? [...this._mainCandidates(b, wf), [{ step: 'end_turn' }]]
      : this._choiceCandidates(b, wf, true).map(a => [a]);

    const rows = [];
    for (const macro of cands) {
      const r = this._macro(b, macro);
      if (r) rows.push({ macro, r, v: this._value(r.board, r.waitingFor, 0), tie: this._eval(r.board) });
    }
    rows.sort((x, y) => (y.v - x.v) || (y.tie - x.tie));

    if (main && this.depth > 1) {
      for (const row of rows) {
        if (this._steps > this.budget) break;
        if (row.macro[0].step === 'end_turn') continue;
        const v = this._value(row.r.board, row.r.waitingFor, this.depth - 1);
        if (this._steps <= this.budget) row.v = Math.max(row.v, v);   // a cut-off search is discarded
      }
      rows.sort((x, y) => (y.v - x.v) || (y.tie - x.tie));
    }
    return rows[0] || null;
  }

  _value(b, wf, depth) {
    if (b.winner) return b.winner === this.pid ? WIN : -WIN;
    if (!wf || wf.step === 'choose_gig_die' || this._steps > this.budget * 2) return this._eval(b);

    if (wf.step === 'main_phase') {
      if (wf.owner !== this.pid) return this._eval(b);
      let best = this._endTurnValue(b);
      if (depth > 0) {
        for (const macro of this._mainCandidates(b, wf)) {
          if (this._steps > this.budget) break;
          const r = this._macro(b, macro);
          if (r) best = Math.max(best, this._value(r.board, r.waitingFor, depth - 1));
        }
      }
      return best;
    }

    const mine = wf.owner === this.pid;
    let best = null;
    for (const a of this._choiceCandidates(b, wf, mine)) {
      const r = this._sim(b, a);
      if (!r) continue;
      const v = this._value(r.board, r.waitingFor, depth);
      if (best === null || (mine ? v > best : v < best)) best = v;
    }
    return best === null ? this._eval(b) : best;
  }

  _endTurnValue(b) {
    const r = this._sim(b, { step: 'end_turn' });
    if (!r) return this._eval(b) - 2;   // can't end yet (compelled attacker)
    return this._value(r.board, r.waitingFor, 0);
  }

  _taps(b, cost, excludeIid, gearedFirst) {
    const p    = b[this.pid];
    const need = cost - p.tapped.length;
    if (need <= 0) return [];
    const free   = c => c.state === 'ready' && !p.tapped.includes(c.iid);
    const faceUp = p.zones.legends.filter(l => free(l) && l.face === 'face_up' && ENGINE.legendSpendable(l));
    const geared = faceUp.filter(l => (l.equipped_gear || []).length > 0);
    if (gearedFirst && geared.length === 0) return null;
    const order = [
      ...(gearedFirst ? geared : []),
      ...p.zones.eddies.filter(free),
      ...p.zones.legends.filter(l => free(l) && l.face !== 'face_up'),
      ...faceUp.filter(l => !gearedFirst || !geared.includes(l)),
    ];
    const pick = order.filter(r => r.iid !== excludeIid).slice(0, need);
    const self = order.find(r => r.iid === excludeIid);
    if (pick.length < need && self) pick.push(self);   // a legend may pay for itself
    if (pick.length < need) return null;
    return pick.map(r => ({ step: 'tap_resource', iid: r.iid }));
  }

  _mainCandidates(b, wf) {
    const me = this.pid, p = b[me], out = [];
    const paid = (cost, action, excludeIid) => {
      for (const gearedFirst of [false, true]) {
        const taps = this._taps(b, cost, excludeIid, gearedFirst);
        if (taps) out.push([...taps, action]);
      }
    };

    const seen = new Set();
    for (const ref of p.zones.hand) {
      const card = this.card(ref.card_id);
      if (!card || card.type === 'Legend' || seen.has(ref.card_id)) continue;
      seen.add(ref.card_id);
      const cost = ENGINE.effectivePlayCost(b, me, ref, card);
      if (card.type === 'Gear') {
        const hosts = [...p.zones.field, ...p.zones.legends.filter(l => l.face === 'face_up')];
        for (const h of hosts) paid(cost, { step: 'play_card', iid: ref.iid, equip_to: h.iid });
      } else {
        paid(cost, { step: 'play_card', iid: ref.iid });
      }
      if (card.eddie && !p.sold_card_this_turn) out.push([{ step: 'sell_card', iid: ref.iid }]);
    }

    if (!p.called_legend_this_turn) {
      const leg = p.zones.legends.find(l => l.face === 'face_down');
      if (leg) paid(ENGINE.legendCallCost(b, me), { step: 'call_legend', iid: leg.iid }, leg.iid);
    }

    for (const l of p.zones.legends) {
      if (l.face !== 'face_up' || p.tapped.includes(l.iid)) continue;
      if (!ENGINE.effectiveKeywords(b, me, l).includes('GO_SOLO')) continue;
      paid(ENGINE.goSoloCost(b, me, l), { step: 'play_legend_solo', iid: l.iid }, l.iid);
      paid(this.card(l.card_id)?.cost || 0, { step: 'play_legend', iid: l.iid }, l.iid);
    }

    for (const sp of (wf.spend_activatable_iids || []))
      out.push([{ step: 'activate_anytime_spend', iid: sp.iid, ability_idx: sp.ability_idx }]);

    const rivalGigs = b[this.opponentPid()].zones.gigs.length;
    for (const iid of (wf.attackable || [])) {
      const t = wf.attack_targets?.[iid] || {};
      if (t.gigs && rivalGigs) out.push([{ step: 'declare_attack', attacker_iid: iid, target: { kind: 'gigs' } }]);
      for (const u of (t.unit_iids || []))
        out.push([{ step: 'declare_attack', attacker_iid: iid, target: { kind: 'unit', iid: u } }]);
    }
    return out;
  }

  _choiceCandidates(b, wf, full) {
    switch (wf.step) {
      case 'attacker_interrupt_step':
        return [{ step: 'pass_attacker_interrupt' },
          ...(wf.interrupt_spendable_iids || []).map(o => ({ step: 'activate_asset_spend', iid: o.iid, ability_idx: o.ability_idx }))];

      case 'defensive_step': {
        const out = [{ step: 'pass_defensive' }, ...(wf.blocker_iids || []).map(iid => ({ step: 'blocker', iid }))];
        if (!full) return out;
        const p = b[wf.owner];
        const leg = wf.can_call_legend && p.zones.legends.find(l => l.face === 'face_down');
        if (leg) out.push({ step: 'call_legend_defensive', iid: leg.iid });
        const seen = new Set();
        for (const iid of (wf.interrupt_castable_iids || [])) {
          const ref = p.zones.hand.find(r => r.iid === iid);
          if (!ref || seen.has(ref.card_id)) continue;
          seen.add(ref.card_id);
          out.push({ step: 'play_card_interrupt_cast', iid });
        }
        for (const o of (wf.interrupt_spendable_iids || []))
          out.push({ step: 'activate_asset_spend', iid: o.iid, ability_idx: o.ability_idx });
        return out;
      }

      case 'choose_gig_to_steal': {
        const iids = wf.available_iids || [];
        if (wf.count === 1) return iids.map(iid => ({ step: 'choose_gig_to_steal', iids: [iid] }));
        const gigs  = b[b.active_player === 'p1' ? 'p2' : 'p1'].zones.gigs;
        const value = iid => gigs.find(g => g.iid === iid)?.value || 0;
        return [{ step: 'choose_gig_to_steal', iids: [...iids].sort((x, y) => value(y) - value(x)).slice(0, wf.count) }];
      }

      case 'effect_choice':
        return this._responses(wf.choice_needed || {}).map(response => ({ step: 'effect_choice_response', response }));
    }
    return [];
  }

  _responses(cn) {
    if (Array.isArray(cn.options)) return cn.options.map(t => ({ card_type: t }));

    if (typeof cn.min === 'number') {
      const hi = typeof cn.max === 'number' ? cn.max : cn.min;
      let vals = [];
      if (hi - cn.min <= 5) for (let v = cn.min; v <= hi; v++) vals.push(v);
      else vals = [cn.min, Math.round((cn.min + hi) / 2), hi];
      if (cn.exclude_zero) vals = vals.filter(v => v !== 0);
      return vals.map(amount => ({ amount }));
    }

    if (cn.eligible_iids !== undefined || cn.take_min !== undefined || cn.take_up_to !== undefined) {
      const el  = cn.eligible_iids || cn.available_iids || [];
      const min = cn.take_min || 0;
      const max = Math.min(cn.take_up_to ?? el.length, el.length);
      const out = [];
      for (let k = min; k <= max; k++) out.push({ selected_iids: el.slice(0, k) });
      if (max >= 1 && el.length > max) out.push({ selected_iids: el.slice(-max) });
      return out.length ? out : [{ selected_iids: [] }];
    }

    if (cn.kind === 'acknowledge_reveal') return [{ acknowledge: true }];
    if (cn.kind === 'confirm_optional' || cn.pending_body || cn.otherwise_body) return [{ accept: true }, { accept: false }];

    const out = (cn.available_iids || []).slice(0, 8).map(iid => ({ iid }));
    if (cn.optional || out.length === 0) out.push({ iid: null });
    return out;
  }

  // ─── BOARD SCORE ────────────────────────────────────────────────────────────
  _eval(b) {
    const me = this.pid, opp = this.opponentPid();
    if (b.winner) return b.winner === me ? WIN : -WIN;
    let s = this._side(b, me) - this._side(b, opp);

    if (b.active_player === opp) {
      const attackers = b[opp].zones.field.filter(u => u.state === 'ready'
        && ENGINE.applyStaticPower(b, opp, u, { role: 'attacker' }) > 0
        && !ENGINE.effectiveKeywords(b, opp, u).includes('CANNOT_ATTACK')).length;
      const blockers = b[me].zones.field.filter(u => u.state === 'ready'
        && ENGINE.effectiveKeywords(b, me, u).includes('BLOCKER')).length;
      s -= Math.min(Math.max(0, attackers - blockers), b[me].zones.gigs.length) * 2.5;
    }
    return s;
  }

  _side(b, pid) {
    const z = b[pid].zones;
    const gigs = z.gigs.length;
    let s = gigs * 6 + (gigs >= 6 ? 5 : 0) + (gigs >= 7 ? 40 : 0);
    for (const g of z.gigs) s += (g.value || 0) * 0.04;

    for (const u of z.field) {
      const kw = ENGINE.effectiveKeywords(b, pid, u);
      let v = 1.5 + 0.45 * ENGINE.applyStaticPower(b, pid, u, {}) + (kw.includes('BLOCKER') ? 1 : 0);
      for (const g of (u.equipped_gear || [])) if (!(this.card(g.card_id)?.power > 0)) v += 0.6;
      s += u.state === 'spent' ? v * 0.8 : v;   // spent: can be attacked, can't block
    }

    for (const l of z.legends) {
      if (l.face !== 'face_up') continue;
      const solo = ENGINE.effectiveKeywords(b, pid, l).includes('GO_SOLO');
      s += 1 + (l.equipped_gear || []).length * (solo ? 0.6 : 0.15);
    }

    const eddies = z.eddies.length + z.legends.filter(l => ENGINE.legendSpendable(l)).length;
    s += Math.min(eddies, 6) * 1.3 + Math.max(0, Math.min(eddies, 10) - 6) * 0.6;

    for (const r of z.hand) s += pid === this.pid ? this._handValue(r, eddies) : 0.9;
    if (z.deck.length < 5) s -= (5 - z.deck.length) * 1.5;
    return s;
  }

  _handValue(ref, eddies) {
    const cost = this.card(ref.card_id)?.cost || 0;
    const v = 0.6 + 0.12 * cost;
    return cost <= eddies + 1 ? v : v * 0.6; 
  }

}

module.exports = { MyBot };

// ─────────────────────────────────────────────────────────────────────────────
//  CLI ENTRY — only runs when invoked directly (`node server-ai-mybot-v3.js …`)
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  
  const args = process.argv.slice(2);
  const options = {
    humanDelay: 0,
    name:   'MyBotV3',
    deck:   null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--human')                         { options.humanDelay    = 500; }
    if (args[i] === '--name'             && args[i+1]) { options.name          = args[i+1]; i++; }
    if (args[i] === '--deck'             && args[i+1]) { options.deck          = args[i+1]; i++; }
    if (args[i] === '--deck-file'        && args[i+1]) {
      const fs   = require('fs');
      const path = require('path');
      try { options.deckDef = JSON.parse(fs.readFileSync(path.resolve(args[i+1]), 'utf-8')); }
      catch (e) { console.error(`--deck-file: ${e.message}`); process.exit(2); }
      i++;
    }
    if (args[i] === '--server'           && args[i+1]) { options.serverUrl     = args[i+1]; i++; }
    if (args[i] === '--machine'          && args[i+1]) { options.machineId     = args[i+1]; i++; }
    if (args[i] === '--requester'        && args[i+1]) { options.requester     = args[i+1]; i++; }
    if (args[i] === '--correlation-id'   && args[i+1]) { options.correlationId = args[i+1]; i++; }
    if (args[i] === '--creator-token'    && args[i+1]) { options.creatorToken  = args[i+1]; i++; }
    if (args[i] === '--user-id'          && args[i+1]) { options.userId        = args[i+1]; i++; }
    if (args[i] === '--seat-room'        && args[i+1]) { options.seatRoom      = args[i+1]; i++; }
    if (args[i] === '--seat-token'       && args[i+1]) { options.seatToken     = args[i+1]; i++; }
    if (args[i] === '--seat-pid'         && args[i+1]) { options.seatPid       = args[i+1]; i++; }
    if (args[i] === '--model'            && args[i+1]) { options.model         = args[i+1]; i++; }
    if (args[i] === '--vs-human')                      { options.cliMode       = 'cli-host-pvb'; }
    if (args[i] === '--clivscli')                      { options.cliMode       = 'cli-vs-cli'; }
    if (args[i] === '--bot-vs'           && args[i+1]) { options.cliMode = 'cli-vs-server'; options.oppBotId = args[i+1]; i++; }
    if (args[i] === '--opp-deck'         && args[i+1]) { options.oppDeck       = args[i+1]; i++; }
    if (args[i] === '--key'              && args[i+1]) { options.pairKey       = args[i+1]; i++; }
  }

  const target = options.serverUrl || process.env.SERVER_URL || 'http://localhost:3000';

  async function preflightCliMatch() {
    
    if (options.seatRoom || !options.cliMode) return;
    if (options.cliMode === 'cli-vs-cli' && !options.pairKey) {
      console.error('--clivscli requires --key <shared-key> (min 6 chars)');
      process.exit(2);
    }
    if (options.cliMode === 'cli-vs-server' && !options.oppDeck) {
      console.error('--bot-vs requires --opp-deck <deckKey>');
      process.exit(2);
    }

    let endpoint, body;
    if (options.cliMode === 'cli-host-pvb') {
      endpoint = '/api/cli/host';
      body = {
        name: options.name,
        ...(options.deckDef ? { myDeckDef: options.deckDef } : { myDeckKey: options.deck }),
      };
    } else {
      endpoint = '/api/cli/match';
      body = {
        mode:  options.cliMode,
        name:  options.name,
        human: !!options.humanDelay,
        ...(options.deckDef ? { myDeckDef: options.deckDef } : { myDeckKey: options.deck }),
      };
      if (options.cliMode === 'cli-vs-server') {
        body.oppBotId   = options.oppBotId;
        body.oppDeckKey = options.oppDeck;
      } else {
        body.key = options.pairKey;
      }
    }

    const url  = new URL(endpoint, target);
    const data = JSON.stringify(body);
    const lib  = url.protocol === 'https:' ? require('https') : require('http');

    const resp = await new Promise((resolve, reject) => {
      const req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname + url.search,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, r => {
        let buf = '';
        r.on('data', c => buf += c);
        r.on('end', () => resolve({ status: r.statusCode, body: buf }));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });

    if (resp.status >= 400) {
      console.error(`[cli-preflight] server rejected request: HTTP ${resp.status} ${resp.body}`);
      process.exit(2);
    }

    const out = JSON.parse(resp.body);
    options.seatRoom  = out.roomId;
    options.seatToken = out.seatToken;
    options.seatPid   = out.seatPid;

    if (options.cliMode === 'cli-host-pvb') {
      console.log(`[cli-preflight] Hosting PVB room ${out.roomId} as ${out.seatPid} — waiting for a human to join from the web client.`);
    } else if (options.cliMode === 'cli-vs-server') {
      console.log(`[cli-preflight] Matched vs ${out.opponent?.botId} (${out.opponent?.name}) deck=${out.opponent?.deck}`);
    } else if (out.waiting) {
      console.log(`[cli-preflight] Created room ${out.roomId} — waiting for peer with key "${options.pairKey}"...`);
    } else {
      console.log(`[cli-preflight] Joined room ${out.roomId} as ${out.seatPid}`);
    }

  }

  (async () => {
    try { await preflightCliMatch(); }
    catch (e) {
      console.error('[cli-match] preflight failed:', e.message || e);
      process.exit(1);
    }

    const bot = new MyBot(options);
    const pin  = options.machineId || process.env.MACHINE_ID || null;
    const mode = options.seatRoom ? `SEAT ${options.seatRoom}/${options.seatPid}` : 'HOST';
    const deckLabel = options.deckDef ? `(local: ${options.deckDef.name || 'unnamed'})`
                                      : (options.deck || '(via chooseDeck)');
    console.log(`\n🤖 ${bot.name}  deck=${deckLabel}  mode=${mode}  speed=${options.humanDelay ? options.humanDelay+'ms' : 'robot'}`);
    console.log(`   server=${target}${pin ? `  machine=${pin}` : ''}\n`);

    try {
      await bot.play();
      process.exit(0);
    } catch (err) {
      console.error('GAME_RESULT:{"error":true}');
      console.error('Fatal error:', err);
      process.exit(1);
    }
  })();

}
