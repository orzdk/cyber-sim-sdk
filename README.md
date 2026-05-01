# Cyberpunk TCG — Bot SDK

Build an AI opponent for the Cyberpunk TCG arena.

The base class (`server-ai.js`) handles all networking, room creation, SSE state streaming, and the action loop. 
You override four methods.

---

## Quick Start

```bash
git clone https://github.com/orzdk/cyber-sim-bdsk
cd cyber-sim-bsdk
node server-ai-mybot.js                                    # host a room locally
node server-ai-mybot.js --server https://cyber-sim.fly.dev # host on live server
node server-ai-mybot.js --join ABCD1234                    # join existing room
```

**CLI flags:**

| Flag | Default | Description |
|------|---------|-------------|
| `--server <url>` | `http://localhost:3000` | Game server URL |
| `--join <code>` | — | Join existing room instead of hosting |
| `--deck <key>` | `chooseDeck()` | Override deck selection |
| `--name <name>` | `MyBot` | Display name |
| `--human` | off | Add ~500ms delay between actions |
| `--machine <id>` | — | Pin to a specific Fly machine |

---

## The Four Methods

### `chooseDeck()`

Return a deck key string. Available decks live in `decks/`.

```js
chooseDeck() { return 'AlphaStarterMerc'; }
```

### `decideCoinToss(gameData)`

Called when you win the coin toss. Return `'first'` or `'second'`.

```js
decideCoinToss(gameData) { return 'first'; }
```

### `decideMulligan(board)`

Keep your opening hand or redraw once. `true` = keep, `false` = redraw.

```js
decideMulligan(board) { return true; }
```

### `selectAction(wf, board)`

Called every time the engine needs your input. `wf` is the `waitingFor` object. `board` is the full board state. Return an action object or `null` (triggers a safe fallback).

```js
selectAction(wf, board) {
  if (wf.step === 'play_phase') return { step: 'end_phase' };
  return null;
}
```

---

## Helpers

Available on `this` inside all methods:

| Helper | Returns |
|--------|---------|
| `this.myState()` | Your PlayerState |
| `this.opponentState()` | Opponent's PlayerState |
| `this.opponentPid()` | `'p1'` or `'p2'` |
| `this.card(cardId)` | Card definition from database |
| `this.cardName(cardId)` | Display name string |
| `this.hasKeyword(cardIdOrRef, kw)` | Boolean keyword check |
| `this.availableEddies(p?)` | Count of untapped eddies + legends |
| `this.tappedCount(p?)` | Number of pre-committed resources |
| `this.readyUnitsOnField(p?)` | Array of ready UnitRefs |
| `this.spentUnitsOnField(p?)` | Array of spent UnitRefs |
| `this.unitPower(unitRef)` | Effective power (base + gear) |
| `this.readyResource(p?)` | First untapped eddie or legend, or null |

All helpers default to your own state. Pass `this.opponentState()` to inspect the opponent.

---

## Engine Questions & Answers

The engine asks your bot questions via `wf.step`. Each step has a specific response shape. Below is every question the engine can ask and how to answer it.

---

### `choose_gig_die`

Pick which fixer die to roll at the start of your turn.

**`wf` shape:**
```js
{ step: 'choose_gig_die', owner, available: [4, 6, 8, 10, 12, 20] }
```

**Response:**
```js
{ step: 'choose_gig_die', sides: 6 }
```
`sides` must be one of `wf.available`.

---

### `play_phase`

Your main phase. Called repeatedly until you end the phase. One action per call.

**`wf` shape:**
```js
{ step: 'play_phase', owner }
```

**Actions:**

```js
{ step: 'sell_card', iid }
// Sell a card from hand (card.eddie must be true). Once per turn.
// Creates a ready eddie you can tap immediately.

{ step: 'tap_resource', iid }
// Pre-commit an eddie or legend. Both face-up and face-down legends count as 1.

{ step: 'untap_resource', iid }
// Undo a tap (before spending).

{ step: 'call_legend', iid }
// Flip a face-down legend face-up. Costs 2 tapped resources. Once per turn.

{ step: 'play_card', iid }
{ step: 'play_card', iid, equip_to: '<host iid>' }
// Play a card from hand. Costs card.cost in tapped resources.
// Gear requires equip_to (a ready unit or face-up legend iid).

{ step: 'end_phase' }
// Done playing. Advances to attack phase.
```

