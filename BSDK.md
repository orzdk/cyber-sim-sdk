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

# Engine Reference Notes

Flat reference for test authoring. No assumptions — every fact is read directly from source.

---

## 1. Entry Point

`step(board, input, db, scripts)` in `server/engine.js`

- Always deep-clones the incoming board before mutating.
- Returns `{ status: 'waiting', board, waitingFor }` or `{ status: 'ended', board, waitingFor: null }`.
- `db` = flat object `{ [card_id]: cardData }` from cards JSON.
- `scripts` = flat object `{ [card_id]: scriptData }` from card_scripts JSON.

---

## 2. Board Shape

Produced by `createBoard()` and `setupGame()`.

```
board = {
  p1: PlayerState,
  p2: PlayerState,
  turn_number: 0,
  active_player: 'p1' | 'p2',
  first_player:  'p1' | 'p2',
  phase: 'between_turns' | 'ready' | 'play' | 'attack',
  current_attack: null | AttackState,
  effect_stack:   [],
  scheduled_effects: [],
  rate_limits: { p1: {}, p2: {} },
  overtime: false,
  winner: null | 'p1' | 'p2',
  _next_iid: 1,
  _trace: [],
}
```

### PlayerState

```
{
  id: 'p1' | 'p2',
  zones: Zones,
  called_legend_this_turn: false,
  sold_card_this_turn: false,
  called_legend_defensive_this_turn: false,
  tapped: [],              // iids of resources tapped but not yet spent
  took_gig_this_turn: false,
}
```

### Zones

```
{
  hand:    [CardRef],
  deck:    [CardRef],
  trash:   [CardRef],
  removed: [CardRef],
  legends: [LegendRef],
  eddies:  [EddieRef],
  field:   [UnitRef],
  fixer:   [Fixer],        // 6 entries: d4,d6,d8,d10,d12,d20
  gigs:    [GigRef],
}
```

### Ref shapes

**CardRef** (hand / deck / trash / removed): `{ iid, card_id }`

**UnitRef** (field):
```
{ iid, card_id, state: 'ready'|'spent', equipped_gear: [GearRef],
  entered_play_turn: number,
  _temp_power?: number, _temp_keywords?: string[], _peeked?: true }
```

**LegendRef** (legends):
```
{ iid, card_id, state: 'ready'|'spent', face: 'face_up'|'face_down',
  equipped_gear: [GearRef] }
```

**GearRef** (inside `equipped_gear`): `{ iid, card_id }`

**EddieRef** (eddies, created when a card is sold): `{ iid, card_id, state: 'ready'|'spent' }`

**GigRef** (gigs / fixer):
```
{ iid, sides: 4|6|8|10|12|20, value: number, origin_pid: 'p1'|'p2' }
```
Fixer starts as `{ iid: '<pid>_d<sides>', sides, value: 0 }` without origin_pid.

---

## 3. setupGame Initial State

- Both decks shuffled; both hands deal 6 cards from top of deck.
- Legends shuffled, all start `face_down`, `state: 'ready'`.
- First player starts with `legends[0]` and `legends[1]` in `state: 'spent'`.
- `turn_number` = 0; phase = `'between_turns'`.
- `_next_iid` starts at 1 and increments for every new game object.

---

## 4. Phase Flow

```
between_turns
  └─ beginTurn()
       ├─ turn_number += 1
       ├─ win/deckout check
       ├─ draw card + readyAll (turn 2+ only)
       ├─ if fixer has non-d20 dice → phase='ready', waitingFor: choose_gig_die
       └─ else → phase='play', fires OnPlayPhaseStart, waitingFor: play_phase

ready
  └─ stepReady()
       ├─ input: choose_gig_die → rolls die, pushes to gigs, removes from fixer
       └─ → phase='play', fires OnPlayPhaseStart, waitingFor: play_phase

play
  └─ stepPlay()
       ├─ input: tap_resource | untap_resource | sell_card | call_legend | play_card
       │    all return waitingFor: play_phase
       ├─ input: end_phase | null
       │    → phase='attack', waitingFor: declare_attack
       └─ input: effect_choice_response → resume halted effect, back to play_phase

attack
  └─ stepAttack()
       ├─ input: declare_attack → declares, fires OnCardAttacks, waitingFor: defensive_step
       ├─ input: end_attacks | end_phase | null → endAttack() → next player's turn
       ├─ defensive_step: blocker | call_legend_defensive | pass_defensive
       ├─ choose_gig_to_steal → handleStealChoice
       └─ effect_choice_response → resume, dispatch by pending_resume
```

