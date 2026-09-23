const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const MAX_CAPACITY = 15;

const BOT_REGISTRY = require('./launcher.config.json');
const DEFAULT_BOT_ID = Object.keys(BOT_REGISTRY)[0];

const bots   = new Map();
const byRoom = new Map();
let nextBotId = 0;

// ── Orphan reaping ─────────────────────────────────────────────────────────
// Bots are normally torn down by DELETE /api/spawn/:roomId from the game
// server's eviction sweep. A game host that CRASHES never sends that, and
// nothing else tells us — so seat bots would sit here forever holding capacity.
// We poll each seat bot's room instead: gone (404) reaps at once, unreachable
// reaps after a few consecutive misses so a deploy blip doesn't kill live games.
const REAP_INTERVAL_MS   = Number(process.env.REAP_INTERVAL_MS) || 60 * 1000;
const REAP_PROBE_TIMEOUT = 3000;
const REAP_MISS_LIMIT    = 3;
const MAX_BOT_LIFETIME_MS = 2 * 60 * 60 * 1000;   // backstop for anything we can't probe

async function probeRoom(entry) {
  const res = await fetch(`${entry.serverUrl}/api/rooms/${entry.roomId}/preview`, {
    signal: AbortSignal.timeout(REAP_PROBE_TIMEOUT),
  });
  return res.status;
}

async function reapSweep() {
  const now = Date.now();
  for (const [botId, entry] of [...bots.entries()]) {
    if (now - entry.spawnedAt > MAX_BOT_LIFETIME_MS) {
      terminateBot(botId, 'exceeded max lifetime');
      continue;
    }
    // Host bots re-warm into fresh rooms we never learn the id of, so the
    // lifetime cap above is all we can apply to them.
    if (entry.mode !== 'seat' || !entry.roomId || !entry.serverUrl) continue;

    try {
      const status = await probeRoom(entry);
      if (status === 404) { terminateBot(botId, 'room gone'); continue; }
      entry.misses = 0;
    } catch (err) {
      entry.misses = (entry.misses || 0) + 1;
      if (entry.misses >= REAP_MISS_LIMIT) {
        terminateBot(botId, `host unreachable x${entry.misses}`);
      }
    }
  }
}

setInterval(() => { reapSweep().catch(e => console.error('[LAUNCHER] reap sweep failed:', e.message)); },
  REAP_INTERVAL_MS).unref();

function trackBot(botId, entry) {
  bots.set(botId, entry);
  if (entry.roomId) {
    let set = byRoom.get(entry.roomId);
    if (!set) { set = new Set(); byRoom.set(entry.roomId, set); }
    set.add(botId);
  }
}

function untrackBot(botId) {
  const entry = bots.get(botId);
  if (!entry) return;
  bots.delete(botId);
  if (entry.roomId) {
    const set = byRoom.get(entry.roomId);
    if (set) { set.delete(botId); if (!set.size) byRoom.delete(entry.roomId); }
  }
}

function terminateBot(botId, label) {
  const entry = bots.get(botId);
  if (!entry || !entry.child) return;
  // Untracking happens on the child's 'exit' event, so a bot stays in the map
  // while it is dying — don't signal it twice from a later reap sweep.
  if (entry.terminating) return;
  entry.terminating = true;
  console.log(`[LAUNCHER] Terminating bot ${botId} (PID ${entry.pid}, ${label})`);
  entry.child.kill('SIGTERM');
  setTimeout(() => {
    const e = bots.get(botId);
    if (e && e.child) {
      console.log(`[LAUNCHER] Escalating to SIGKILL for bot ${botId} (${label})`);
      e.child.kill('SIGKILL');
    }
  }, 5000).unref();
}

app.get('/api/status', (req, res) => {
  res.json({
    active: bots.size,
    capacity: MAX_CAPACITY,
    uptime: process.uptime()
  });
});

app.get('/api/bots', (req, res) => {
  res.json(BOT_REGISTRY);
});

