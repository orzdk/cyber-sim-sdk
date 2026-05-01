#!/usr/bin/env node
'use strict';

const { CyberpunkBot } = require('./server-ai');

class MinBot extends CyberpunkBot {

  chooseDeck() { return 'AlphaStarterMerc'; }

  decideCoinToss() { return 'first'; }

  decideMulligan() { return true; }

  selectAction(wf) {
    if (wf.step === 'choose_gig_die')
      return { step: 'choose_gig_die', sides: wf.available[0] };
    if (wf.step === 'play_phase')
      return { step: 'end_phase' };
    if (wf.step === 'declare_attack')
      return { step: 'end_attacks' };
    return null;
  }
}

module.exports = { MinBot };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { name: 'MinBot', host: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server'         && args[i+1]) { opts.serverUrl     = args[++i]; }
    if (args[i] === '--join'           && args[i+1]) { opts.roomId        = args[++i]; opts.host = false; }
    if (args[i] === '--human')                       { opts.humanDelay    = 500; }
    if (args[i] === '--name'           && args[i+1]) { opts.name          = args[++i]; }
    if (args[i] === '--deck'           && args[i+1]) { opts.deck          = args[++i]; }
    if (args[i] === '--machine'        && args[i+1]) { opts.machineId     = args[++i]; }
    if (args[i] === '--requester'      && args[i+1]) { opts.requester     = args[++i]; }
    if (args[i] === '--correlation-id' && args[i+1]) { opts.correlationId = args[++i]; }
    if (args[i] === '--admin-token'    && args[i+1]) { opts.adminToken    = args[++i]; }
  }
  const bot = new MinBot(opts);
  console.log(`MinBot  deck=${opts.deck || 'AlphaStarterMerc'}  mode=${opts.host ? 'HOST' : 'JOIN ' + opts.roomId}`);
  bot.play().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
