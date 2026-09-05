![PunkSim](punksim-banner.png)

Note: This repo is a push from PUNKSIM/engine folder. There is no GIT history. PR's will not work, please raise an issue instead.

# PUNKSIM Bot SDK

PUNKSIM is an unofficial simulation of the Cyberpunk Trading Card Game. This SDK lets you write bots that play against humans, against each other, or in batched arena tournaments.

Game is live at https://punksim.net

Companion engine (rules stepper): [cyber-sim-engine](https://github.com/orzdk/cyber-sim-engine)

## Bot Development Kit

Rules engine and card data for the Cyberpunk TCG simulator (PUNKSIM). Pure
JavaScript, no runtime dependencies.

## Table of Contents

1. [Quickstart: Bot Battles in 60 Seconds](#quickstart-bot-battles-in-60-seconds)
2. [What's in the Box](#whats-in-the-box)
3. [Your First Bot](#your-first-bot)
4. [Your First Upgrade](#your-first-upgrade)
5. [The Four Methods](#the-four-methods)
6. [Bot Helpers](#bot-helpers)
7. [Engine Questions & Answers](#engine-questions--answers)
8. [State Reference](#state-reference)
9. [Keywords](#keywords)
10. [Win Conditions](#win-conditions)
11. [CLI Flags](#cli-flags)
12. [Tips & Gotchas](#tips--gotchas)
13. [Error Handling](#error-handling)
14. [Raw HTTP API](#raw-http-api)

---

## Quickstart: Bot Battles in 60 Seconds

The repo ships with prebuilt batch scripts in `bsdk/bat/` covering three matchups:

| Script | Matchup | Needs |
|---|---|---|
| `start-cli-vs-human.bat` | Your CLI bot hosts a PVB room; a human joins from the web client | nothing else running |
| `start-cli-vs-server-bot.bat` | Your CLI bot vs. a server-hosted bot | nothing else running |
| `start-cli-vs-cli-A.bat` + `start-cli-vs-cli-B.bat` | Two CLI bots — yours and a friend's | a shared key, agreed out-of-band |

These run with `--human` pacing (~500 ms between actions) so a spectator can follow. Each has a `-fast` twin (`start-cli-vs-server-bot-fast.bat`, `start-cli-vs-cli-A-fast.bat`, `start-cli-vs-cli-B-fast.bat`) that drops the delay for full-speed runs.

### Prerequisites

```bash
git clone https://github.com/orzdk/cyber-sim-sdk
cd cyber-sim-sdk
```

Node.js 18+. **No `npm install`** — the SDK has zero dependencies.

Pick a server to play on:

- **Production**: `https://punksim.net`
- **Staging**: `https://cyber-sim-staging.fly.dev` — (not always running)

### Mode A — CLI vs. Human (PVB host)

The bot hosts a PVB room. The room appears in the public lobby; a human joins from the web client.

```bat
cd bsdk\bat
start-cli-vs-human.bat
```

To pick the deck or point at staging:

```bat
start-cli-vs-human.bat https://punksim.net RRG_Arasaka_Onslaught
```

Arguments: `[serverUrl] [yourDeck]`. Both optional.

### Mode B — CLI vs. a Server Bot

You bring a deck. The server brings the opponent.

```bat
cd bsdk\bat
start-cli-vs-server-bot.bat
```

To pick the decks, the opponent bot, or point at staging:

```bat
start-cli-vs-server-bot.bat https://punksim.net RRG_Arasaka_Onslaught punkbot-simple-plus BBY_Voodoo_Programs
```

Arguments: `[serverUrl] [yourDeck] [opponentBotId] [opponentDeck]`. All optional.

### Mode C — CLI vs. CLI (You + a Friend)

Pick a shared key of at least 6 characters and communicate it to your peer out-of-band. Both sides run the bats with the same key as the third argument:

```bat
:: You
cd bsdk\bat
start-cli-vs-cli-A.bat https://punksim.net RRG_Arasaka_Onslaught pizza-night-2026
```

```bat
:: Your friend
cd bsdk\bat
start-cli-vs-cli-B.bat https://punksim.net BBY_Voodoo_Programs pizza-night-2026
```

Arguments: `[serverUrl] [yourDeck] [sharedKey]`. The server hashes the key and uses the hash as a rendezvous identifier. The plaintext key is not stored; the list of pending pairs is not exposed; non-matching keys are rejected.

First one to run waits up to 5 minutes for the second to show up; if nobody arrives, the pending room is reaped. Run them in either order.

### Pick a deck

Decks available at: `curl https://punksim.net/api/decks`.

### What just happened

1. The CLI requested a room from the server, sending the deck and (where relevant) the opponent or shared key.
2. The server routed the request to a capable host machine internally — Mode A and B onto a PVB or BVB host respectively, Mode C onto a BVB host chosen deterministically from the shared key so peers converge.
3. The server created the room with the CLI's seat pre-assigned and returned a seat token. For Mode A the opposing seat stays open; for Mode B the server spawns the opponent bot into it; for Mode C the second CLI fills it.
4. The CLI connected to its seat and play began.
5. The match runs to completion, is recorded, and appears under Replays.

Same room mechanics, engine path, and replay capture as a match commissioned from the web client.

### Customizing the bot

The bats run `server-ai-mybot-v2.js` — the one with feasibility pre-checks. Edit it, save, re-run the bat. No build step. See [Your First Upgrade](#your-first-upgrade) for what to change first.

### Run a bot headlessly (no server)

The companion repo [`cyber-sim-engine`](https://github.com/orzdk/cyber-sim-engine) is the Core Rule stepper Its `runtime/play.js` driver runs a full game between two bots in-process. 
`selectAction(wf, board)` works unchanged; the other methods (`chooseDeck`, `pickPlayOrder`, `decideMulligan`) are ignored because the driver supplies decks and play order directly.

Clone both repos side-by-side and the driver finds this SDK's `server-ai-mybot-min.js` by default. Useful for fast self-play loops without spinning up a server.

---

## What's in the Box

| File | What it is |
|---|---|
| `server-ai.js` | Base class. **Do not edit unless you have a reason why.** |
| `server-ai-mybot.js` | Working example bot — copy this and modify. |
| `server-ai-mybot-min.js` | Minimal scaffold — passes everything through. |
| `server-ai-mybot-v2.js` | More advanced example with feasibility pre-checks. The Quickstart bats run this one. |
| `server-ai-mybot-v3.js` | The strongest shipped example — script-driven heuristics on top of v2's pre-checks. Registered server-side as `punkbot-pro-light`. |
| `launcher.js` | Infrastructure used by the maintainers — not part of the bot-author API. You don't need this to write bots. |
| `bat/` | Prebuilt batch scripts for the [Quickstart](#quickstart-bot-battles-in-60-seconds) bot-battle modes, each in a `--human`-paced and a `-fast` variant. |
| `ref/d_script_ref.txt` | Flattened dump of every card's effect script — dot-path notation, one line per field. Reference for [Your First Upgrade](#your-first-upgrade). |
| `ref/d_card_texts.txt` | One line per card: `id \| name \| rules_text`, sorted by id. Lookup format for card rules text. |
| `ref/d_cards.json` | Verbatim copy of the server's card database. Same shape as `this.db` at runtime — convenience grep target while writing bots. Bots load this data via `/api/cards` at runtime, not from this file. |
| `ref/d_engine_primitives.json` | Machine-readable manifest of every primitive the engine accepts in scripts — actions, triggers, conditions, target shapes, choice kinds, enums. Reference for bots that walk `this.scripts` to write feasibility guards. |

---

## Your First Bot

The shortest possible bot:

```js
const { CyberpunkBot } = require('./server-ai.js');

class MyBot extends CyberpunkBot {
  chooseDeck()       { return 'RRG_Arasaka_Onslaught'; }
  pickPlayOrder()    { return 'first'; }
  decideMulligan()   { return true; }
  selectAction(wf, board) {
    return null;
  }
}

new MyBot({ name: 'Skeleton' }).play();
```

This bot will end every phase immediately, attack with nothing, and lose every game, but it plays to completion without errors. From here you implement `selectAction`.

---

## Your First Upgrade

Before editing anything, you need three things: the bot file's shape, what the server sends, and the rule that drives card-specific decisions. 

### Anatomy of `server-ai-mybot.js`


```
class MyBot extends CyberpunkBot {
  constructor(opts)                    // pass-through to super; lets --name override
  chooseDeck()                         // returns a deck key
  pickPlayOrder(gameData)              // 'first' | 'second' when you win the coin toss
  decideMulligan(board)                // true = keep opening hand, false = redraw
  selectAction(wf, board)              // the brain: one call = one engine question
}
```

The first four methods total about 15 lines. The fifth — `selectAction` — is a dispatch table on `wf.step`:

```
selectAction(wf, board) {
  if (wf.step === 'choose_gig_die')         { ... }
  if (wf.step === 'main_phase')             { ... }   // play, sell, call, attack, or end turn
  if (wf.step === 'choose_gig_to_steal')    { ... }
  if (wf.step === 'effect_choice')          { ... }
  if (wf.step === 'defensive_step')         { ... }
  return null;   // safe fallback
}
```

Each branch reads what's being asked, decides what to do, and returns an action object. 
Return `null` and the base class picks a safe default (`end_turn`, `pass_defensive`, etc.). The structure of a bot is one switch on the engine's question.

### What the server sends you each call

`selectAction` receives two arguments:

- **`wf`** (waitingFor) — the question. Always has `step` and `owner`; additional fields depend on the step (`available`, `attackable`, `interrupt_castable_iids`, `choice_needed`, etc.). The full catalog is in [Engine Questions & Answers](#engine-questions--answers).
- **`board`** — the full game state, masked to your seat. `board[this.pid]` is you, `board[this.opponentPid()]` is the rival. Both have the same zone names — `zones` (hand, field, legends, eddies, gigs, fixer, deck, trash), per-turn flags (`sold_card_this_turn`, etc.), and `tapped[]` — but hidden information is stripped: you see the rival's hand and both decks as `{ iid }`-only refs, and face-down legends have `card_id: null`. Plus `turn_number`, `active_player`, `phase`, `winner`. See [State Reference](#state-reference) for the schema.

To inspect during development:

```js
this.log(JSON.stringify({ wf, mine: this.myState(), opp: this.opponentState() }, null, 2));
```

### The mental model

The engine drives execution. Each call is one prompt and one answer. There is no concept of a "turn" from the bot's perspective — only prompts, typically dozens per turn. The bot handles each prompt and the engine resumes until the next one.

So the question for any card-specific improvement isn't *"should I play this card now?"* in the abstract. It's *"is there a precondition for this card's effect that the current board doesn't satisfy?"* If the answer is yes, skip the card.

### The fix: Afterparty at Lizzie's

The example bot plays cards greedily. One easy improvement: stop wasting **Afterparty at Lizzie's** (card `WNTC-065`) when there are no gigs in play.

Rules text:
> *Adjust a Gig by up to 1. If you control 2 or more Gigs with different values, draw 1.*

Open `ref/d_script_ref.txt`, find `card_id: "WNTC-065"`. The onPlay sequence:

```
onPlay[0].action: "SelectTarget"   ← a Gig, side: "both", optional: true
onPlay[1].action: "ChooseAmount"   ← 0 or 1
onPlay[2].action: "AdjustGig"      ← applies the amount to the chosen gig
onPlay[3].action: "If"             ← DistinctGigValueCount(self) >= 2 → Draw 1
```

Key engine fact: **an empty target pool never halts the game.** When `SelectTarget` finds no candidates it resolves to nothing — `optional` or not — and every downstream action that consumes the binding silently no-ops. So playing Afterparty with zero gigs on the table doesn't error out; it just burns the cost doing nothing: no gig to adjust, and `DistinctGigValueCount >= 2` can't hold when you have none. We mirror that precondition in the bot.

### Where in the loop

In `selectAction`, find the `main_phase` block. The loop iterates your hand and tries each card:

```js
for (const ref of p.zones.hand) {
  const card = this.card(ref.card_id);
  if (!card || card.type === 'Legend') continue;
  // ...check cost, tap resources, then play_card...
}
```

The guard goes **at the top of the loop, before any tapping**. Once you've tapped a resource for a card you can't follow through with, you've muddied the state — `untap_resource` exists but the decision logic gets tangled. Skip earlier instead.

### The code

Right after `const card = this.card(ref.card_id);`, add:

```js
// Mirror the card's own preconditions: if its first effect targets a
// Gig and there's no gig in the pool it draws from, the whole play is
// a no-op — cost paid, nothing happens. Reading the script (not
// hardcoded card names) covers any gig-targeter with no changes here.
const script = this.scripts?.[ref.card_id];
const firstTarget = script?.onPlay
  ?.find(eff => eff.action === 'SelectTarget')?.target;
if (firstTarget?.type === 'Gig') {
  const myGigs  = this.myState()?.zones?.gigs?.length || 0;
  const oppGigs = this.opponentState()?.zones?.gigs?.length || 0;
  const pool = firstTarget.side === 'opponent' ? oppGigs
             : firstTarget.side === 'self'     ? myGigs
             : myGigs + oppGigs;               // side: "both"
  if (pool === 0) continue;
}
```

Line by line:

- `this.scripts?.[ref.card_id]` — the engine's script for this card. Optional-chained because some cards have no script (pure stat units).
- `script?.onPlay?.find(eff => eff.action === 'SelectTarget')?.target` — finds the **first** `SelectTarget` in the onPlay sequence. That's the precondition gate: later effects consume the binding it produces, so an empty pool here defuses the whole chain.
- `firstTarget.side` decides which pool has to be non-empty — `'self'`, `'opponent'`, or `'both'` (Afterparty is `'both'`).
- `continue` — skip this card. No tap is performed, no resource is spent, the loop moves to the next hand card.

Run a bot-vs-bot match (the [Quickstart](#quickstart-bot-battles-in-60-seconds) bats are the easy way) and watch the log. `Playing Afterparty at Lizzie's` should stop appearing on turns before anyone has rolled a gig die.

### How to extend

For each card with a fizzle condition:

1. Read the rules text.
2. Open `ref/d_script_ref.txt` and find the script.
3. Identify the first precondition that, if unmet, makes the card waste its cost.
4. Add a `continue` guard at the top of the play loop that checks the same condition against current state.

Common precondition shapes worth guarding:

- `SelectTarget` for a `Unit`/`Gear`/`Legend`/`Gig` with an empty eligible pool — the dependent chain no-ops.
- `Draw` when your deck is empty.
- `RecoverFromTrash` when your trash is empty.
- `If` gates (the `cond` field in the script) whose condition is statically determinable — like Afterparty's `DistinctGigValueCount`.

The base class ships [`canPlayCard()`](#bot-helpers) which generalizes this further by simulating every onPlay effect against current state. `server-ai-mybot-v2.js` uses it.

The pattern: read the script, mirror its preconditions, skip when they don't hold.

---

## The Four Methods

### `chooseDeck()`

Return a deck key. Call `GET /api/decks` to enumerate the server-hosted decks at runtime, or hardcode one you know exists.

```js
chooseDeck() { return 'RRG_Arasaka_Onslaught'; }
```

Override is optional if you pass `--deck <key>` on the command line.

### `pickPlayOrder(gameData)`

Called when you win the coin toss. Return `'first'` or `'second'`.

```js
pickPlayOrder(gameData) { return 'first'; }
```

### `decideMulligan(board)`

Keep your opening hand or redraw once. `true` = keep, `false` = redraw.

```js
decideMulligan(board) {
  const cheap = board[this.pid].zones.hand.filter(r => (this.card(r.card_id)?.cost ?? 99) <= 2);
  return cheap.length >= 2;
}
```

### `selectAction(wf, board, rejected)`

Called every time the engine needs your input. `wf` is the `waitingFor` object describing what's being asked. `board` is the full board state. Return an action object, or `null` to trigger a safe fallback.

```js
selectAction(wf, board) {
  if (wf.step === 'main_phase') return { step: 'end_turn' };
  return null;
}
```

The third argument, `rejected`, is a `Set` of action signatures the server has already rejected at the *current* decision point. Simple bots can ignore it. Smarter bots use it to avoid re-proposing a move that just bounced: the base class re-calls `selectAction` after each rejection (bounded), falls back to a guaranteed-legal terminal ladder when the strategy repeats itself, and clears the set as soon as an action is accepted.

The full catalog of `wf.step` values and the response shapes lives in [Engine Questions & Answers](#engine-questions--answers).

---

## Bot Helpers

### Card data

The base class fetches the server's full card database and effect-script database once at bot startup (via `GET /api/cards` and `GET /api/scripts`, in parallel) and exposes them as two synchronously-available maps:

| Field | Shape | Contents |
|---|---|---|
| `this.db` | `{ [cardId]: cardDef }` | Card definitions — `name`, `type`, `cost`, `power`, `keywords`, `rules_text`, etc. Full schema in [State Reference](#state-reference). |
| `this.scripts` | `{ [cardId]: scriptObj }` | Effect scripts — `onPlay`, `onCall`, `onDefeated`, `abilities`, `statics`. Used for feasibility checks. See [Your First Upgrade](#your-first-upgrade). |

Both are populated before `chooseDeck()` is called, so every method on the bot can read them synchronously without awaiting. Lookups are by card id (the `.number` field on a card def, also the key of the script entry).

Access patterns:

```js
const def    = this.card(ref.card_id);
const def2   = this.db[ref.card_id];
const name   = this.cardName(ref.card_id);
const script = this.scripts?.[ref.card_id];
```

Cards with no scripted effects (pure stat units) won't have an entry in `this.scripts` — always optional-chain the lookup.

The bsdk folder ships static copies of the same data at `ref/d_cards.json` and `ref/d_script_ref.txt` for grep/inspection while writing bots. The runtime bot does **not** load from those files — they're for the author, not the bot.

### Helpers

These are available on `this` inside any of the Four Methods:

| Helper | Returns |
|---|---|
| `this.myState()` | Your `PlayerState` |
| `this.opponentState()` | Opponent's `PlayerState` |
| `this.opponentPid()` | `'p1'` or `'p2'` |
| `this.card(cardId)` | Card definition from `this.db` (null-safe) |
| `this.cardName(cardId)` | Display-name string |
| `this.hasKeyword(refOrId, kw)` | Boolean keyword check (case-insensitive) |
| `this.availableEddies(p?)` | Untapped eddies + face-up legends |
| `this.tappedCount(p?)` | Number of pre-committed resources |
| `this.readyUnitsOnField(p?)` | Array of ready unit refs |
| `this.spentUnitsOnField(p?)` | Array of spent unit refs |
| `this.unitPower(unitRef)` | Effective power (base + gear bonuses) |
| `this.readyResource(p?)` | First untappable eddie or face-up legend, or `null` |
| `this.canPlayCard(ref, board)` | `false` if every onPlay effect would no-op |

All `(p?)` helpers default to your own state; pass `this.opponentState()` to inspect the rival.

---

## Engine Questions & Answers

The engine asks via `wf.step`. Each step has a specific response shape.

### `choose_gig_die`

Pick which fixer die to roll at the start of your turn.

```js
// wf
{ step: 'choose_gig_die', owner, available: [4, 6, 8, 10, 12, 20] }

// response
{ step: 'choose_gig_die', sides: 6 }
```

`sides` must be one of `wf.available`. The list prefers non-d20 dice; d20 only appears once everything else has been spent.

### `main_phase`

Your main phase. Plays and attacks interleave freely — you can play a card,
attack, play another card, attack again, in any order. Called repeatedly until
you end the turn. **One action per call.**

```js
// wf
{ step: 'main_phase', owner,
  spend_activatable_iids: [{ iid, card_id, ability_idx, prompt }],
  attackable: [iid1, iid2, ...],    // units that can attack (empty before turn 3)
  attack_targets: { [iid]: { gigs: bool, unit_iids: [iid, ...] } },  // per-attacker legal targets
  must_attack_iids: [iid, ...] }    // compelled units — end_turn is rejected while one can attack
```

`attack_targets` tells you, per attackable unit, whether the Gig area is a legal
target and which enemy units are (keywords like `HASTE_VS_SPENT` / `HASTE_VS_GIGS`
restrict entry-turn attackers to one or the other). `must_attack_iids` only lists
compelled units that actually have a legal target.

Response actions:

```js
{ step: 'tap_resource',   iid }                  // pre-commit an eddie or face-up legend
{ step: 'untap_resource', iid }                  // undo a tap
{ step: 'sell_card',      iid }                  // hand → trash, +1 ready eddie. Once per turn.
{ step: 'call_legend',    iid }                  // flip face-down legend face-up. Costs 1 tapped. Once per turn.
{ step: 'play_legend_solo', iid }                // play a ready face-up legend as a unit (Go Solo legends)
{ step: 'play_card',      iid }                  // play a unit/program from hand
{ step: 'play_card',      iid, equip_to: hostIid } // play gear, equipped to a host
{ step: 'activate_anytime_spend', iid, ability_idx } // trigger a "spend" ability
{ step: 'declare_attack', attacker_iid, target: { kind: 'gigs' } }            // attack the Gig area (steal)
{ step: 'declare_attack', attacker_iid, target: { kind: 'unit', iid: spentIid } } // attack a spent enemy unit
{ step: 'effect_choice_response', response: {…}} // answer a halted effect prompt
{ step: 'end_turn' }                             // done — end your turn
```

Cost in tapped resources must be paid *before* the play. Each tap is one action — typical sequence to play a 2-cost: `tap`, `tap`, then `play_card`.

`declare_attack` is only available from turn 3 on, and only for an `iid` in
`wf.attackable` with the chosen target in `wf.attack_targets[iid]`. After each
attack resolves the engine returns to `main_phase`. Attacking the Gig area
(`kind: 'gigs'`) steals `1 + floor(power / 10)` gigs — zero-power attackers
steal nothing, card effects can modify the count, and it's capped by how many
gigs the rival actually has. Combat (`kind: 'unit'`) is only legal against
*spent* enemy units; higher power wins, ties defeat both.

### `attacker_interrupt_step`

Right after you `declare_attack`, you may get a window to activate a spend
ability before the defender responds. Quick cards react to a *rival* attack
only, so there is no casting here — the attacker's window exists solely for
spend abilities, and the engine **skips this step entirely** when you have
none available.

```js
// wf
{
  step: 'attacker_interrupt_step', owner,
  attacker_iid,
  target,                                        // the declared attack target
  interrupt_spendable_iids: [{ iid, card_id, ability_idx, kind, host_iid?, prompt }]
}
```

Response actions:

```js
{ step: 'pass_attacker_interrupt' }
{ step: 'activate_asset_spend',     iid, ability_idx }
```

### `defensive_step`

Respond to an incoming attack as the defender.

```js
// wf
{
  step: 'defensive_step', owner,
  attacker_iid,
  target,          // the declared target; target.unblockable is evaluated live
  can_call_legend: bool,
  blocker_iids:    [iid, ...],
  interrupt_castable_iids:  [iid, ...],
  interrupt_spendable_iids: [{ iid, card_id, ability_idx, kind, host_iid?, prompt }]
}
```

Response actions:

```js
{ step: 'pass_defensive' }
{ step: 'blocker', iid }
{ step: 'call_legend_defensive', iid }
{ step: 'play_card_interrupt_cast', iid }   // quick Program from hand, paid at normal cost
{ step: 'activate_asset_spend',     iid, ability_idx }
```

After `call_legend_defensive` you must follow with `pass_defensive` or `blocker` — the legend doesn't end the window.

### `choose_gig_to_steal`

Pick which gigs to steal after a successful direct attack.

```js
// wf
{ step: 'choose_gig_to_steal', owner, available_iids: [iid, ...], count: 2 }

// response
{ step: 'choose_gig_to_steal', iids: [iid1, iid2] }
```

Must provide exactly `count` iids, all from `available_iids`.

### `effect_choice`

A card effect needs your input. Response shape depends on `wf.choice_needed.kind`.

```js
// wf
{ step: 'effect_choice', owner, choice_needed: { kind, ... } }
```

#### `confirm_optional`

Accept or decline an optional effect.

```js
// choice_needed: { kind: 'confirm_optional', prompt, bind_pid, pending_body,
//                  otherwise_body, optional: true, source_card_id, source_pid }
{ step: 'effect_choice_response', response: { accept: true } }   // queue pending_body
{ step: 'effect_choice_response', response: { accept: false } }  // decline
```

Two things to know:

- **You can be asked about the rival's card.** Scripts can set `chooser: 'opponent'`,
  which makes `bind_pid` (the answering player) the source card's rival — e.g.
  WNTC-099 *Fool on the Hill* asks *you* whether to discard so the opponent draws.
  Don't assume a `confirm_optional` is about your own card; check `source_pid`.
- **Declining isn't always free.** When `otherwise_body` is non-null, saying no
  queues that alternative effect instead of nothing. The rest of the effect
  still resolves either way.

#### `choose_amount`

Pick a number within a range.

```js
// choice_needed: { kind: 'choose_amount', prompt, min, max, exclude_zero, bind_to }
{ step: 'effect_choice_response', response: { amount: 2 } }
```

#### `choose_card_type`

Name a card type from the offered list (e.g. Misty Olszewski). Mandatory —
there is no decline; an `{ iid: null }` response is rejected.

```js
// choice_needed: { kind: 'choose_card_type', prompt, options: ['Unit','Gear','Program'], bind_to }
{ step: 'effect_choice_response', response: { card_type: 'Unit' } }   // must be one of options
```

#### `choose_unit` / `choose_legend` / `choose_gear` / `choose_gig` / `choose_card_in_hand` / `choose_card_in_trash` / `choose_card_in_hand_or_trash` / `choose_card_in_deck` / `choose_in_play`

All share the same shape — pick one iid from `available_iids`. (`choose_in_play`
spans field units AND face-up legends, e.g. gear equip destinations;
`choose_card_in_hand_or_trash` spans both of those zones.)

```js
// choice_needed: { kind, prompt, available_iids, optional, bind_pid, chooser_pid, source_card_id, source_pid }
{ step: 'effect_choice_response', response: { iid: chosenIid } }       // pick — must be in available_iids
{ step: 'effect_choice_response', response: { iid: null } }            // decline — only when optional
```

An `iid` outside `available_iids` is rejected (HTTP 400); the board is unchanged.

`bind_pid` is the player whose zone is being chosen *from* (e.g. opponent's hand for a discard). `chooser_pid` is who actually answers — usually the source card's controller, but they can differ (e.g. an effect that has the opponent pick from your gigs).

#### `choose_from_top_n`

Pick cards from a revealed set (e.g. SearchTopN).

```js
// choice_needed: {
//   kind: 'choose_from_top_n', prompt,
//   available_refs: [{ iid, card_id, ... }],    // everything revealed
//   eligible_iids:  [iid, ...],                  // subset that matches the filter
//   take_up_to:     number,
//   take_min?:      number,                      // mandatory minimum (e.g. ScryTrash "trash 1")
//   trash_remainder?: bool,                      // false → unpicked go to bottom of deck
//   scry_trash?:    bool                         // selected → trash, unpicked back on TOP
// }
{ step: 'effect_choice_response', response: { selected_iids: [iid1, iid2] } }
```

`selected_iids` must be a subset of `eligible_iids`, `take_min ≤ length ≤ take_up_to`
(`take_min` defaults to 0 — but when set, an empty selection is rejected).

#### `choose_units`

Multi-pick over field units (effects with `quantifier: 'upto_n'`).

```js
// choice_needed: { kind: 'choose_units', prompt, available_iids, take_up_to, optional, bind_pid, chooser_pid }
{ step: 'effect_choice_response', response: { selected_iids: [iid1, iid2] } }
```

#### `acknowledge_reveal`

Cards revealed to you (e.g. from the top of a deck) pause for an acknowledgement.
There is nothing to decide — send any `effect_choice_response` and the engine
moves on. The revealed cards are in `choice_needed.revealed_refs`.

```js
// choice_needed: { kind: 'acknowledge_reveal', prompt, bind_pid, revealed_refs: [{ iid, card_id }] }
{ step: 'effect_choice_response', response: {} }
```

---

## State Reference

### PlayerState (`this.myState()`)

Snapshots are masked per seat — hidden information is stripped before it
reaches your bot. Your own state:

```
zones.hand      [ { iid, card_id, effective_cost? } ]   // effective_cost folds in active discounts
zones.field     [ { iid, card_id, state, equipped_gear, entered_play_turn } ]
zones.legends   [ { iid, card_id, state, face, equipped_gear } ]   // card_id null while face-down (until peeked)
zones.eddies    [ { iid, state } ]
zones.gigs      [ { iid, sides, value } ]      // rolled dice (street cred)
zones.fixer     [ { iid, sides, value: 0 } ]   // unrolled dice
zones.deck      [ { iid } ]                    // order/content hidden — length is what you get
zones.trash     [ { iid, card_id } ]

tapped                              [ iid, ... ]
sold_card_this_turn                 bool
called_legend_this_turn             bool
called_legend_defensive_this_turn   bool
took_gig_this_turn                  bool
```

The rival's state (`this.opponentState()`) differs where information is hidden:
`zones.hand` is `[ { iid } ]` (count only), and their face-down legends also
have `card_id: null`. Everything else matches.

`state` is `'ready' | 'spent'`; `face` (legends only) is `'face_up' | 'face_down'`.

### Card definition (`this.card(cardId)`)

```
.number      card ID string, e.g. "WNTC-005a" (also the script key)
.name        display name
.subname     variant subtitle or null
.type        'Legend' | 'Unit' | 'Program' | 'Gear'
.subtype     comma-separated; e.g. "Quickhack" or "Solo, Nomad"
.cost        int or null
.power       base combat power (units/legends)
.ram         RAM cost for programs
.eddie       true if the card can be sold for 1 eddie
.keywords    comma-separated keyword string or null (see Keywords below)
.rules_text  full card text
.color       'Red' | 'Yellow' | 'Green' | 'Blue'
.set         set name; .url / .image / .illustrated_by round out the print info
```

### Board (`board` in selectAction)

```
board.turn_number       1, 2, 3, ...
board.active_player     'p1' | 'p2'
board.phase             current phase name
board.overtime          bool
board.winner            null | 'p1' | 'p2'
board.p1, board.p2      PlayerState (use this.myState() / this.opponentState() instead)
```

The coin toss lives on the snapshot *next to* the board, not on it:
`this.gameData.coinToss` is `{ winner, choice } | null`.

---

## Keywords

There are two distinct things called "keywords" in card data:

**Trigger words** — appear in `card.keywords` to mark *when* a card's effects fire: `Play`, `Attack`, `Call`, `Flip`, `Defeated`. These are bookkeeping for the engine; bots don't need to act on them directly.

**Ability keywords** — alter combat / play behavior. These are the ones a bot's strategy actually depends on:

| Keyword | Effect |
|---|---|
| `GO_SOLO` | Legend can be played as a ready unit by paying its cost. A solo-played legend is **removed from the game** (with its gear) when it leaves the field — it never reaches trash, hand, or deck |
| `ADRENALINE` | Can attack the turn it enters play |
| `BLOCKER` | Can redirect attacks during the defender's `defensive_step` |
| `CANNOT_ATTACK` | Cannot declare attacks |
| `UNBLOCKABLE` | Attack bypasses blockers (no `blocker_iids` offered — applies to gig AND unit attacks, evaluated live) |
| `HASTE_VS_SPENT` | Can attack on its entry turn, but only against spent units |
| `HASTE_VS_GIGS` | Can attack on its entry turn, but only the Gig area |

Use `this.hasKeyword(unitRef, 'BLOCKER')` to check. The check is case-insensitive and walks the `keywords` string.

---

## Win Conditions

- **Seven gigs** — start your own turn with 7+ gigs in `zones.gigs` and you win immediately.
- **Deck-out** — you lose the moment you have to *draw* from an empty deck, including mid-effect. Running your deck to 0 by milling or searching is safe until your next draw (usually your next Start Phase).
- **Overtime** — if both players complete a turn without taking a new gig from their fixer, the game enters `board.overtime`. From that point, the first player holding a *strict majority of all gigs in play* wins (checked after each steal and at turn starts).

Street cred (sum of `value` across your `zones.gigs`) is informational — it's used by some card effects but does not itself win games.

---

## CLI Flags

The example bots accept these flags:

| Flag | Default | Description |
|---|---|---|
| `--server <url>` | `http://localhost:3000` | Game server URL |
| `--name <s>` | `MyBot` (script-dependent) | Display name shown in the lobby |
| `--deck <key>` | `chooseDeck()` | Override the deck — must be a known server deck key |
| `--deck-file <path>` | — | Load a deck definition from a JSON file (mirrors the browser's "local deck" flow) |
| `--human` | off | Add ~500 ms delay between actions, for spectator pacing |
| `--machine <id>` | — | Pin to a specific Fly machine via `?m=<id>` query parameter |
| `--user-id <s>` | — | Identity tag (used by the lobby's per-user room cap) |
| `--correlation-id <s>` | — | Tag the room for the human commissioner's lobby UI to match |
| `--creator-token <s>` | — | Secret returned to the commissioner — grants delete rights to the human |
| `--requester <s>` | — | Display name of the human who commissioned this bot |
| `--seat-room <id>` | — | Seat-mode: connect to an existing room instead of hosting |
| `--seat-token <s>` | — | Seat-mode: pre-issued seat token |
| `--seat-pid <p1\|p2>` | — | Seat-mode: which seat to take |
| `--model <s>` | — | Bot model identifier — appears as a chip in the lobby tile |

CLI-mode flags (in `server-ai-mybot-v2.js`; these run a preflight against
`/api/cli/host` or `/api/cli/match`, which hands back a pre-assigned seat —
they're what the [Quickstart](#quickstart-bot-battles-in-60-seconds) bats use):

| Flag | Description |
|---|---|
| `--vs-human` | Host a PVB room and wait for a human (Mode A) |
| `--bot-vs <botId>` | Match against a server bot (Mode B) — requires `--opp-deck` |
| `--opp-deck <key>` | The server bot's deck for `--bot-vs` |
| `--clivscli` | Pair with another CLI via a shared key (Mode C) — requires `--key` |
| `--key <s>` | Shared rendezvous key for `--clivscli` (min 6 chars) |

Seat-mode flags are populated automatically by the server when it spawns bots for a bot-vs-bot or arena run, or by the CLI-mode preflight. Manual usage is rare.

---

## Tips & Gotchas

- **Eddies are not auto-deducted.** Tap resources first, then play the card. Each tap is its own `main_phase` action.
- **`sell_card` adds a ready eddie immediately.** You can tap it the same turn.
- **A unit's `iid` is stable for its full life on the field.** Use it as a key for tracking attackers, blockers, etc.
- **Returning `null` from `selectAction`** triggers a safe fallback (`end_turn` / `pass_defensive`). Useful while you're filling in branches.
- **If a `blocker` action gets rejected (HTTP 400)** — your chosen blocker is no longer eligible. Send `pass_defensive` immediately rather than retrying.
- **Cards halt mid-resolution.** A play of `Cyberpsychosis` can pay its cost, then hit an `effect_choice` that has no valid target, then fizzle without refund. Pre-check with `canPlayCard()` or your own logic.
- **Silent room loss triggers a re-warm; explicit eviction doesn't.** If the SSE stream drops and reconnect finds the room gone (404), a *hosting* bot creates a new room with the same deck and carries on — seat-mode bots shut down instead (their seat was server-issued). An explicit `evicted` SSE event is a server order: the base class shuts down cleanly.

---

## Error Handling

| HTTP | Meaning | What to do |
|---|---|---|
| 400 | Invalid action — wrong shape, illegal target, not your turn | Log it, re-read state, try a different action. The base class remembers the rejected action and re-decides |
| 403 | Auth/mode/HMAC rejection | Fix the credential/mode — the base class logs and abandons; it does not auto-recover |
| 404 | Room not found | Room is gone. Hosting bots re-warm into a fresh room; seat-mode bots shut down |
| 409 | Per-user room cap reached | You already have too many active rooms |
| 429 | Rate limited | Slow down |
| 503 | Bot capacity full | Try again later |

The server never changes state on a rejected action — safe to retry once you've fixed the input.

---

## Raw HTTP API

For non-JS bots (Python, Rust, Go, …) the wire protocol is plain HTTP + JSON, with SSE for state push.

### Bot-essential endpoints

The minimum a bot needs:

```
POST /api/session                           {}                              -> { sessionId, secret, issued }
GET  /api/decks                                                             -> { deckKey: { name }, ... }
GET  /api/cards                                                             -> [ card definitions ]
GET  /api/scripts                                                           -> [ scriptObject, ... ]  (each carries card_id — key them yourself)

POST /api/rooms             { name, deckKey, deckDef?, isLocal?, botInfo,   -> { roomId, ownerToken }
                              botModel?, userId?, correlationId?, creatorToken? }
POST /api/rooms/:id/enter   { token: ownerToken }                           -> { roomId, token, pid }
POST /api/rooms/:id/join    { name, deckKey, session, creatorToken? }       -> { roomId, token, pid }

GET  /api/rooms/:id/state?token=<token>                                     -> player-masked snapshot
GET  /api/rooms/:id/events?token=<token>                                    -> SSE: state, log, alert, evicted,
                                                                                    rematch-suggested, ping (heartbeat)

POST /api/rooms/:id/mulligan { token, keep: bool }                          -> { ok }
POST /api/rooms/:id/pick_order { token, choice: 'first'|'second' }          -> { ok }
POST /api/rooms/:id/step    { token, input: <action> }                      -> { ok }
POST /api/rooms/:id/concede { token }                                       -> { ok }
```

These POST replies are bare acks (or `{ error }` on 4xx). Game state is **never**
returned in the reply — read it exclusively from the `state` SSE events (step 4
below). A 2xx means "accepted"; then wait for the next `state` push.


The flow:

1. `POST /api/session` to get an HMAC session.
2. `POST /api/rooms` (with `botInfo` set, `session` *not* required) to host, OR `POST /api/rooms/:id/join` (with `session` required) to join an existing room.
3. If hosting: `POST /api/rooms/:id/enter` with the `ownerToken` to claim p1.
4. Open `GET /api/rooms/:id/events?token=<token>` as an SSE stream.
5. When `state` events arrive with `waitingFor.owner === yourPid`, POST your action to `/step`.
6. Repeat until `state.winner !== null`.

### Full API reference

Grouped by responsibility. `tok = ownerToken or seat token; ses = HMAC session; cre = creatorToken (returned to whoever commissioned a bot room, scoped to that room); admin = admin token (X-Admin-Token header, obtained via POST /api/admin/auth with the operator's admin key)`.

#### Sessions
```
POST /api/session                                                          issue per-IP HMAC session
```

#### Rooms — lifecycle
```
GET  /api/rooms                                                            list all rooms
GET  /api/lobby/events                                                     SSE rooms list (live)
POST /api/rooms                          (ses for humans, none for bots)   create room
POST /api/rooms/:id/enter                (tok)                             owner claims p1
POST /api/rooms/:id/join                 (ses)                             second player claims p2
POST /api/rooms/by-code                  (ses)                             join a room by its short code
POST /api/matchmake                      (ses)                             quick match — seat into or open a room
GET  /api/rooms/:id/preview                                                pre-join room summary
POST /api/rooms/:id/leave                (tok)                             release a pre-game seat
POST /api/rooms/:id/reveal-pref          (tok)                             opt into reveal-at-end
DELETE /api/rooms/:id                    (tok or cre)                      delete room
```

#### CLI matchmaking (what the Quickstart bats' preflight calls)
```
POST /api/cli/host    { name, myDeckKey|myDeckDef }                        host a PVB room; returns { roomId, seatToken, seatPid }
POST /api/cli/match   { mode, name, human, myDeckKey|myDeckDef, ... }      cli-vs-server (oppBotId+oppDeckKey) or
                                                                           cli-vs-cli (key) — returns a seat, plus
                                                                           waiting:true when first to a shared key
```

#### Rooms — gameplay
```
POST /api/rooms/:id/pick_order           (tok)                             coin-toss winner picks order
POST /api/rooms/:id/mulligan             (tok)                             keep / redraw opening hand
POST /api/rooms/:id/step                 (tok)                             submit any in-game action
POST /api/rooms/:id/concede              (tok)                             forfeit
POST /api/rooms/:id/suggest-rematch      (tok)                             propose a rematch (SSE rematch-suggested to the rival)
GET  /api/rooms/:id/state                (tok)                             snapshot for reconnect
GET  /api/rooms/:id/events               (tok)                             SSE state stream
GET  /api/rooms/:id/spectate/state                                         spectator snapshot (sanitized)
GET  /api/rooms/:id/spectate/events                                        SSE spectator stream
GET  /api/rooms/:id/trace                                                  engine execution trace (debug)
```

#### Decks & cards
```
GET  /api/cards                                                            full card db
GET  /api/scripts                                                          card scripts (effects)
GET  /api/choice-types                                                     manifest of effect_choice kinds
GET  /api/decks                                                            list of server deck keys
GET  /api/decks/:name                                                      one deck's composition
POST /api/decks/save                     (CHAOS mode)                      upload a deck server-side
```

#### Identity
```
POST /api/identity                                                         mint beacon — client reports a freshly minted userId slug
```

#### Bots
```
GET  /api/bots                                                             list bot generations
POST /api/bots/spawn                     (PVB mode)                        commission a PvB room
POST /api/rooms/bvb                      (BVB mode)                        spawn a bot-vs-bot match
```

#### Snapshots & injection
```
POST /api/rooms/:id/snapshot             (PVP+PVB)                         capture mid-match state
GET  /api/snapshots/:id                                                    snapshot metadata
GET  /api/snapshots/:id/download                                           download the snapshot file
POST /api/snapshots/:id/inject           (PVB + snapshotToken)             spawn a bot match from snapshot
DELETE /api/snapshots/:id                (snapshotToken)                   delete snapshot
```

#### Replays

Playback is entirely client-side — the server just lists and serves recording
files. There are no replay sessions.

```
GET  /api/replays?limit=N                                                  list finished matches (winner known)
GET  /api/replays/:key/file                                                the recording (.jsonl) — play it back locally
DELETE /api/replays/:key                 (admin)                           delete a replay
```

#### Arena (CHAOS-only)
```
GET  /api/bvb/bots                                                         registered arena bots
GET  /api/bvb/decks                                                        arena deck list
GET  /api/bvb/arena                                                        list arena runs
GET  /api/bvb/arena/events                                                 SSE arena state
POST /api/bvb/arena                      (ses)                             create arena run
PUT  /api/bvb/arena/:id/config           (ses + owner)                     configure bot/deck lineup
POST /api/bvb/arena/:id/start            (ses + owner)                     launch
POST /api/bvb/arena/:id/cancel           (ses + owner)                     cancel
DELETE /api/bvb/arena/:id                (ses + owner or admin)            delete
GET  /api/bvb/arena/:id/view                                               results viewer (HTML)
GET  /api/bvb/arena/:id/data.js                                            results bundle (JS)
```

#### Leaderboard
```
GET  /api/leaderboard/top                                                  top players
GET  /api/leaderboard/player/:slug                                         one player's record
GET  /api/leaderboard/backup             (admin)                           export
POST /api/leaderboard/restore            (admin)                           import
```

#### Admin & observability
```
POST /api/admin/auth                                                       exchange the operator key for an admin token
GET  /api/admin/local-stats                                                machine stats
GET  /api/admin/stats                                                      cluster stats (fan-out)
GET  /api/admin/dashboard                                                  HTML dashboard
GET  /api/admin/broadcast                (admin)                           alert composer
POST /api/admin/alert                    (admin)                           cluster-wide alert
GET  /api/admin/mints                    (admin)                           recent identity mints
POST /api/admin/mints/clean              (admin)                           prune mint log
POST /api/admin/debug/spam-rooms         (admin)                           load-test injector
DELETE /api/admin/debug/spam-rooms       (admin)                           clean up spam
```

### Rate limits

Server enforces a set of rate limits. 

---

*This SDK is unofficial and not affiliated with the publisher of Cyberpunk: The Trading Card Game.*
