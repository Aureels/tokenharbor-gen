import axios from 'axios';
import fs from 'fs-extra';
import { SocksProxyAgent } from 'socks-proxy-agent';

const CHECK_URL = process.env.PROXY_CHECK_URL || 'https://tokenharbor.ai/v1/models';
const CHECK_TIMEOUT = Number(process.env.PROXY_TIMEOUT || 5000);
const CONCURRENCY = Number(process.env.PROXY_CONCURRENCY || 50);

const PATTERN = /^(socks[45]|https?):\/\/(?:([^:@]+):([^@]+)@)?([^:]+):(\d+)$/;

export async function loadProxies(file, log = () => {}) {
  try {
    if (!(await fs.pathExists(file))) return [];
    const text = await fs.readFile(file, 'utf-8');
    return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch (e) {
    log(`proxy: load failed: ${e.message}`);
    return [];
  }
}

export function hostOf(url) {
  const m = url.match(PATTERN);
  return m ? m[4] : null;
}

export function toPlaywrightProxy(url) {
  const m = url.match(PATTERN);
  if (!m) return null;
  const [, protocol, username, password, host, port] = m;
  return { server: `${protocol}://${host}:${port}`, ...(username ? { username, password } : {}) };
}

function check(url) {
  try {
    const match = url.match(PATTERN);
    if (!match) return Promise.resolve(false);

    const [, protocol, username, password, host, port] = match;
    const numericPort = parseInt(port);
    if (!(numericPort >= 1 && numericPort <= 65535)) return Promise.resolve(false);

    const isSocks = protocol.startsWith('socks');
    const auth = username ? `${username}:${password}@` : '';

    const request = isSocks
      ? (() => {
          const agent = new SocksProxyAgent(`${protocol}://${auth}${host}:${numericPort}`);
          return axios.get(CHECK_URL, { httpAgent: agent, httpsAgent: agent, timeout: CHECK_TIMEOUT });
        })()
      : axios.get(CHECK_URL, {
          proxy: { protocol, host, port: numericPort, ...(username ? { auth: { username, password } } : {}) },
          timeout: CHECK_TIMEOUT,
          validateStatus: () => true
        });

    const attempt = request
      .then(res => res.status > 0)
      .catch(() => false);

    const guard = new Promise(resolve => setTimeout(() => resolve(false), CHECK_TIMEOUT + 1500));

    return Promise.race([attempt, guard]);
  } catch {
    return Promise.resolve(false);
  }
}

export async function validateProxies(list, log = () => {}) {
  const alive = [];
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const chunk = list.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(check));
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value) alive.push(chunk[j]);
    });
    log(`proxy: checked ${Math.min(i + CONCURRENCY, list.length)}/${list.length}, alive ${alive.length}`);
  }
  return alive;
}

const STATE_FILE = '.cache/proxy-state.json';
const state = {};

try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')));
} catch {}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(STATE_FILE, JSON.stringify(state)).catch(() => {});
  }, 2000);
}

export function markSuccess(url) {
  if (!url) return;
  const entry = state[url] || { uses: 0 };
  entry.wins = (entry.wins || 0) + 1;
  entry.until = 0;
  entry.reason = 'ok';
  state[url] = entry;
  persist();
}

export function markProxy(url, minutes, reason) {
  if (!url) return;
  const entry = state[url] || { uses: 0 };
  entry.uses = (entry.uses || 0) + 1;
  entry.until = Date.now() + minutes * 60000;
  entry.reason = reason;
  state[url] = entry;
  persist();
}

export function pick(list) {
  if (!list.length) return null;

  const now = Date.now();
  const ready = list.filter(url => {
    const entry = state[url];
    return !entry || !entry.until || entry.until < now;
  });

  const pool = ready.length ? ready : list;
  const socks = pool.filter(url => url.startsWith('socks'));
  const candidates = socks.length && Math.random() < 0.7 ? socks : pool;

  const ranked = candidates
    .map(url => ({ url, uses: state[url]?.uses || 0, wins: state[url]?.wins || 0 }))
    .sort((a, b) => (b.wins - a.wins) || (a.uses - b.uses));

  const window = ranked.slice(0, Math.max(1, Math.ceil(ranked.length * 0.3)));
  const chosen = window[Math.floor(Math.random() * window.length)].url;

  const entry = state[chosen] || { uses: 0 };
  entry.uses = (entry.uses || 0) + 1;
  state[chosen] = entry;
  persist();

  return chosen;
}
