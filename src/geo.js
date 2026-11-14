import axios from 'axios';

const GEO_API = 'http://ip-api.com/batch';
const FIELDS = 'status,countryCode,timezone';
const cache = new Map();
let selfGeo = null;

export async function lookup(hosts) {
  const pending = [...new Set(hosts)].filter(h => h && !cache.has(h));
  for (let i = 0; i < pending.length; i += 100) {
    const chunk = pending.slice(i, i + 100);
    try {
      const { data } = await axios.post(`${GEO_API}?fields=${FIELDS}`, chunk.map(query => ({ query })), { timeout: 10000 });
      if (Array.isArray(data)) {
        data.forEach((row, j) => cache.set(chunk[j], row?.status === 'success' ? row : null));
      }
    } catch {
      chunk.forEach(h => cache.set(h, null));
    }
  }
}

export function cached(host) {
  return host ? cache.get(host) || null : null;
}

export async function self() {
  if (selfGeo !== null) return selfGeo;
  try {
    const { data } = await axios.get(`http://ip-api.com/json/?fields=${FIELDS}`, { timeout: 10000 });
    selfGeo = data?.status === 'success' ? data : null;
  } catch {
    selfGeo = null;
  }
  return selfGeo;
}
