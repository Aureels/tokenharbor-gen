import axios from 'axios';

const TEMP_API = 'https://api.tempmail.ing';
const MT_API = 'https://api.mail.tm';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const MAIL_LIMIT = Number(process.env.MAIL_CONCURRENCY || 6);
let active = 0;
const waiting = [];

async function acquire() {
  if (active < MAIL_LIMIT) {
    active++;
    return;
  }
  await new Promise(resolve => waiting.push(resolve));
  active++;
}

function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

function tempIngPost(ua) {
  return axios.post(`${TEMP_API}/api/generate`, {}, {
    headers: { 'User-Agent': ua, 'Content-Type': 'application/json' },
    timeout: 15000
  }).then(res => {
    const address = res.data?.email?.address || res.data?.email;
    if (!address) throw new Error('empty response');
    return { email: address, token: null };
  });
}

async function mailTmCreate(log = () => {}) {
  const domains = await axios.get(`${MT_API}/domains`, { timeout: 20000 });
  const domain = domains.data?.['hydra:member']?.[0]?.domain;
  if (!domain) throw new Error('mail.tm: no domain');

  const local = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const address = `${local}@${domain}`;
  const password = `P${Math.random().toString(36).slice(2)}a9!`;

  await axios.post(`${MT_API}/accounts`, { address, password }, { timeout: 20000 });
  const token = await axios.post(`${MT_API}/token`, { address, password }, { timeout: 20000 });
  const jwt = token.data?.token;
  if (!jwt) throw new Error('mail.tm: no token');

  log(`mail: fallback to mail.tm (${domain})`);
  return { email: address, token: jwt };
}

export async function createMail(ua, log = () => {}, retries = 6) {
  await acquire();
  try {
    for (let i = 0; i < retries; i++) {
      try {
        return await tempIngPost(ua);
      } catch (e) {
        log(`tempmail: ${e.message} (attempt ${i + 1})`);
      }
      await sleep(1500 + i * 1500 + Math.random() * 1000);
    }

    return await mailTmCreate(log);
  } finally {
    release();
  }
}

async function tempIngInbox(email, ua, log) {
  try {
    const { data } = await axios.get(`${TEMP_API}/api/emails/${encodeURIComponent(email)}`, {
      headers: { 'User-Agent': ua },
      timeout: 15000
    });
    return data?.emails || [];
  } catch (e) {
    log(`inbox: ${e.message}`);
    return [];
  }
}

async function mailTmInbox(token, log) {
  try {
    const list = await axios.get(`${MT_API}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000
    });
    const messages = list.data?.['hydra:member'] || [];
    const out = [];

    for (const message of messages.slice(0, 5)) {
      try {
        const { data } = await axios.get(`${MT_API}/messages/${message.id}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 20000
        });
        const html = Array.isArray(data.html) ? data.html.join('\n') : (data.html || data.text || '');
        out.push({ content: html, subject: data.subject });
      } catch {}
    }

    return out;
  } catch (e) {
    log(`mail.tm inbox: ${e.message}`);
    return [];
  }
}

export async function fetchInbox(mail, ua, log = () => {}) {
  const mailbox = typeof mail === 'string' ? { email: mail } : mail;
  if (mailbox.token) return mailTmInbox(mailbox.token, log);
  return tempIngInbox(mailbox.email, ua, log);
}

export function extractCode(emails) {
  for (const m of emails) {
    const body = m.html || m.body || m.text || m.content || '';
    const code = body.match(/(\d{6})/);
    if (code) return code[1];
    const link = body.match(/tokenharbor\.ai\/verify\?code=([^"'\s]+)/);
    if (link) return link[1];
  }
  return null;
}

export function extractVerifyLink(emails) {
  for (const m of emails) {
    const body = m.html || m.body || m.text || m.content || '';
    const link = body.match(/https:\/\/tokenharbor\.ai\/verify-email\?token=[^"'\s<>]+/);
    if (link) return link[0];
  }
  return null;
}
