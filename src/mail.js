import axios from 'axios';

const API = 'https://api.tempmail.ing';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const MAIL_LIMIT = Number(process.env.MAIL_CONCURRENCY || 8);
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

export async function createMail(ua, log = () => {}, retries = 6) {
  await acquire();
  try {
    for (let i = 0; i < retries; i++) {
      try {
        const { data } = await axios.post(`${API}/api/generate`, {}, {
          headers: { 'User-Agent': ua, 'Content-Type': 'application/json' },
          timeout: 15000
        });
        const email = data?.email?.address || data?.email;
        if (email) return email;
        log(`tempmail: empty response (attempt ${i + 1})`);
      } catch (e) {
        log(`tempmail: ${e.message} (attempt ${i + 1})`);
      }
      await sleep(2000 + i * 2000 + Math.random() * 1000);
    }
    throw new Error('tempmail failed');
  } finally {
    release();
  }
}

export async function fetchInbox(email, ua, log = () => {}) {
  try {
    const { data } = await axios.get(`${API}/api/emails/${encodeURIComponent(email)}`, {
      headers: { 'User-Agent': ua },
      timeout: 15000
    });
    return data?.emails || [];
  } catch (e) {
    log(`inbox: ${e.message}`);
    return [];
  }
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