---

## 5. waitingFor Objects

All include `{ step, owner }`. `owner` is the pid that must act.

### `choose_gig_die`
```js
{ step: 'choose_gig_die', owner, available: [4|6|8|10|12|20, ...] }
```
Available = non-d20 fixer sides if any; falls back to [20] if only d20 remains.

### `play_phase`
```js
{ step: 'play_phase', owner }
```

### `declare_attack`
```js
{ step: 'declare_attack', owner, attackable: [iid, ...] }
```
`attackable` = iids of ready units that `canUnitAttack()`.

### `defensive_step`
```js
{ step: 'defensive_step', owner, attacker_iid,
  can_call_legend: bool, blocker_iids: [iid, ...] }
```
`blocker_iids` = ready units with BLOCKER keyword (empty if attacker is UNBLOCKABLE).

### `choose_gig_to_steal`
```js
{ step: 'choose_gig_to_steal', owner, available_iids: [iid, ...], count: n }
```

### `effect_choice`
```js
{ step: 'effect_choice', owner, choice_needed: ChoiceNeeded }
```

---

## 6. Input Shapes

### choose_gig_die
```js
{ step: 'choose_gig_die', sides: 4|6|8|10|12|20 }
```

### play_phase actions
```js
{ step: 'tap_resource',   iid }
{ step: 'untap_resource', iid }
{ step: 'sell_card',      iid }           // card must have card.eddie truthy
{ step: 'call_legend',    iid }           // costs 2 tapped resources
{ step: 'play_card',      iid, equip_to? }  // equip_to required for Gear type
{ step: 'end_phase' }
```

### declare_attack
```js
{ step: 'declare_attack', attacker_iid, target: { kind: 'player', id: pid } }
{ step: 'declare_attack', attacker_iid, target: { kind: 'unit',   iid: targetIid } }
{ step: 'end_attacks' }
```
Only spent units can be attacked as `kind: 'unit'`.
`HASTE_VS_SPENT` units entering that turn cannot target `kind: 'player'`.

### defensive_step
```js
{ step: 'blocker',              iid }   // iid must be in blocker_iids
{ step: 'call_legend_defensive', iid }  // costs 2 eddies (not tapped — direct spend)
{ step: 'pass_defensive' }
```

### choose_gig_to_steal
```js
{ step: 'choose_gig_to_steal', iids: [iid, ...] }
```
Must provide exactly `count` iids, all from `available_iids`.

### effect_choice_response
```js
{ step: 'effect_choice_response', response: Response }
```
Response shape depends on `choice_needed.kind` — see section 7.

---

## 7. effect_choice.choice_needed Variants

### `confirm_optional`
```js
{ kind: 'confirm_optional', bind_pid, prompt, pending_body: [...effects], optional: true }
// response:
{ accept: true }   // executes pending_body
{ accept: false }  // skips pending_body
```

### `choose_amount`
```js
{ kind: 'choose_amount', bind_pid, bind_to: bindingName, prompt, min, max, exclude_zero: bool }
// response:
{ amount: n }      // n must be in [min, max]; non-zero if exclude_zero
```

### `choose_unit`
```js
{ kind: 'choose_unit', bind_pid, bind_to, prompt, available_iids: [iid,...], optional: bool }
// response:
{ iid }            // must be in available_iids; null allowed if optional
```

### `choose_gig`
```js
{ kind: 'choose_gig', bind_pid, bind_to, prompt, available_iids: [iid,...], optional: bool }
// response: { iid }
```

### `choose_legend`
```js
{ kind: 'choose_legend', bind_pid, bind_to, prompt, available_iids: [iid,...], optional: bool }
// response: { iid }
```

### `choose_gear`
```js
{ kind: 'choose_gear', bind_pid, bind_to, prompt, available_iids: [iid,...], optional: bool }
// response: { iid }
```

### `choose_card_in_hand`
```js
{ kind: 'choose_card_in_hand', bind_pid, bind_to, prompt, available_iids: [...], optional: bool }
// response: { iid }
```

