#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  MyBot — example bot implementing CyberpunkBot.
//
//  Edit everything below. The base class handles all networking.
//  You only need to implement selectAction() — and optionally chooseDeck()
//  and decideMulligan().
//
//  Run:
//    node server-ai-mybot.js                          (host a room)
//    node server-ai-mybot.js --join ABCD1234          (join existing room)
//    node server-ai-mybot.js --human                  (500 ms delay between actions)
//    SERVER_URL=https://someserver.com node server-ai-mybot.js
//    MACHINE_ID=<flyMachineId> node server-ai-mybot.js  (pin to a specific machine)
//    node server-ai-mybot.js --machine <flyMachineId>
// ─────────────────────────────────────────────────────────────────────────────

const { CyberpunkBot } = require('./server-ai');

class MyBot extends CyberpunkBot {

  constructor(options = {}) {
    super(options);
    // Player handle comes from --name (set per-spawn by the launcher); the
    // parent CyberpunkBot derives botInfo from name + requester.
    if (options.name) this.name = options.name;
  }

  // ── Which deck to play ────────────────────────────────────────────────────

  chooseDeck() {
    return 'AlphaStarterMerc';
  }

  // ── Coin toss ─────────────────────────────────────────────────────────────

  pickPlayOrder(/* gameData */) {
    return 'first';
  }

  // ── Mulligan decision ─────────────────────────────────────────────────────

  decideMulligan(/* board */) {
    return true;
  }

  // ── Action selection (THE BRAIN) ──────────────────────────────────────────
  //  Called whenever it is your turn to act.
  //  wf    = waitingFor object — { step, owner, ... }
  //  board = full board state
  //
  //  Return an action object, or null to fall through to the engine fallback.
  //
  //  Helpers available on `this`:
  //    this.myState() / this.opponentState()
  //    this.card(cardId) / this.cardName(cardId)
  //    this.availableEddies() / this.tappedCount()
  //    this.readyUnitsOnField() / this.spentUnitsOnField()
  //    this.unitPower(unitRef)
  //    this.hasKeyword(cardIdOrRef, keyword)
  //    this.readyResource() — first untapped eddie/legend you can tap

