# AI Integration Specification

**Quick start for building a Cyber-Sim battlebot.**

## Overview

Your AI connects to the game server via HTTP and Server-Sent Events (SSE). The server tells you what to do, you send back your decisions, and the server executes them.

## Connection

1. **Create a room** (host AI only):
   ```
   POST /api/rooms
   Body: { name: "YourBot", deckKey: "merc" }
   Response: { roomId, token, pid }
   ```

2. **Join a room** (joining AI):
   ```
   POST /api/rooms/:roomId/join
   Body: { name: "YourBot", deckKey: "merc" }
   Response: { token, pid }
   ```

3. **Listen for state changes** (both AIs):
   ```
   GET /api/rooms/:roomId/events  (SSE stream)
   Emits: event: state, data: <snapshot>
   ```

4. **Poll current state** (fallback):
   ```
   GET /api/rooms/:roomId/state
   Response: <snapshot>
   ```

## Game States

Your AI will see one of these `status` values:

- **`waiting`** — Opponent hasn't joined yet. Poll until they do.
- **`mulligan`** — Both players decide: keep hand or redraw. Send mulligan decision.
- **`playing`** — Active game. Check `waitingFor` to see whose turn it is.
- **`finished`** — Game over. Check `result` for winner/loser/deck/turns.

## Your Turn

When `waitingFor.owner === yourPid`, it's your turn. The `waitingFor.step` tells you what to do:

| Step | What to send | Notes |
|------|--------------|-------|
| `play_phase` | `{ step: "play_card", iid, target? }` or `{ step: "end_phase" }` | Play cards from hand or end your turn |
| `declare_attack` | `{ step: "declare_attack", attacker_iid, target }` | Attack with a unit |
| `defensive_step` | `{ step: "blocker", iid }` or `{ step: "pass_defensive" }` | Block or pass |
| `choose_gig_to_steal` | `{ step: "choose_gig_to_steal", iid }` | Pick a gig to steal |
| `effect_choice` | `{ step: "effect_choice_response", response }` | Respond to a card effect |
| `mulligan` | `{ step: "mulligan", keep: true/false }` | Keep hand or redraw |

## Sending Actions

```
POST /api/rooms/:roomId/step
Body: { token, input: { step, ... } }
Response: <updated snapshot>
```

The response is the new game state. If your action is invalid, you'll get HTTP 400 with an error message.

## Listening for Opponent Moves

When it's **not** your turn, the SSE stream will send state updates. Your code should:

1. Listen for `event: state` messages
2. Parse the JSON data
3. Update your local game state
4. If `waitingFor.owner === yourPid`, call your action selector

## Mulligan

Both players must mulligan before the game starts:

```
POST /api/rooms/:roomId/mulligan
Body: { token, keep: true }
Response: <snapshot>
```

If you don't mulligan, you're stuck waiting. Always respond.

## Game End

When `status === 'finished'`, check the `result` object:

```json
{
  "winner": "p1",
  "winnerName": "YourBot",
  "winnerDeck": "merc",
  "loser": "p2",
  "loserName": "OpponentBot",
  "loserDeck": "merc",
  "turns": 12
}
```

## Error Handling

- **HTTP 400**: Your action was invalid. Log the error, re-read the state, and try again.
- **HTTP 404**: Room doesn't exist. Reconnect.
- **SSE disconnect**: Reconnect after 2 seconds. Use REST `/state` as fallback.

## Blocking & Defense

When defending:
- `blocker_iids` in `waitingFor` lists units that can block
- If you pick a blocker and it's rejected (HTTP 400), immediately send `pass_defensive`
- If you can't block, send `pass_defensive`

## Tips

- Always check `waitingFor` before sending an action
- If `waitingFor` is null, wait for SSE or poll `/state`
- Validate your action locally before sending (e.g., is the unit in the right zone?)
- Log all signals and responses for debugging
- Set a timeout (60s) per game; if stuck, exit and retry

---

**That's it.** Build your action selector, send decisions, listen for updates. Good luck!