### `choose_card_in_trash`
```js
{ kind: 'choose_card_in_trash', bind_pid, bind_to, prompt, available_iids: [...], optional: bool }
// response: { iid }
```

### `choose_card_in_deck`
```js
{ kind: 'choose_card_in_deck', bind_pid, bind_to, prompt, available_iids: [...], optional: bool }
// response: { iid }
```

### `choose_from_top_n`
```js
{ kind: 'choose_from_top_n', bind_pid, prompt,
  available_refs: [CardRef,...],   // all cards revealed
  eligible_iids: [iid,...],        // which ones pass the filter
  take_up_to: n,
  trash_remainder: bool }
// response:
{ selected_iids: [iid,...] }       // must be subset of eligible_iids, length <= take_up_to
```

---

## 8. Events Fired by the Engine

| Event | When fired |
|-------|-----------|
| `OnPlayPhaseStart` | Start of every play phase |
| `OnPlay` | Card enters play (Unit, Program, Gear) |
| `OnCardPlayed` | After OnPlay for same card |
| `OnCall` | Legend flips face_up (main or defensive) |
| `OnFlip` | After OnCall for same legend |
| `OnCardAttacks` | Attacker declared |
| `OnDefeated` | Unit dies in combat |
| `OnWinFight` | Attacker wins fight (survives) |
| `OnStealGigs` | After gig steal completes |
| `OnGigValueChanged` | Gig value decreases and owner is opponent of actor |

### Event context fields
```js
{ source_pid, source_iid, source_card_id, event_data? }
```
`event_data.stolen_gigs` is set on OnStealGigs.

---

## 9. effect_stack Frame Types

```js
{ kind: 'resume_fire_event', halted_state }
{ kind: 'resume_effects',    halted_state }
```
Stack is LIFO. Top frame popped on `effect_choice_response`.

### pending_resume.kind values

Set when a halt occurs mid-multi-stage sequence:

| kind | Continuation |
|------|-------------|
| `'fight'` | `runFight()` — combat stages |
| `'steal_finish'` | `finishSteal()` — after OnStealGigs |
| `'defensive_chain'` | `runDefensiveChain()` — OnCall+OnFlip queue |
| `'endturn'` | `continueEndturn()` — end-of-turn scheduled defeats |

---

## 10. Win / End Conditions

- `board.winner !== null` + `status: 'ended'`
- Active player reaches ≥ 6 gigs → that player wins.
- `board.overtime === true`: player with > half total gigs wins; checked after each steal.
- Either player's deck is empty → opponent wins (checked at start of each turn).

---

## 11. Unit Attack Eligibility

`canUnitAttack(u, b, db, scripts)` returns true when:
- `u.state === 'ready'`
- Does NOT have `CANNOT_ATTACK` keyword
- If `u.entered_play_turn === b.turn_number` (summoning sickness), must have `GO_SOLO` or `HASTE_VS_SPENT`

`HASTE_VS_SPENT` units entering this turn can only attack spent units (not the player).

---

## 12. Street Cred

`streetCred(playerState)` = sum of `gig.value` across `zones.gigs`.

---

## 13. Available Eddies (for spending)

`availableEddies(p)` = count of `state: 'ready'` eddies + count of `state: 'ready'` legends.

Tap model: `tap_resource` moves an iid to `p.tapped`. `spendTapped(p, n)` moves n from tapped to spent. Called automatically on `play_card` (costs cost) and `call_legend` (costs 2). Legend defensive call uses `spendEddies()` (direct spend, no tap step).

---

## 14. Keywords

All stored and compared as uppercase strings.

| Keyword | Effect |
|---------|--------|
| `GO_SOLO` | Can attack turn it enters play |
| `BLOCKER` | Can be chosen as blocker during defensive_step |
| `CANNOT_ATTACK` | Cannot declare attacks |
| `UNBLOCKABLE` | Attack bypasses blockers (condition-gated) |
| `HASTE_VS_SPENT` | Can attack spent units on entry turn only |

Source: unit's `_temp_keywords` array + SelfKeyword statics without a condition.

---

## 15. card_scripts.json Structure

```js
{
  "card_id": "xxx",
  "statics":    [Static, ...],
  "onPlay":     [Effect, ...],
  "onCall":     [Effect, ...],
  "onFlip":     [Effect, ...],
  "onDefeated": [Effect, ...],
  "abilities":  [Ability, ...]
}
```

