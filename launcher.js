const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const MAX_CAPACITY = 15;

const BOT_REGISTRY = require('./launcher.config.json');
const DEFAULT_BOT_ID = Object.keys(BOT_REGISTRY)[0];

// Map to hold running bot processes: roomId -> ChildProcess
const bots = new Map();

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
  const { serverUrl, machineId, roomId, deckKey, botName, botId, requesterName, correlationId, adminToken, seatRoom, seatToken, seatPid, human } = req.body;

  if (!serverUrl) {
    return res.status(400).json({ error: 'Missing required field: serverUrl' });
  }

  if (bots.size >= MAX_CAPACITY) {
    return res.status(503).json({ error: 'at_capacity' });
  }

  // For join-mode bots, deduplicate by roomId
  if (roomId && bots.has(roomId)) {
    return res.status(200).json({ botPid: bots.get(roomId).pid, message: 'Already running' });
  }

  // Bot tracking key. Seat-mode bots key on the injected room; join-mode on
  // the target room; host-mode gets a placeholder until they create theirs.
  const botKey = seatRoom || roomId || `host-${Date.now()}`;

  const resolvedBotId = BOT_REGISTRY[botId] ? botId : DEFAULT_BOT_ID;
  const botConfig     = BOT_REGISTRY[resolvedBotId];
  const args = [path.join(__dirname, botConfig.script), '--server', serverUrl];
  args.push('--model', resolvedBotId);   // for the bot to self-identify in lobby tiles

  if (seatToken && seatRoom && seatPid) {
    // Snapshot-injected seat — bot connects directly with a pre-issued token.
    args.push('--seat-room',  seatRoom);
    args.push('--seat-token', seatToken);
    args.push('--seat-pid',   seatPid);
    if (human) args.push('--human');
  } else if (roomId) {
    args.push('--join', roomId);                     // joiner mode
    if (human) args.push('--human');                 // BVB joiners need slow pacing too
  } else {
    args.push('--human');  // host mode — act at human speed so the player can react
    if (requesterName) args.push('--requester',       requesterName);
    if (correlationId) args.push('--correlation-id', correlationId);
    if (adminToken)    args.push('--admin-token',    adminToken);
  }

  if (machineId) args.push('--machine', machineId);
  if (deckKey)   args.push('--deck',    deckKey);
  if (botName)   args.push('--name',    botName);

  // Spawn the bot process
  const child = spawn('node', args, {
    stdio: 'inherit' // Pipe stdout/stderr to the launcher's logs so we can see them in Fly
  });

  bots.set(botKey, child);
  console.log(`[LAUNCHER] Spawned bot (key=${botKey}, PID: ${child.pid}, mode=${roomId ? 'join' : 'host'}). Active bots: ${bots.size}`);

  // Enforce 30 minute maximum game duration
  const timeoutId = setTimeout(() => {
    if (bots.has(botKey)) {
      console.log(`[LAUNCHER] Bot (key=${botKey}) exceeded maximum duration. Terminating.`);
      const b = bots.get(botKey);
      b.kill('SIGTERM');
      setTimeout(() => { if (!b.killed) b.kill('SIGKILL'); }, 5000);
    }
  }, 30 * 60 * 1000);

  child.on('exit', (code, signal) => {
    console.log(`[LAUNCHER] Bot (key=${botKey}) exited (PID: ${child.pid}, Code: ${code}, Signal: ${signal})`);
    bots.delete(botKey);
    clearTimeout(timeoutId);
  });

  child.on('error', (err) => {
    console.error(`[LAUNCHER] Failed to start bot (key=${botKey}):`, err);
    bots.delete(botKey);
    clearTimeout(timeoutId);
  });

  res.status(201).json({ botPid: child.pid });
});

app.delete('/api/spawn/:roomId', (req, res) => {
  const { roomId } = req.params;
  const child = bots.get(roomId);

  if (!child) {
    return res.status(204).send(); // Already gone
  }

  console.log(`[LAUNCHER] Received delete request for room ${roomId}. Terminating PID: ${child.pid}`);
  
  child.kill('SIGTERM');
  
  // Grace period before sending SIGKILL
  setTimeout(() => {
      if (bots.has(roomId)) {
          console.log(`[LAUNCHER] Escalating to SIGKILL for room ${roomId}`);
          const b = bots.get(roomId);
          if (b && !b.killed) {
              b.kill('SIGKILL');
          }
      }
  }, 5000);

  res.status(204).send();
});

app.listen(PORT, '::', () => {
  console.log(`[LAUNCHER] Bot launcher listening on port ${PORT}`);
  console.log(`[LAUNCHER] Max capacity: ${MAX_CAPACITY} concurrent bots`);
});