app.post('/api/spawn', (req, res) => {
  const { serverUrl, machineId, deckKey, botName, botId, requesterName, correlationId, creatorToken, userId, seatRoom, seatToken, seatPid, human } = req.body;

  if (!serverUrl) {
    return res.status(400).json({ error: 'Missing required field: serverUrl' });
  }

  if (bots.size >= MAX_CAPACITY) {
    return res.status(503).json({ error: 'at_capacity' });
  }

  const resolvedBotId = Object.hasOwn(BOT_REGISTRY, botId) ? botId : DEFAULT_BOT_ID;
  const botConfig     = BOT_REGISTRY[resolvedBotId];
  const args = [path.join(__dirname, botConfig.script), '--server', serverUrl];
  args.push('--model', resolvedBotId);

  if (seatToken && seatRoom && seatPid) {
    args.push('--seat-room',  seatRoom);
    args.push('--seat-token', seatToken);
    args.push('--seat-pid',   seatPid);
    if (human) args.push('--human');
  } else {
    if (human !== false) args.push('--human');
    if (requesterName) args.push('--requester',       requesterName);
    if (correlationId) args.push('--correlation-id', correlationId);
    if (creatorToken)  args.push('--creator-token',  creatorToken);
    if (userId)        args.push('--user-id',        userId);
  }

  if (machineId) args.push('--machine', machineId);
  if (deckKey)   args.push('--deck',    deckKey);
  if (botName)   args.push('--name',    botName);

  const child = spawn('node', args, {
    stdio: 'inherit'
  });

  if (!child.pid) {
    console.error('[LAUNCHER] Spawn failed: no PID returned');
    return res.status(500).json({ error: 'spawn_failed' });
  }

  const id     = ++nextBotId;
  const mode   = seatRoom ? 'seat' : 'host';
  const roomId = seatRoom || null;

  trackBot(id, { child, roomId, mode, pid: child.pid, serverUrl, spawnedAt: Date.now(), misses: 0 });
  console.log(`[LAUNCHER] Spawned bot ${id} (PID: ${child.pid}, mode=${mode}${roomId ? `, room=${roomId}` : ''}). Active bots: ${bots.size}`);

  child.on('exit', (code, signal) => {
    console.log(`[LAUNCHER] Bot ${id} exited (PID: ${child.pid}, Code: ${code}, Signal: ${signal})`);
    untrackBot(id);
  });

  child.on('error', (err) => {
    console.error(`[LAUNCHER] Failed to start bot ${id}:`, err);
    untrackBot(id);
  });

  res.status(201).json({ botPid: child.pid, botId: id });
});

app.delete('/api/spawn/:roomId', (req, res) => {
  const { roomId } = req.params;
  const ids = byRoom.get(roomId);

  if (!ids || !ids.size) {
    return res.status(204).send();
  }

  console.log(`[LAUNCHER] Delete request for room ${roomId} — terminating ${ids.size} bot(s)`);
  for (const botId of [...ids]) terminateBot(botId, `room ${roomId}`);

  res.status(204).send();
});

// ── Admin / operational control ────────────────────────────────────────────
app.get('/api/bots/active', (req, res) => {
  res.json([...bots.entries()].map(([id, e]) => ({
    id, pid: e.pid, mode: e.mode, roomId: e.roomId || null,
    ageMs: Date.now() - e.spawnedAt, misses: e.misses || 0,
    terminating: !!e.terminating,
  })));
});

app.delete('/api/bots/:id', (req, res) => {
  const botId = Number(req.params.id);
  if (!Number.isInteger(botId) || !bots.has(botId)) {
    return res.status(404).json({ error: 'no_such_bot' });
  }
  terminateBot(botId, `admin id ${botId}`);
  res.status(202).json({ ok: true });
});

app.listen(PORT, '::', () => {
  console.log(`[LAUNCHER] Bot launcher listening on port ${PORT}`);
  console.log(`[LAUNCHER] Max capacity: ${MAX_CAPACITY} concurrent bots`);
});

function shutdown(signal) {
  console.log(`[LAUNCHER] Received ${signal} — terminating ${bots.size} bot(s)`);
  for (const botId of [...bots.keys()]) terminateBot(botId, `shutdown ${signal}`);
  setTimeout(() => process.exit(0), 6000).unref();
  if (!bots.size) process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