### Static kinds

| kind | Fields | Meaning |
|------|--------|---------|
| `SelfKeyword` | `keyword`, `condition?` | Grants keyword to self |
| `SelfPower` | `expr`, `when?` | Adds computed power to self |
| `Aura` | `affects`, `expr`, `when?` | Power bonus to matching friendly units |
| `AuraKeyword` | `affects`, `keyword` | Grants keyword to equipped host or other |
| `PowerMultiplier` | `factor`, `when?` | Multiplies total power |

### when clause fields
- `active_player: 'self'` — only on controller's turn
- `during_fight: true` — only during combat resolution
- `role: 'attacker' | 'defender'` — only in that fight role

### Ability (triggered)
```js
{
  "kind": "triggered",
  "trigger": {
    "event": EventName,
    "by": "any" | "self" | "controller" | "opponent" | "host",
    "card": CardFilter?,         // filter on source card
    "rate_limit": "first_per_turn"?,
    "rate_limit_scope": "iid"?
  },
  "effect": [Effect, ...]
}
```

---

## 16. Effect Actions

### Control flow
| Action | Key fields |
|--------|-----------|
| `Optional` | `body: [...]`, `prompt` |
| `ChooseAmount` | `min`, `max`, `exclude_zero`, `bind_to`, `chooser`, `prompt` |
| `If` | `cond`, `then: [...]`, `else?: [...]` |
| `Sequence` | `body: [...]` |

### Card flow
| Action | Key fields |
|--------|-----------|
| `Draw` | `n` |
| `Discard` | `n`, `target?` (if no target, random from hand) |
| `Mill` | `n`, `side?` |
| `RecoverFromTrash` | `target` |
| `SelectTarget` | `target` (only binds; no mutation) |
| `SearchTopN` | `n`, `take_up_to`, `filter?`, `trash_remainder?` |
| `RivalDiscards` | `n`, `filter?`, `bind?` |
| `RevealTopSift` | `n`, `cost_eq`, `take_dest?`, `residual_dest?` |

### Gig mutations
| Action | Key fields |
|--------|-----------|
| `IncreaseGig` | `target`, `amount` |
| `DecreaseGig` | `target`, `amount` |
| `AdjustGig` | `target`, `amount` (signed) |
| `SetGigValue` | `target`, `amount` |
| `TransferGig` | `target`, `to: 'controller'` |

### Field mutations
| Action | Key fields |
|--------|-----------|
| `Defeat` | `target` |
| `DefeatGear` | `target` |
| `ReturnToHand` | `target` |
| `BottomDeckFromField` | `target` |
| `RemoveFromGame` | `target` |

### State
| Action | Key fields |
|--------|-----------|
| `Spend` | `target` |
| `Ready` | `target` |
| `SpendSelf` | — |
| `ReadySelf` | — |

### Modifiers
| Action | Key fields |
|--------|-----------|
| `GrantTempPower` | `target`, `amount` |
| `GrantTempKeyword` | `target`, `keyword` |

### Equipment / scheduling / misc
| Action | Key fields |
|--------|-----------|
| `Equip` | `source` (gear), `dest` (host) |
| `ScheduleDefeat` | `target` (defeated at end of turn) |
| `MarkPeeked` | `target` (sets `_peeked: true` on legend) |
| `PlayFromZoneFree` | `target`, `to?` (plays card free from zone) |

---

## 17. Target Resolution

A `target` object in an effect is resolved in this order:

1. `from_self: true` — acting card's iid/pid
2. `from_binding: name` — previously bound in `ctx.bindings[name]`
3. `from_host: true` — host unit of this gear
4. `from_trigger_source: true` — card that fired the trigger
5. `from_event: field` — field from `event_data`
6. Otherwise: `selectTarget()` with `{ type, side, zone, filter, chooser, quantifier, bind, optional, face, color, auto }`

### selectTarget fields
| Field | Values / notes |
|-------|---------------|
| `type` | `'Unit'` `'Gear'` `'Legend'` `'Gig'` `'CardRef'` |
| `side` | `'friendly'` (default = self_pid) or `'opponent'` |
| `zone` | explicit zone; default from type |
| `filter` | MatchFilter object |
| `chooser` | `'auto'` (default) or `'controller'` or `'opponent'` |
| `quantifier` | `'one'` (default) `'all'` `'upto_n'` |
| `optional` | if true and empty pool, skip instead of halt |
| `face` | for Legend: `'face_up'` or `'face_down'` |
| `auto` | sort hint: `'first'` `'cheapest'` `'highest_value'` `'lowest_value'` `'highest_power'` `'lowest_power'` |
| `bind` | name to store result in `ctx.bindings` |

