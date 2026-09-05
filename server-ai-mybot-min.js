#!/usr/bin/env node
'use strict';

const { CyberpunkBot } = require('./server-ai');

class MinBot extends CyberpunkBot {

  chooseDeck() { return 'RRG_Arasaka_Onslaught'; }

  pickPlayOrder() { return 'first'; }

  decideMulligan() { return true; }

  selectAction(wf) {
    if (wf.step === 'choose_gig_die')
      return { step: 'choose_gig_die', sides: wf.available[0] };
    if (wf.step === 'main_phase')
      return { step: 'end_turn' };
    if (wf.step === 'choose_gig_to_steal')
      return { step: 'choose_gig_to_steal', iids: (wf.available_iids || []).slice(0, wf.count || 0) };
    if (wf.step === 'effect_choice') {
      const need = wf.choice_needed || {};
      if (need.kind === 'confirm_optional')  return { step: 'effect_choice_response', response: { accept: false } };
      if (need.kind === 'choose_amount')     return { step: 'effect_choice_response', response: { amount: need.min ?? 0 } };
      if (need.kind === 'choose_from_top_n') return { step: 'effect_choice_response',
        response: { selected_iids: (need.eligible_iids || []).slice(0, need.take_min || 0) } };  // smallest LEGAL selection
      if (need.kind === 'choose_card_type')  return { step: 'effect_choice_response',
        response: { card_type: (need.options || [])[0] } };  // mandatory — no decline exists
      return { step: 'effect_choice_response', response: { iid: (need.available_iids || [])[0] ?? null } };
    }
    return null;
  }
}

module.exports = { MinBot };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { name: 'MinBot' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server'         && args[i+1]) { opts.serverUrl     = args[++i]; }
    if (args[i] === '--human')                       { opts.humanDelay    = 500; }
    if (args[i] === '--name'           && args[i+1]) { opts.name          = args[++i]; }
    if (args[i] === '--deck'           && args[i+1]) { opts.deck          = args[++i]; }
    if (args[i] === '--deck-file'      && args[i+1]) {
      const fs   = require('fs');
      const path = require('path');
      try { opts.deckDef = JSON.parse(fs.readFileSync(path.resolve(args[++i]), 'utf-8')); }
      catch (e) { console.error(`--deck-file: ${e.message}`); process.exit(2); }
    }
    if (args[i] === '--machine'        && args[i+1]) { opts.machineId     = args[++i]; }
    if (args[i] === '--requester'      && args[i+1]) { opts.requester     = args[++i]; }
    if (args[i] === '--correlation-id' && args[i+1]) { opts.correlationId = args[++i]; }
    if (args[i] === '--creator-token'  && args[i+1]) { opts.creatorToken  = args[++i]; }
    if (args[i] === '--user-id'        && args[i+1]) { opts.userId        = args[++i]; }
    if (args[i] === '--seat-room'      && args[i+1]) { opts.seatRoom      = args[++i]; }
    if (args[i] === '--seat-token'     && args[i+1]) { opts.seatToken     = args[++i]; }
    if (args[i] === '--seat-pid'       && args[i+1]) { opts.seatPid       = args[++i]; }
    if (args[i] === '--model'          && args[i+1]) { opts.model         = args[++i]; }
  }
  const bot = new MinBot(opts);
  const mode = opts.seatRoom ? `SEAT ${opts.seatRoom}/${opts.seatPid}` : 'HOST';
  console.log(`MinBot  deck=${opts.deck || 'RRG_Arasaka_Onslaught'}  mode=${mode}`);
  bot.play().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
