const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const MAX_CAPACITY = 15;

// Map to hold running bot processes: roomId -> ChildProcess
const bots = new Map();

app.get('/api/status', (req, res) => {
  res.json({
    active: bots.size,
    capacity: MAX_CAPACITY,
    uptime: process.uptime()
  });
});

app.post('/api/spawn', (req, res) => {
  const { serverUrl, machineId, roomId, deckKey, botName } = req.body;

  if (!serverUrl || !roomId) {
    return res.status(400).json({ error: 'Missing required fields: serverUrl, roomId' });
  }

  if (bots.size >= MAX_CAPACITY) {
    return res.status(503).json({ error: 'at_capacity' });
  }

  if (bots.has(roomId)) {
     // Idempotent: if already running for this room, just return ok
     return res.status(200).json({ botPid: bots.get(roomId).pid, message: 'Already running' });
  }

  const args = [
    path.join(__dirname, 'server-ai-mybot.js'),
    '--join', roomId,
    '--server', serverUrl
  ];

  if (machineId) {
    args.push('--machine', machineId);
  }
  if (deckKey) {
    args.push('--deck', deckKey);
  }
  if (botName) {
    args.push('--name', botName);
  }

  // Spawn the bot process
  const child = spawn('node', args, {
    stdio: 'inherit' // Pipe stdout/stderr to the launcher's logs so we can see them in Fly
  });

  bots.set(roomId, child);
  console.log(`[LAUNCHER] Spawned bot for room ${roomId} (PID: ${child.pid}). Active bots: ${bots.size}`);

  // Enforce 30 minute maximum game duration
  const timeoutId = setTimeout(() => {
    if (bots.has(roomId)) {
      console.log(`[LAUNCHER] Bot for room ${roomId} exceeded maximum duration. Terminating.`);
      const b = bots.get(roomId);
      b.kill('SIGTERM');
      setTimeout(() => {
          if (!b.killed) b.kill('SIGKILL');
      }, 5000);
    }
  }, 30 * 60 * 1000);

  child.on('exit', (code, signal) => {
    console.log(`[LAUNCHER] Bot for room ${roomId} exited (PID: ${child.pid}, Code: ${code}, Signal: ${signal})`);
    bots.delete(roomId);
    clearTimeout(timeoutId);
  });

  child.on('error', (err) => {
    console.error(`[LAUNCHER] Failed to start bot for room ${roomId}:`, err);
    bots.delete(roomId);
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
