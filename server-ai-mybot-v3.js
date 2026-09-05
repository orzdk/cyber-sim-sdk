#!/usr/bin/env node
'use strict';

const { CyberpunkBot } = require('./server-ai');

class MyBot extends CyberpunkBot {

  constructor(options = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }

  chooseDeck() { return 'RRG_Arasaka_Onslaught'; }
  pickPlayOrder() { return 'first'; }
  decideMulligan() { return true; }

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

  _bestGearHost(gearCardId, allHosts) {

    const eligible = allHosts.filter(h =>
      !(h.equipped_gear || []).some(g => g.card_id === gearCardId)
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

  _attackerPower(attackerIid) {
    const opp = this.opponentState();
    const u   = (opp?.zones?.field || []).find(u => u.iid === attackerIid);
    return u ? this.unitPower(u) : 0;
  }

  // ─── MAIN DECISION FUNCTION ─────────────────────────────────────────────────

  selectAction(wf, board) {
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
        const opp           = this.opponentState();
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
        // scry_trash picks get trashed — take only the forced minimum;
        // otherwise picks are gains (to hand) — take as many as allowed.
        const eligible = need.eligible_iids || [];
        const want = need.scry_trash
          ? (need.take_min || 0)
          : Math.min(need.take_up_to ?? eligible.length, eligible.length);
        const ids = eligible.slice(0, Math.max(want, need.take_min || 0));
        this.log(`Top-N pick: ${ids.length} card(s)`);
        return { step: 'effect_choice_response', response: { selected_iids: ids } };
      }
      const iid = (need.available_iids || [])[0];
      if (iid !== undefined) {
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

        const attackerPower = this._attackerPower(wf.attacker_iid);
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