  selectAction(wf, board) {
    const p = board[this.pid];

    // ─── CHOOSE GIG DIE ─────────────────────────────────────────────────────
    if (wf.step === 'choose_gig_die') {
      const die = (wf.available || [])[0];
      if (die === undefined) return null;
      this.log(`Choosing die d${die}`);
      return { step: 'choose_gig_die', sides: die };
    }

    // ─── PLAY PHASE ─────────────────────────────────────────────────────────
    if (wf.step === 'play_phase') {

      // For each card: if untapped resources >= cost, tap them and play
      for (const ref of p.zones.hand) {
        const card = this.card(ref.card_id);
        if (!card || card.type === 'Legend') continue;

        const cost = card.cost || 0;
        const tapped = this.tappedCount(p);
        const currentAvailable = this.availableEddies(p);
        const neededToTap = cost - tapped;

        const validHosts = p.zones.field.concat(
          p.zones.legends.filter(l => l.face === 'face_up')
        );

        if (card.type === 'Gear' && validHosts.length === 0) continue;

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

      // Sell a card (once per turn) for an eddie
      if (!p.sold_card_this_turn) {
        for (const ref of p.zones.hand) {
          const card = this.card(ref.card_id);
          if (card && card.eddie) {
            this.log(`Selling ${card.name} for 1 eddie`);
            return { step: 'sell_card', iid: ref.iid };
          }
        }
      }

      // Try to call a legend (once per turn) — costs 2 tapped resources
      if (!p.called_legend_this_turn) {
        const faceDownLegend = p.zones.legends.find(l => l.face === 'face_down');
        if (faceDownLegend) {
          const tappedNow = this.tappedCount(p);
          if (tappedNow >= 2) {
            this.log('Calling a legend');
            return { step: 'call_legend', iid: faceDownLegend.iid };
          }
          const neededToTap = 2 - tappedNow;
          if (this.availableEddies(p) >= neededToTap) {
            const r = this.readyResource(p);
            if (r) {
              this.log(`Tapping resource to call legend (${tappedNow}/2 tapped)`);
              return { step: 'tap_resource', iid: r.iid };
            }
          }
        }
      }

      this.log('Ending play phase');
      return { step: 'end_phase' };
    }

    // ─── DECLARE ATTACK ─────────────────────────────────────────────────────
    if (wf.step === 'declare_attack') {
      if (wf.attackable && wf.attackable.length > 0) {
        for (const attackerIid of wf.attackable) {
          const unit = p.zones.field.find(u => u.iid === attackerIid);
          if (!unit) continue;

          let target = { kind: 'player', id: this.opponentPid() };

          if (unit.entered_play_turn === board.turn_number) {
            const oppSpentUnits = this.spentUnitsOnField(this.opponentState());
            if (oppSpentUnits.length > 0) {
              target = { kind: 'unit', iid: oppSpentUnits[0].iid };
            }
          }

          this.log(`${this.cardName(unit.card_id)} attacking ${target.kind}`);
          return { step: 'declare_attack', attacker_iid: attackerIid, target };
        }
      }

      this.log('Ending attacks');
      return { step: 'end_attacks' };
    }

    // ─── CHOOSE GIG TO STEAL ────────────────────────────────────────────────
    if (wf.step === 'choose_gig_to_steal') {
      const chosen = (wf.available_iids || []).slice(0, wf.count);
      this.log(`Choosing gig(s) to steal: ${chosen.join(', ')}`);
      return { step: 'choose_gig_to_steal', iids: chosen };
    }

    // ─── EFFECT CHOICE ──────────────────────────────────────────────────────
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

      const iid = (need.available_iids || [])[0];
      if (iid !== undefined) {
        this.log(`Choosing ${need.kind}: ${iid}`);
        return { step: 'effect_choice_response', response: { iid } };
      }
      this.log(`WARNING: No available_iids for ${need.kind}, sending null`);
      return { step: 'effect_choice_response', response: { iid: null } };
    }

    // ─── DEFENSIVE STEP ─────────────────────────────────────────────────────
    if (wf.step === 'defensive_step') {

      if (wf.blocker_iids && wf.blocker_iids.length > 0) {
        this.log('Blocking attack');
        return { step: 'blocker', iid: wf.blocker_iids[0] };
      }

      if (wf.can_call_legend && this.availableEddies(p) >= 2) {
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
    roomId: null,
    host:   true,
    humanDelay: 0,
    name:   'MyBot',
    deck:   null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--join'             && args[i+1]) { options.roomId        = args[i+1]; options.host = false; i++; }
    if (args[i] === '--human')                         { options.humanDelay    = 500; }
    if (args[i] === '--name'             && args[i+1]) { options.name          = args[i+1]; i++; }
    if (args[i] === '--deck'             && args[i+1]) { options.deck          = args[i+1]; i++; }
    if (args[i] === '--server'           && args[i+1]) { options.serverUrl     = args[i+1]; i++; }
    if (args[i] === '--machine'          && args[i+1]) { options.machineId     = args[i+1]; i++; }
    if (args[i] === '--requester'        && args[i+1]) { options.requester     = args[i+1]; i++; }
    if (args[i] === '--correlation-id'   && args[i+1]) { options.correlationId = args[i+1]; i++; }
    if (args[i] === '--admin-token'      && args[i+1]) { options.adminToken    = args[i+1]; i++; }
    if (args[i] === '--seat-room'        && args[i+1]) { options.seatRoom      = args[i+1]; i++; }
    if (args[i] === '--seat-token'       && args[i+1]) { options.seatToken     = args[i+1]; i++; }
    if (args[i] === '--seat-pid'         && args[i+1]) { options.seatPid       = args[i+1]; i++; }
    if (args[i] === '--model'            && args[i+1]) { options.model         = args[i+1]; i++; }
  }

  const bot = new MyBot(options);
  const target = options.serverUrl || process.env.SERVER_URL || 'http://localhost:3000';

  const pin = options.machineId || process.env.MACHINE_ID || null;
  console.log(`\n🤖 ${bot.name}  deck=${options.deck || '(via chooseDeck)'}  mode=${options.host ? 'HOST' : `JOIN ${options.roomId}`}  speed=${options.humanDelay ? options.humanDelay+'ms' : 'robot'}`);
  console.log(`   server=${target}${pin ? `  machine=${pin}` : ''}\n`);

  bot.play()
    .then(()  => process.exit(0))
    .catch(err => {
      console.error('GAME_RESULT:{"error":true}');
      console.error('Fatal error:', err);
      process.exit(1);
    });
}
