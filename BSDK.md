# Cyberpunk TCG — Bot SDK

Build an AI opponent and connect it to the live arena at **[cyber-sim.fly.dev](https://cyber-sim.fly.dev)**.

You only need to edit one file. The base class handles all networking.

---

## Quick Start

```bash
git clone https://github.com/orzdk/cyber-sim
cd cyber-sim/shared/bsdk
```

Connect to the live server and host a room:
```bash
node server-ai-mybot.js --server https://cyber-sim.fly.dev
```

Join an existing room by code instead of hosting:
```bash
node server-ai-mybot.js --server https://cyber-sim.fly.dev --join ABCD1234
```

Flags stack freely — combine any of them:
```
--server <url>           game server to connect to (default: http://localhost:3000)
--join <code>            join an existing room instead of creating one
--human                  add a delay between actions so you can watch in the browser
--deck <key>             pick a deck (default: whatever chooseDeck() returns)
--name <name>            bot display name
```

**Mac/Linux — set server via env instead of flag:**
```bash
SERVER_URL=https://cyber-sim.fly.dev node server-ai-mybot.js
```

---

## The Three Methods to Override

Open `server-ai-mybot.js` and implement these:

### `chooseDeck()`
Return a deck key. Available decks are in the `decks/` folder.
```js
chooseDeck() {
  return 'AlphaStarterMerc';   // or 'AlphaStarterArasaka', 'Iron_Rain', etc.
}
```

### `decideMulligan(board)`
Keep your opening hand or redraw once.
```js
decideMulligan(board) {
  return true;   // true = keep, false = redraw
}
```

### `selectAction(wf, board)`
Called every time it's your turn. Return an action object or `null`.
```js
selectAction(wf, board) {
  if (wf.step === 'play_phase') {
    return { step: 'end_phase' };
  }
  return null;
}
```
`wf.step` tells you what kind of decision is needed. `wf.owner` tells you whose turn it is. `null` lets the engine fallback fire (usually `end_phase` or `end_attacks`).

---

## Helpers

All available inside `selectAction` via `this`:

```js
this.myState()                    // your full PlayerState
this.opponentState()              // opponent's PlayerState
this.opponentPid()                // 'p1' or 'p2'

this.card(cardId)                 // card definition from the database
this.cardName(cardId)             // display name string
this.hasKeyword(cardIdOrRef, kw)  // e.g. hasKeyword(unit, 'BLOCKER')

this.availableEddies()            // ready, un-tapped eddies + legends
this.tappedCount()                // resources already pre-committed
this.readyUnitsOnField()          // your ready UnitRefs
this.spentUnitsOnField()          // your spent UnitRefs
this.unitPower(unitRef)           // power including attached gear
this.readyResource()              // first untapped eddie/legend you can tap
```

All helpers accept an optional `playerState` argument — pass `this.opponentState()` to inspect the opponent.

---

## Action Reference

### `choose_gig_die`
```js
{ step: 'choose_gig_die', sides: <int> }
// sides must be one of wf.available
```

### `play_phase`
One action per call — the loop calls you again until you end the phase.

```js
{ step: 'sell_card',     iid: '<hand card iid>' }
// Once per turn. card.eddie must be true. Moves card to eddies zone.

{ step: 'tap_resource',  iid: '<eddie or legend iid>' }
// Pre-commit a resource. Both face-up and face-down legends count as 1 eddie.
// Undo with: { step: 'untap_resource', iid }

{ step: 'call_legend',   iid: '<legend iid>' }
// Flip a face-down legend face-up. Costs 2 tapped resources. Once per turn.

{ step: 'play_card',     iid: '<hand card iid>' }
// Costs card.cost in pre-tapped resources.
// Gear only: add equip_to: '<ready unit or legend iid>'
// Units can't attack the turn they enter (unless they have GO_SOLO or HASTE_VS_SPENT)

{ step: 'end_phase' }
// Done playing — advances to attack phase.
```

### `declare_attack`
```js
{ step: 'declare_attack', attacker_iid: '<from wf.attackable>', target: { kind: 'player', id: '<opponent pid>' } }
// Attack directly — steal 1 gig (+1 per 10 power above 0)

{ step: 'declare_attack', attacker_iid: '<iid>', target: { kind: 'unit', iid: '<spent opponent unit>' } }
// Fight a spent unit — higher power wins; tie = both defeated

{ step: 'end_attacks' }
// Done attacking — passes turn to opponent
```

### `defensive_step`
You defend when `wf.step === 'defensive_step'` and `wf.owner === this.pid`.

```js
{ step: 'pass_defensive' }
// Let the attack resolve as declared

{ step: 'blocker', iid: '<from wf.blocker_iids>' }
// Redirect attack to a BLOCKER unit — turns a steal into a fight

{ step: 'call_legend_defensive', iid: '<face-down legend iid>' }
// Flip a legend during defense. Costs 2 eddies. Only when wf.can_call_legend === true.
// Must follow up with pass_defensive or blocker.
```

### `choose_gig_to_steal`
```js
{ step: 'choose_gig_to_steal', iids: [<gig iid>, ...] }
// Pick wf.count gigs from wf.available_iids
```

### `effect_choice`
```js
{ step: 'effect_choice_response', response: { accept: true } }          // confirm_optional
{ step: 'effect_choice_response', response: { amount: <int> } }         // choose_amount
{ step: 'effect_choice_response', response: { iid: '<available iid>' } }// choose_unit/card
```

---

## State Reference

### PlayerState (`this.myState()`)
```
p.zones.hand      [ { iid, card_id } ]
p.zones.field     [ { iid, card_id, state, equipped_gear, entered_play_turn } ]
p.zones.legends   [ { iid, card_id, state, face, equipped_gear } ]
p.zones.eddies    [ { iid, card_id, state } ]
p.zones.gigs      [ { iid, sides, value } ]     ← your claimed gig dice
p.zones.fixer     [ { iid, sides, value:0 } ]   ← dice not yet rolled
p.zones.deck      [ { iid, card_id } ]
p.zones.trash     [ { iid, card_id } ]

p.tapped                              [ iid, ... ] — pre-committed resources
p.sold_card_this_turn                 bool
p.called_legend_this_turn             bool
p.called_legend_defensive_this_turn   bool
```

### Card definition (`this.card(cardId)`)
```
.number      card ID
.name        display name
.type        'Legend' | 'Unit' | 'Program' | 'Gear'
.cost        int or null
.power       base combat power
.eddie       true if the card can be sold for 1 eddie
.keywords    space/comma-separated string or null
.rules_text  full card text
```

### Board
```
board.turn_number
board.active_player    'p1' | 'p2'
board.overtime         bool
board.winner           null | 'p1' | 'p2'
```

---

## Win Conditions

- Start your turn with **6+ gig dice** → you win
- **Overtime** (no new gigs claimed last full round): first to **7** wins
- **Opponent's deck empties** → you win

Street Cred = sum of gig die values. Gigs stolen per direct attack = `1 + floor(power / 10)`.

---

## Error Handling

| HTTP | Meaning | What to do |
|------|---------|------------|
| 400 | Invalid action | Log it, re-read state, try something else |
| 404 | Room not found | Room was evicted — start a new game |
| 429 | Rate limited | Slow down — add a delay between actions |
| SSE disconnect | Network blip | Reconnect after 2s, re-fetch `/state` as fallback |

The server never changes state on a rejected action — safe to re-evaluate and retry.

---

## Tips

- **Eddies are not auto-deducted.** Tap resources first, then play the card.
- `tapped[]` is cleared at the start of your next turn — unused taps are wasted.
- `sell_card` adds a ready eddie immediately — you can tap it the same turn.
- Face-down legends each count as 1 eddie when tapped.
- A unit's `iid` is stable for its whole time on the field — safe to cache.
- If your blocker gets rejected (HTTP 400), immediately send `pass_defensive`.
- If you return `null` from `selectAction` three times in a row, the engine sends a fallback action automatically.
- Set a 60s per-game timeout in your runner — the engine can theoretically loop forever on a tie.

---

## Building from Scratch (no SDK)

If you want to implement the networking yourself in another language, the full HTTP API:

```
POST /api/rooms               { name, deckKey }            → { roomId, token, pid }
POST /api/rooms/:id/join      { name, deckKey }            → { token, pid }
GET  /api/rooms/:id/state                                  → snapshot
GET  /api/rooms/:id/events    SSE stream, event: state
POST /api/rooms/:id/mulligan  { token, keep: bool }        → snapshot
POST /api/rooms/:id/step      { token, input: <action> }   → snapshot
```

Listen for `event: state` on the SSE stream. When it's your turn (`waitingFor.owner === yourPid`), POST your action to `/step`. The response is the updated snapshot.
