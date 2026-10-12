const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const DEFAULT_STATE = {
  status: 'Money Sent',
  currency: 'USD',
  amount: 250.00,
  senderName: 'John Doe',
  senderCountry: 'United States',
  purpose: 'Family Support',
  requestId: 'REQ-8829104',
  method: 'Mobile Money',
  reference: 'SW-2849163',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

function readState() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_STATE, null, 2));
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function writeState(state) {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---- Real-time subscribers (SSE) ---- */
const clients = new Set();

function broadcast(state) {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

/* ---- Endpoints ---- */

// Get current state
app.get('/api/state', (req, res) => {
  res.json(readState());
});

// Subscribe to real-time updates
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(readState())}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Admin update — triggers instant broadcast
app.post('/api/state', (req, res) => {
  const current = readState();
  const updated = { ...current, ...req.body };
  if (req.body.amount != null) updated.amount = parseFloat(req.body.amount) || 0;
  writeState(updated);
  broadcast(updated);
  res.json({ ok: true, state: updated });
});

app.listen(PORT, () => console.log(`Running: http://localhost:${PORT}`));