### choice_needed kind by type+zone

| type / zone | kind |
|-------------|------|
| Gig | `choose_gig` |
| Gear | `choose_gear` |
| Legend | `choose_legend` |
| CardRef, zone=hand | `choose_card_in_hand` |
| CardRef, zone=trash | `choose_card_in_trash` |
| CardRef, zone=deck | `choose_card_in_deck` |
| Unit | `choose_unit` |

---

## 18. MatchFilter Fields

Applied to card refs in zones. All fields are optional (AND semantics).

| Field | Type | Meaning |
|-------|------|---------|
| `color` | string | card.color (case-insensitive) |
| `type` | string | card.type exact match |
| `type_in` | string[] | card.type in list |
| `faction` | string | hasFaction(card, faction) |
| `subtype_has` | string | subtype string contains this value |
| `cost_lte` | number | card.cost <= value |
| `cost_eq` | number / expr | card.cost === value |
| `power_lte` | number | effective power <= value |
| `state` | `'ready'`/`'spent'` | unit state |
| `gear_count` | number | unit.equipped_gear.length === value |
| `value` | expr | gig.value (with op/sides) |
| `exclude_self` | true | excludes acting card iid |
| `any_of` | filter[] | OR of sub-filters |
| `face` | string | legend face |

---

## 19. evalExpr Operators

| op | Meaning |
|----|---------|
| `lit` | constant value |
| `add` / `sub` / `mul` | arithmetic over args array |
| `ref` | dotted path into `ctx.bindings` |
| `gig_value` | `ctx.bindings[ref].value` |
| `gig_sides` | `ctx.bindings[ref].sides` |
| `street_cred` | sum of gig values for side |
| `gig_count` | gigs zone length for side |
| `count` | count cards in zone matching filter |
| `gear_count` | equipped_gear length on ref or self |
| `legend_face_count` | count legends with given face for side |

---

## 20. evalCondition Operators

| cond | Meaning |
|------|---------|
| `True` / `False` | literals |
| `And` / `Or` / `Not` | boolean over args / arg |
| `Compare` | compare two exprs with op (`>` `>=` `<` `<=` `==` `!=`) |
| `StreetCred` | streetCred(side) op value |
| `GigAtMaxValue` | gig.value === gig.sides |
| `HasSidedPair` | two gigs in zone with same sides value |
| `HasInZone` | any card in zone matches filter |
| `HasInZoneN` | ≥ n cards in zone match filter |
| `SelfIsReady` / `SelfIsSpent` | acting card state |
| `SelfEquipsSource` | self (gear) is equipped on source unit |
| `HostEquipsSelf` | self has at least one gear equipped |
| `SourceIsSelf` | source_iid === self_iid |
| `SourceIsController` | source_pid === self_pid |
| `SourceIsOpponent` | source_pid !== self_pid |
| `BindingSet` | ctx.bindings[name] !== undefined |

---

## 21. Trigger `by` Values

| by | Meaning |
|----|---------|
| `any` | any source |
| `self` | source_iid === self_iid |
| `controller` | source_pid === self_pid |
| `opponent` | source_pid !== self_pid |
| `host` | source is unit that has self (gear) equipped |

---

## 22. Helpers Available on CyberpunkBot

`this.myState()` / `this.opponentState()` — player board states
`this.pid` / `this.opponentPid()` — player IDs
`this.card(cardId)` / `this.cardName(cardId)` — card data lookup
`this.availableEddies(p)` / `this.tappedCount(p)` — resource counts
`this.readyUnitsOnField()` / `this.spentUnitsOnField()` — filtered field
`this.unitPower(unitRef)` — effective power
`this.hasKeyword(cardIdOrRef, keyword)` — keyword check
`this.readyResource(p)` — first untapped eddie or legend

---

## 23. Card Scripts Index

Cards that have scripts (non-trivial behavior):

