import axios from 'axios';
import fs from 'fs-extra';

const CHECK_URL = 'https://api.ipify.org';
const CHECK_TIMEOUT = 5000;
const CONCURRENCY = 25;

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

function toAxiosProxy(url) {
  const m = url.match(PATTERN);
  if (!m) return null;
  const [, protocol, username, password, host, port] = m;
  return { protocol, host, port: parseInt(port), ...(username ? { auth: { username, password } } : {}) };
}

function check(url) {
  const proxy = toAxiosProxy(url);
  if (!proxy) return Promise.resolve(false);

  const attempt = axios.get(CHECK_URL, { proxy, timeout: CHECK_TIMEOUT })
    .then(res => typeof res.data === 'string' && res.data.trim().length > 0)
    .catch(() => false);

  const guard = new Promise(resolve => setTimeout(() => resolve(false), CHECK_TIMEOUT + 1500));

  return Promise.race([attempt, guard]);
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

export function pick(list) {
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}