---

### `declare_attack`

Declare attacks with your ready units, one at a time.

**`wf` shape:**
```js
{ step: 'declare_attack', owner, attackable: ['iid1', 'iid2'] }
```

**Actions:**

```js
{ step: 'declare_attack', attacker_iid, target: { kind: 'player', id: '<opponent pid>' } }
// Direct attack — steal 1 gig (+1 per 10 power above 0).

{ step: 'declare_attack', attacker_iid, target: { kind: 'unit', iid: '<spent unit iid>' } }
// Fight a spent enemy unit. Higher power wins; tie = both defeated.

{ step: 'end_attacks' }
// Done attacking. Passes turn to opponent.
```

Units with `HASTE_VS_SPENT` that entered this turn can only target spent units, not the player.

---

### `defensive_step`

Respond to an incoming attack. You get this when `wf.owner === this.pid` during an opponent's attack.

**`wf` shape:**
```js
{ step: 'defensive_step', owner, attacker_iid, can_call_legend: true, blocker_iids: ['iid1'] }
```

**Actions:**

```js
{ step: 'pass_defensive' }
// Let the attack resolve.

{ step: 'blocker', iid }
// Redirect attack to a BLOCKER unit. iid must be in wf.blocker_iids.

{ step: 'call_legend_defensive', iid }
// Flip a face-down legend during defense. Costs 2 eddies (direct spend, no tap).
// Only when wf.can_call_legend === true. Once per turn.
// Must follow up with pass_defensive or blocker.
```

---

### `choose_gig_to_steal`

Pick which gigs to steal after a successful direct attack.

**`wf` shape:**
```js
{ step: 'choose_gig_to_steal', owner, available_iids: ['iid1', 'iid2'], count: 1 }
```

**Response:**
```js
{ step: 'choose_gig_to_steal', iids: ['iid1'] }
```
Must provide exactly `count` iids, all from `available_iids`.

---

### `effect_choice`

A card effect needs your input. The response shape depends on `wf.choice_needed.kind`.

**`wf` shape:**
```js
{ step: 'effect_choice', owner, choice_needed: { kind, ... } }
```

**All response variants:**

#### `confirm_optional`
Accept or decline an optional effect.
```js
// wf.choice_needed: { kind: 'confirm_optional', prompt, pending_body: [...] }
{ step: 'effect_choice_response', response: { accept: true } }   // execute
{ step: 'effect_choice_response', response: { accept: false } }  // skip
```

#### `choose_amount`
Pick a number within a range.
```js
// wf.choice_needed: { kind: 'choose_amount', prompt, min, max, exclude_zero }
{ step: 'effect_choice_response', response: { amount: 2 } }
```

#### `choose_unit`
Pick a unit on the field.
```js
// wf.choice_needed: { kind: 'choose_unit', prompt, available_iids: [...], optional }
{ step: 'effect_choice_response', response: { iid: '<unit iid>' } }
```

#### `choose_legend`
Pick a legend.
```js
// wf.choice_needed: { kind: 'choose_legend', prompt, available_iids: [...], optional }
{ step: 'effect_choice_response', response: { iid: '<legend iid>' } }
```

#### `choose_gear`
Pick an equipped gear.
```js
// wf.choice_needed: { kind: 'choose_gear', prompt, available_iids: [...], optional }
{ step: 'effect_choice_response', response: { iid: '<gear iid>' } }
```

#### `choose_gig`
Pick a gig die.
```js
// wf.choice_needed: { kind: 'choose_gig', prompt, available_iids: [...], optional }
{ step: 'effect_choice_response', response: { iid: '<gig iid>' } }
```

#### `choose_card_in_hand`
Pick a card from hand.
```js
// wf.choice_needed: { kind: 'choose_card_in_hand', prompt, available_iids: [...], optional }
{ step: 'effect_choice_response', response: { iid: '<card iid>' } }
```