| card_id | Hooks / abilities |
|---------|------------------|
| 032 | onCall (Ready self); triggered OnCardAttacks by controller — Optional: Spend self, Equip gear to attacker, Ready attacker |
| 036 | onDefeated — RivalDiscards 1, If cost equals StreetCred → RivalDiscards 1 more |
| 042 | onPlay — GrantTempKeyword HASTE_VS_SPENT to self |
| 067 | triggered OnCardAttacks by self — If has max-value gig: Draw 2 |
| 069 | triggered OnGigValueChanged by opponent — Optional: RecoverFromTrash |
| 073 | onPlay + triggered OnCardAttacks by self — Optional: Discard Program → BottomDeckFromField opponent unit |
| 102 | onPlay — GrantTempPower (2×gear_count) to friendly unit, ScheduleDefeat it |
| 111 | triggered OnStealGigs by self (first_per_turn) — Optional: TransferGig matching sides from opponent |
| 116 | onPlay — SelectTarget opp gig, ChooseAmount ±2, AdjustGig, If self has same-value gig: Draw 1 |
| 119 | onPlay — GrantTempPower 4 to friendly unit, ScheduleDefeat it |  
| 121 | GO_SOLO; onDefeated — Optional: RemoveFromGame self → PlayFromZoneFree Program from trash |
| 122 | onCall — AdjustGig -3 to opp gig; triggered OnCardAttacks — Spend self, SearchTopN 3 take 1 Braindance |
| 125 | BLOCKER; onCall — Ready self; triggered OnCardAttacks by opponent — If HasSidedPair: GrantTempPower 1 + BLOCKER to friendly unit ≤4 cost |
| 126 | onPlay — SelectTarget friendly gig, SearchTopN 4 take 4 trash_remainder where cost=gig_value |
| 131 | GO_SOLO; SelfPower = 2×gear_count when active_player=self |
| 132a | GO_SOLO; onDefeated — Mill 3, RecoverFromTrash Braindance Program |
| 133 | onCall — Optional: DefeatGear friendly → Draw 4; else Draw 1 |
| 135 | onCall — Draw 1; triggered OnCardAttacks — Spend self, Equip hand Gear ≤2 cost to unequipped Yellow friendly unit |
| 137 | onPlay — Defeat all units (excluding self) |
| 019 | PowerMultiplier ×2 during_fight attacker |
| α001 | triggered OnCardAttacks by controller (first_per_turn) Arasaka — Draw 1, If StreetCred<20: Discard 1 from hand |
| α002 | triggered OnCardPlayed by controller (first_per_turn) Blue Unit/Gear — Optional: IncreaseGig 2, If at max: Draw 1 |
| α003 | GO_SOLO |
| α004 | GO_SOLO, BLOCKER |
| α005 | Aura +1 to friendly Arasaka units during_fight attacker |
| α006 | onFlip — SearchTopN 5 take 2 Gear ≤2 cost |
| α007 | onPlay — If StreetCred≥12: Defeat opp unit ≤5 power |
| α008 | triggered OnStealGigs by opponent — If self is spent: SetGigValue stolen_gigs to 1 |
| α009 | (no script) |
| α011 | triggered OnStealGigs by opponent — If self is spent: Draw 1 |
| α012 | UNBLOCKABLE conditional on StreetCred≥7 |
| α013 | SelfPower = 2×(count of friendly gigs) |
| α014 | BLOCKER, CANNOT_ATTACK |
| α015 | (no script) |
| α016 | BLOCKER, CANNOT_ATTACK |
| α017 | (no script) |
| α018 | SelfPower = legend_face_count(friendly, face_up) when active_player=self |
| α019 | (no script) |
| α020 | triggered OnWinFight by host — Draw 1 |
| α021 | onPlay — IncreaseGig 4 to friendly gig, If StreetCred≥7: Draw 1 |
| α022 | triggered OnCardAttacks by host — If StreetCred≥7: DefeatGear opp gear ≤2 cost |
| α023 | onPlay — ReturnToHand spent unit ≤4 cost |
| α024 | onPlay — GrantTempKeyword HASTE_VS_SPENT to host |
| α025 | onPlay — Spend opp unit ≤3 cost |
| α026 | triggered OnCardAttacks by host — MarkPeeked friendly face_down legend |
| α027 | AuraKeyword BLOCKER to equipped_host |
| α028 | onPlay — GrantTempPower 4 to friendly unit, ScheduleDefeat it |
| N001 | (no script) |
