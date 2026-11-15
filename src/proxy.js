import axios from 'axios';
import fs from 'fs-extra';
import { SocksProxyAgent } from 'socks-proxy-agent';

const CHECK_URL = 'https://api.ipify.org';
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
          timeout: CHECK_TIMEOUT
        });

    const attempt = request
      .then(res => typeof res.data === 'string' && res.data.trim().length > 0)
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

export function pick(list) {
  if (!list.length) return null;
  const socks = list.filter(url => url.startsWith('socks'));
  const pool = socks.length && Math.random() < 0.6 ? socks : list;
  return pool[Math.floor(Math.random() * pool.length)];
}
