#!/usr/bin/env node
'use strict';

const { CyberpunkBot } = require('./server-ai');

class MyBot extends CyberpunkBot {

  constructor(options = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }

  chooseDeck() {
    return 'RRG_Arasaka_Onslaught';
  }

  pickPlayOrder() {
    return 'first';
  }

  decideMulligan() {
    return true;
  }

  selectAction(wf, board) {
    const p = board[this.pid];

    if (wf.step === 'choose_gig_die') {
      const die = (wf.available || [])[0];
      if (die === undefined) return null;
      this.log(`Choosing die d${die}`);
      return { step: 'choose_gig_die', sides: die };
    }

    if (wf.step === 'main_phase') {

      const spendable = wf.spend_activatable_iids || [];
      for (const opp of spendable) {
        this.log(`Activating ${this.cardName(opp.card_id)}`);
        return { step: 'activate_anytime_spend', iid: opp.iid, ability_idx: opp.ability_idx };
      }

      for (const ref of p.zones.hand) {
        const card = this.card(ref.card_id);
        if (!card || card.type === 'Legend') continue;

        const cost = ref.effective_cost ?? card.cost ?? 0;
        const tapped = this.tappedCount(p);
        const currentAvailable = this.availableEddies(p);
        const neededToTap = cost - tapped;

        const validHosts = p.zones.field.concat(
          p.zones.legends.filter(l => l.face === 'face_up')
        );

        if (card.type === 'Gear' && validHosts.length === 0) continue;
        if (!this.canPlayCard(ref, board)) {
          this.log(`Skipping ${card.name} — no valid effect candidates right now`);
          continue;
        }

        if (neededToTap > 0 && currentAvailable >= neededToTap) {
          const r = this.readyResource(p);
          if (r) {
            this.log(`Tapping resource for ${card.name} (cost ${cost}, tapped=${tapped}/${cost})`);
            return { step: 'tap_resource', iid: r.iid };
          }
        }

        if (tapped >= cost) {
          if (card.type === 'Gear') {
            const host = validHosts[0];
            this.log(`Playing ${card.name} equipped to unit/legend`);
            return { step: 'play_card', iid: ref.iid, equip_to: host.iid };
          }
          this.log(`Playing ${card.name}`);
          return { step: 'play_card', iid: ref.iid };
        }
      }

      if (!p.sold_card_this_turn) {
        for (const ref of p.zones.hand) {
          const card = this.card(ref.card_id);
          if (card && card.eddie) {
            this.log(`Selling ${card.name} for 1 eddie`);
            return { step: 'sell_card', iid: ref.iid };
          }
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
        const oppGigs       = opp?.zones?.gigs  || [];
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
            this.log(`${this.cardName(unit.card_id)} (${myPower}) attacking the Gig area (${oppGigs.length} gig(s))`);
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
      this.log(`Choosing gig(s) to steal: ${chosen.join(', ')}`);
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
        this.log(`Choosing ${need.kind}: ${iid}`);
        return { step: 'effect_choice_response', response: { iid } };
      }
      this.log(`WARNING: No available_iids for ${need.kind}, sending null`);
      return { step: 'effect_choice_response', response: { iid: null } };
    }

    if (wf.step === 'attacker_interrupt_step') {
      this.log('Passing attacker interrupt');
      return { step: 'pass_attacker_interrupt' };
    }

    if (wf.step === 'defensive_step') {

      if (wf.blocker_iids && wf.blocker_iids.length > 0) {
        this.log('Blocking attack');
        return { step: 'blocker', iid: wf.blocker_iids[0] };
      }

      if (wf.can_call_legend && this.availableEddies(p) >= 1) {
        const faceDownLegend = p.zones.legends.find(l => l.face === 'face_down');
        if (faceDownLegend && !p.called_legend_defensive_this_turn) {
          this.log('Calling legend defensively');
          return { step: 'call_legend_defensive', iid: faceDownLegend.iid };
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
//  CLI ENTRY — only runs when invoked directly (`node server-ai-mybot.js …`)
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {
    humanDelay: 0,
    name:   'MyBot',
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