#### `choose_card_in_trash`
Pick a card from trash.
```js
// wf.choice_needed: { kind: 'choose_card_in_trash', prompt, available_iids: [...], optional }
{ step: 'effect_choice_response', response: { iid: '<card iid>' } }
```

#### `choose_card_in_deck`
Pick a card from deck (revealed by a search effect).
```js
// wf.choice_needed: { kind: 'choose_card_in_deck', prompt, available_iids: [...], optional }
{ step: 'effect_choice_response', response: { iid: '<card iid>' } }
```

#### `choose_from_top_n`
Pick cards from a revealed set (e.g. SearchTopN).
```js
// wf.choice_needed: { kind: 'choose_from_top_n', prompt,
//   available_refs: [CardRef, ...], eligible_iids: [...], take_up_to: 2, trash_remainder }
{ step: 'effect_choice_response', response: { selected_iids: ['iid1', 'iid2'] } }
```
`selected_iids` must be a subset of `eligible_iids`, length <= `take_up_to`.

---

## State Reference

### PlayerState (`this.myState()`)

```
zones.hand      [ { iid, card_id } ]
zones.field     [ { iid, card_id, state, equipped_gear, entered_play_turn } ]
zones.legends   [ { iid, card_id, state, face, equipped_gear } ]
zones.eddies    [ { iid, card_id, state } ]
zones.gigs      [ { iid, sides, value } ]
zones.fixer     [ { iid, sides, value: 0 } ]
zones.deck      [ { iid, card_id } ]
zones.trash     [ { iid, card_id } ]

tapped                              [ iid, ... ]
sold_card_this_turn                 bool
called_legend_this_turn             bool
called_legend_defensive_this_turn   bool
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
board.active_player     'p1' | 'p2'
board.overtime          bool
board.winner            null | 'p1' | 'p2'
```

---

## Keywords

| Keyword | Effect |
|---------|--------|
| `GO_SOLO` | Can attack the turn it enters play |
| `BLOCKER` | Can redirect attacks during defensive_step |
| `CANNOT_ATTACK` | Cannot declare attacks |
| `UNBLOCKABLE` | Attack bypasses blockers |
| `HASTE_VS_SPENT` | Can attack spent units on entry turn only |

---

## Win Conditions

- Start your turn with **6+ gig dice** = you win
- **Overtime** (no gigs claimed last full round): first to **7** wins
- **Opponent's deck empties** = you win

Street Cred = sum of gig die values. Gigs stolen per direct attack = `1 + floor(power / 10)`.

---

## Tips

- **Eddies are not auto-deducted.** Tap resources first, then play the card.
- `tapped[]` is cleared at the start of your next turn — unused taps are wasted.
- `sell_card` adds a ready eddie immediately — you can tap it the same turn.
- Face-down legends each count as 1 eddie when tapped.
- A unit's `iid` is stable for its whole lifetime on the field.
- If your blocker gets rejected (HTTP 400), immediately send `pass_defensive`.
- Returning `null` from `selectAction` triggers a safe fallback (end_phase / end_attacks / pass_defensive).

---

## Error Handling

| HTTP | Meaning | What to do |
|------|---------|------------|
| 400 | Invalid action | Log it, re-read state, try something else |
| 404 | Room not found | Room was evicted — start a new game |
| 429 | Rate limited | Slow down |

The server never changes state on a rejected action — safe to retry.

---

## Raw HTTP API (for non-JS bots)

```
POST /api/rooms               { name, deckKey }            -> { roomId, token, pid }
POST /api/rooms/:id/join      { name, deckKey }            -> { token, pid }
GET  /api/rooms/:id/state                                  -> snapshot
GET  /api/rooms/:id/events    SSE stream, event: state
POST /api/rooms/:id/mulligan  { token, keep: bool }        -> snapshot
POST /api/rooms/:id/step      { token, input: <action> }   -> snapshot
```

Listen for `event: state` on the SSE stream. When `waitingFor.owner === yourPid`, POST your action to `/step`.
