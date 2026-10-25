#!/usr/bin/env node
/** Dependency-free Node 22 port of refresh_imd.py. See PORT.md for overrides/tests. */
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { keccak256, selector, namehash } from './keccak.mjs';

const FP = '0xff0c532fdb8cd566ae169c1cb157ff2bdc83e105';
const ETH = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7';
const RH = '0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127';
const START_SUPPLY = 10_000_000, BASE_GENESIS_TS = 1686789347, BASE_EID = 30184;
const BASE_LAUNCH = '2023-08-31';
const BURN_WALLETS = ['0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000001'];
const KNOWN_EXECUTORS = ['0x2ec59bed2fb9dee447bbec6e3bca249782c9b88b', '0xe29386719c155b6847ad5a4e97c6674f10ffc750'];
const DEFAULT_RPC = {
  base: ['https://base-mainnet.public.blastapi.io', 'https://mainnet.base.org', 'https://base.gateway.tenderly.co'],
  base_latest: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  eth: ['https://ethereum-rpc.publicnode.com'], rh: ['https://rpc.mainnet.chain.robinhood.com'],
};
const TRANSFER = '0x' + keccak256('Transfer(address,address,uint256)');
const ENS_REGISTRY = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const POOL_MANAGER = '0x000000000004444c5dc75cb358380d2e3de08a90';
const LAUNCHPAD_HOOK = '0x51768f5da32ba2008304cc81674da51acb802888';
const BURN_ACCRUED_SEL = '0x9cb568de';
export const DATA_FILES = [
  'imd-burns.json', 'imd-base-split.json', 'imd-supply.json', 'imd-executor-bridges.json',
  'imd-burn-breakdown.json', 'imd-burnkeepers.json', 'imd-executor-sources.json',
  'imd-burn-coins.json', 'imd-burn-history.json', 'summary.json',
];
const PYTHON_INTEGER_FIELDS = Symbol('Python integer fields');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pad = addr => addr.slice(2).toLowerCase().padStart(64, '0');
const balData = addr => '0x70a08231' + pad(addr);
const hex = n => '0x' + n.toString(16);
const iso = ts => new Date(ts * 1000).toISOString().replace('.000Z', 'Z');
const num = value => Number(BigInt(value)) / 1e18;
const sum = values => values.reduce((a, b) => a + b, 0);
const topic = signature => '0x' + keccak256(signature);
const query = values => new URLSearchParams(Object.entries(values).map(([k, v]) => [k, String(v)])).toString();

// Python round(x, n): round the exact binary64 value, ties to even. Multiplying
// x by 1e6 before Math.round would change values at half-way boundaries.
export function round(value, digits = 6) {
  if (!Number.isFinite(value)) throw new Error('non-finite numeric value');
  if (value === 0) return value;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 2047n);
  const mantissa = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const shift = (exponent || 1) - 1023 - 52;
  let numerator = mantissa * 10n ** BigInt(digits), denominator = 1n;
  if (shift >= 0) numerator <<= BigInt(shift); else denominator <<= BigInt(-shift);
  let integer = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && integer % 2n)) integer++;
  return (value < 0 ? -1 : 1) * Number(integer) / 10 ** digits;
}

// Decode like Python UTF-8 errors="ignore", preserving literal U+FFFD.
export function decodeUtf8Ignore(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i];
    if (first < 0x80) { result += String.fromCharCode(first); i++; continue; }
    const length = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    let cp = first & (0x7f >> length), valid = length > 0 && i + length <= bytes.length;
    for (let j = 1; valid && j < length; j++) {
      const byte = bytes[i + j];
      if (byte < 0x80 || byte > 0xbf) valid = false;
      else cp = (cp << 6) | (byte & 0x3f);
    }
    if (!valid || cp < [0, 0, 0x80, 0x800, 0x10000][length] || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { i++; continue; }
    result += String.fromCodePoint(cp); i += length;
  }
  return result;
}
const pythonStrip = value => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');

function urls(env, key, fallback) {
  if (env[key] === undefined) return fallback;
  const result = env[key].split(',').map(s => s.trim()).filter(Boolean);
  if (!result.length) throw new Error(`${key} must contain at least one URL`);
  for (const url of result) if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error(`${key}: expected HTTP(S) URL`);
  return result;
}

export async function refreshData(env = process.env, {pause = sleep} = {}) {
  const RPC = Object.fromEntries(Object.entries(DEFAULT_RPC).map(([chain, defaults]) => [chain, urls(env, 'IMD_RPC_' + chain.toUpperCase(), defaults)]));
  const HISTORY_RPC = urls(env, 'IMD_RPC_BASE_HISTORY', env.IMD_RPC_BASE === undefined ? DEFAULT_RPC.base.slice(0, 2) : RPC.base);
  const BLOCKSCOUT = (env.IMD_BLOCKSCOUT_URL || 'https://eth.blockscout.com').replace(/\/$/, '');
  const LAUNCHES = env.IMD_LAUNCHES_URL || 'https://api.imd.fun/launches';
  const IDX = env.IMD_INDEXER_URL || 'https://imd-communitycoins-indexer.up.railway.app/graphql';
  async function request(url, body, timeout) {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'user-agent': 'imd-dashboard-refresh', ...(body === undefined ? {} : {'content-type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return response.json();
  }
  const post = (url, body) => request(url, body, 60_000);
  async function rpc(chain, method, params, tries = 10) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const j = await post(RPC[chain][i % RPC[chain].length], {jsonrpc: '2.0', id: 1, method, params});
        if (j && Object.hasOwn(j, 'result')) return j.result;
        throw new Error(JSON.stringify(j?.error || j));
      } catch (e) { last = e; }
      await pause(Math.min(20, 1.5 * (i + 1)) * 1000);
    }
    throw new Error(`${chain} ${method} failed: ${last?.message}`);
  }
  async function getJson(url, tries = 8) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await request(url, undefined, 90_000); } catch (e) { last = e; }
      await pause(3 * (i + 1) * 1000);
    }
    throw new Error(`GET failed ${url}: ${last?.message}`);
  }
  const call = (chain, to, data, block = 'latest') => rpc(chain, 'eth_call', [{to, data}, block]);
  async function head(chain) {
    const b = await rpc(chain, 'eth_blockNumber', []);
    const block = await rpc(chain, 'eth_getBlockByNumber', [b, false]);
    return [b, parseInt(b, 16), iso(parseInt(block.timestamp, 16))];
  }
  async function ensResolver(node) {
    try {
      const r = await call('eth', ENS_REGISTRY, '0x0178b8bf' + node);
      return r && BigInt(r) ? '0x' + r.slice(-40) : null;
    } catch { return null; }
  }
  const ensCache = new Map();
  async function ensName(address) {
    const addr = (address || '').toLowerCase();
    if (!addr.startsWith('0x') || addr.length !== 42) return '';
    if (ensCache.has(addr)) return ensCache.get(addr);
    let name = '';
    try {
      const node = namehash(addr.slice(2) + '.addr.reverse'), res = await ensResolver(node);
      if (res) {
        const r = await call('eth', res, '0x691f3431' + node);
        if (r && r.length >= 130) {
          const b = Buffer.from(r.slice(2), 'hex'), n = Number(BigInt('0x' + b.subarray(32, 64).toString('hex')));
          // Python's errors="ignore" discards invalid UTF-8 rather than replacing it.
          const cand = pythonStrip(decodeUtf8Ignore(b.subarray(64, 64 + n)));
          if (cand) {
            const fn = namehash(cand), fres = await ensResolver(fn);
            if (fres) {
              const a = await call('eth', fres, '0x3b3b57de' + fn);
              if (a && a.slice(-40).toLowerCase() === addr.slice(2)) name = cand;
            }
          }
        }
      }
    } catch { name = ''; }
    ensCache.set(addr, name); return name;
  }
  const trackerCache = new Map();
  async function tokenTracker(address) {
    const addr = address.toLowerCase();
    if (!trackerCache.has(addr)) {
      let value = null;
      try {
        const t = await request(`${BLOCKSCOUT}/api/v2/tokens/${addr}`, undefined, 60_000);
        if (t.name) value = [t.name, t.symbol];
      } catch { /* Optional token tracker: reference falls back to artifact names. */ }
      trackerCache.set(addr, value); await pause(300);
    }
    return trackerCache.get(addr);
  }

  console.log('snapshot…');
  const [bb, bn, bt] = await head('base_latest');
  const [eb, en, et] = await head('eth');
  const [rb, rn, rt] = await head('rh');
  const baseSup = num(await call('base_latest', FP, '0x18160ddd', bb));
  const ethSup = num(await call('eth', ETH, '0x18160ddd', eb));
  const rhSup = num(await call('rh', RH, '0x18160ddd', rb));
  async function burnBalance(chain, token, block) {
    let total = 0;
    for (const a of BURN_WALLETS) total += num(await call(chain, token, balData(a), block));
    return total;
  }
  const baseBw = await burnBalance('base_latest', FP, bb);
  const ethBw = await burnBalance('eth', ETH, eb);
  const rhBw = await burnBalance('rh', RH, rb);
  const peer = await call('eth', ETH, selector('peers(uint32)') + BASE_EID.toString(16).padStart(64, '0'), eb);
  const adapter = '0x' + peer.slice(-40);
  const locked = num(await call('base_latest', FP, balData(adapter), bb));

  console.log('executors…');
  const executorSet = new Set(KNOWN_EXECUTORS);
  try {
    const found = await getJson(BLOCKSCOUT + '/api/v2/search?q=BurnExecutor');
    for (const it of found.items || []) if (it.name === 'BurnExecutor' && it.type === 'contract') {
      const a = it.address_hash.toLowerCase(), tok = await call('eth', a, selector('token()'), eb);
      if (tok && tok.slice(-40).toLowerCase() === ETH.slice(2)) executorSet.add(a);
    }
  } catch (e) { console.log('executor search skipped:', e.message); }
  const executors = [...executorSet].sort(), currentReceivers = new Set();
  let awaiting = 0;
  for (const x of executors) {
    const r = await call('eth', x, selector('baseBurnReceiver()'), eb);
    currentReceivers.add('0x' + r.slice(-40).toLowerCase());
    awaiting += num(await call('eth', ETH, balData(x), eb));
  }
  const ev = topic('TokensBridgedForBurn(address,uint32,bytes32,uint256,uint256,bytes32)');
  const bridgesRaw = [];
  for (const x of executors) {
    let q = {};
    while (true) {
      const d = await getJson(`${BLOCKSCOUT}/api/v2/addresses/${x}/logs` + (Object.keys(q).length ? '?' + query(q) : ''));
      for (const it of d.items || []) {
        const topics = it.topics || [];
        if (!topics.length || (topics[0] || '').toLowerCase() !== ev) continue;
        const data = (it.data || '0x').slice(2);
        bridgesRaw.push({executor: x, base_receiver: '0x' + topics[3].slice(-40).toLowerCase(), amount: num('0x' + data.slice(0, 64)), eth_block: it.block_number, tx: it.transaction_hash});
      }
      q = d.next_page_params;
      if (!q || !Object.keys(q).length) break;
      await pause(400);
    }
  }
  const blockTs = new Map();
  for (const b of [...new Set(bridgesRaw.map(r => r.eth_block))].sort((a, b) => a - b)) {
    blockTs.set(b, parseInt((await rpc('eth', 'eth_getBlockByNumber', [hex(b), false])).timestamp, 16)); await pause(100);
  }
  const bridges = bridgesRaw.map(r => ({bridged_at: iso(blockTs.get(r.eth_block)), day: iso(blockTs.get(r.eth_block)).slice(0, 10), executor: r.executor,
    base_receiver: r.base_receiver, amount: round(r.amount), eth_block: r.eth_block, tx: r.tx})).sort((a, b) => a.eth_block - b.eth_block);
  const receivers = [...new Set([...bridges.map(r => r.base_receiver), ...currentReceivers])].sort();
  const recvBal = new Map(), sentTo = new Map();
  for (const r of receivers) recvBal.set(r, num(await call('base_latest', FP, balData(r), bb)));
  for (const r of bridges) sentTo.set(r.base_receiver, (sentTo.get(r.base_receiver) || 0) + r.amount);
  const execBurned = sum(receivers.map(r => Math.max(0, (sentTo.get(r) || 0) - recvBal.get(r))));
  const stuckOld = sum(receivers.filter(r => !currentReceivers.has(r)).map(r => recvBal.get(r)));

  console.log('base history…');
  const days = [];
  for (let ts = Date.parse(BASE_LAUNCH + 'T00:00:00Z') / 1000 + 86400; ; ts += 86400) {
    const b = Math.floor((ts - BASE_GENESIS_TS) / 2);
    if (b > bn) break;
    days.push([iso(ts - 86400).slice(0, 10), b]);
  }
  const reqs = days.flatMap(([day, b], i) => [[i, 's', FP, '0x18160ddd', b], [i, 'd', FP, balData(BURN_WALLETS[0]), b], [i, 'o', FP, balData(BURN_WALLETS[2]), b]]);
  const res = new Map();
  for (let s = 0; s < reqs.length; s += 20) {
    const chunk = reqs.slice(s, s + 20);
    const body = chunk.map(([i, f, to, data, b], n) => ({jsonrpc: '2.0', id: n, method: 'eth_call', params: [{to, data}, hex(b)]}));
    let complete = false, last;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const j = await post(HISTORY_RPC[(s / 20 + attempt) % HISTORY_RPC.length], body);
        if (!Array.isArray(j) || j.length !== chunk.length || !j.every(x => Object.hasOwn(x, 'result'))) throw new Error('incomplete batch results');
        // Batch replies may be out of order. Reject duplicate/missing IDs as well.
        const ids = new Set(j.map(x => x.id));
        if (ids.size !== chunk.length || j.some(x => !Number.isInteger(x.id) || x.id < 0 || x.id >= chunk.length)) throw new Error('invalid batch IDs');
        for (const x of j) { const [i, f] = chunk[x.id]; res.set(`${i},${f}`, num(x.result)); }
        complete = true; break;
      } catch (e) { last = e; }
      await pause(Math.min(20, 1 + attempt) * 1000);
    }
    if (!complete) throw new Error(`base history chunk ${s} failed: ${last?.message}`);
    await pause(200);
  }
  const baseEnd = new Map(days.map(([day], i) => [day, START_SUPPLY - res.get(`${i},s`) + res.get(`${i},d`) + res.get(`${i},o`)]));
  const today = bt.slice(0, 10);
  baseEnd.set(today, START_SUPPLY - baseSup + baseBw);

  console.log('ethereum history…');
  const ethEv = [];
  let q = {token: ETH, type: 'ERC-20'};
  while (true) {
    const d = await getJson(`${BLOCKSCOUT}/api/v2/addresses/0x000000000000000000000000000000000000dEaD/token-transfers?` + query(q));
    for (const it of d.items || []) {
      const v = Number(BigInt(it.total.value)) / 1e18;
      if (it.to.hash.toLowerCase().endsWith('dead')) ethEv.push([it.timestamp.slice(0, 10), v]);
      else if (it.from.hash.toLowerCase().endsWith('dead')) ethEv.push([it.timestamp.slice(0, 10), -v]);
    }
    if (!d.next_page_params || !Object.keys(d.next_page_params).length) break;
    q = {token: ETH, type: 'ERC-20', ...d.next_page_params}; await pause(400);
  }

  console.log('robinhood history…');
  const W = ['0x' + pad(BURN_WALLETS[0]), '0x' + pad(BURN_WALLETS[2])];
  const chunks = [];
  for (let s = 0; s <= rn; s += 100000) chunks.push([s, Math.min(s + 99999, rn)]);
  const parts = Array(chunks.length);
  let nextChunk = 0;
  // Four concurrent workers, preserving input order like ThreadPoolExecutor.map.
  await Promise.all(Array.from({length: Math.min(4, chunks.length)}, async () => {
    while (nextChunk < chunks.length) {
      const i = nextChunk++, [start, end] = chunks[i];
      parts[i] = await rpc('rh', 'eth_getLogs', [{address: RH, fromBlock: hex(start), toBlock: hex(end), topics: [TRANSFER, null, W]}]);
    }
  }));
  const rhEv = [], tsc = new Map();
  for (const l of parts.flat()) {
    const b = l.blockNumber;
    if (!tsc.has(b)) tsc.set(b, parseInt((await rpc('rh', 'eth_getBlockByNumber', [b, false])).timestamp, 16));
    rhEv.push([iso(tsc.get(b)).slice(0, 10), num(l.data)]);
  }

  function perDay(events) {
    const p = new Map();
    for (const [day, v] of events) p.set(day, (p.get(day) || 0) + v);
    return p;
  }
  const pe = perDay(ethEv), pr = perDay(rhEv), history = [];
  let ce = 0, cr = 0;
  for (let ts = Date.parse(BASE_LAUNCH + 'T00:00:00Z'); iso(ts / 1000).slice(0, 10) <= today; ts += 86400000) {
    const k = iso(ts / 1000).slice(0, 10);
    if (!baseEnd.has(k)) throw new Error(`history missing Base day ${k}`);
    ce += pe.get(k) || 0; cr += pr.get(k) || 0;
    history.push({day: k, base_burned: round(baseEnd.get(k)), ethereum_burned: round(ce), robinhood_burned: round(cr)});
  }
  const destroyed = START_SUPPLY - baseSup, nativeFn = destroyed - execBurned;
  const burns = [
    {chain: 'Base', contract: FP, token: 'Fren Pet (original IMD)', supply_destroyed: round(destroyed), burn_wallets: round(baseBw), total_burned: round(destroyed + baseBw), current_supply: round(baseSup), initial_supply: START_SUPPLY, block: bn, as_of: bt},
    {chain: 'Ethereum', contract: ETH, token: 'Identity.md (IMD, bridged)', supply_destroyed: 0.0, burn_wallets: round(ethBw), total_burned: round(ethBw), current_supply: round(ethSup), initial_supply: null, block: en, as_of: et},
    {chain: 'Robinhood Chain', contract: RH, token: 'Identity.md (IMD, bridged)', supply_destroyed: 0.0, burn_wallets: round(rhBw), total_burned: round(rhBw), current_supply: round(rhSup), initial_supply: null, block: rn, as_of: rt},
  ];
  const baseSplit = [
    {method: 'Burned natively on Base', amount: round(nativeFn + baseBw), burn_function: round(nativeFn), burn_wallets: round(baseBw), note: "burn() on the Base token by anyone other than the BurnExecutor's receiver, plus tokens sent to 0x…dEaD/0x…0000/0x…0001 on Base"},
    {method: 'Bridged from Ethereum via BurnExecutor', amount: round(execBurned), burn_function: round(execBurned), burn_wallets: 0.0, note: 'IMD sent from the Ethereum BurnExecutors to the Base burn receiver, which burns all it holds'},
  ];
  const supply = [{starting_supply: START_SUPPLY, supply_now: round(baseSup), in_burn_wallets: round(baseBw + ethBw + rhBw), circulating_now: round(baseSup - baseBw - ethBw - rhBw), on_base: round(baseSup - locked), locked_for_bridges: round(locked), on_ethereum: round(ethSup), on_robinhood: round(rhSup), awaiting_executor: round(awaiting), stuck_old_receiver: round(stuckOld), as_of: bt}];
  // Python sum([]) is the integer 0, whereas a sum of balances is a float.
  if (receivers.every(r => currentReceivers.has(r))) Object.defineProperty(supply[0], PYTHON_INTEGER_FIELDS, {value: new Set(['stuck_old_receiver'])});
  const circ = {'Base': baseSup - locked, 'Ethereum': ethSup, 'Robinhood Chain': rhSup};
  for (const r of burns) { r.circulating_on_chain = round(circ[r.chain]); r.locked_in_bridge = r.chain === 'Base' ? round(locked) : 0.0; }
  const breakdown = [
    {route: 'Base · Fren Pet native', chain: 'Base', burn_function: round(nativeFn), burn_wallets: round(baseBw), total_burned: round(nativeFn + baseBw), how: "burn() on the Base token (Fren Pet) by anyone except the BurnExecutor's receiver, plus Base burn wallets"},
    {route: 'Base · via BurnExecutor', chain: 'Base', burn_function: round(execBurned), burn_wallets: 0.0, total_burned: round(execBurned), how: 'IMD collected by the Ethereum BurnExecutors, bridged to the Base burn receiver and burned there'},
    {route: 'Ethereum', chain: 'Ethereum', burn_function: 0.0, burn_wallets: round(ethBw), total_burned: round(ethBw), how: 'IMD sent to burn wallets on Ethereum'},
    {route: 'Robinhood Chain', chain: 'Robinhood Chain', burn_function: 0.0, burn_wallets: round(rhBw), total_burned: round(rhBw), how: 'IMD sent to burn wallets on Robinhood Chain'},
  ];

  console.log('burnkeepers…');
  const bsTx = h => getJson(`${BLOCKSCOUT}/api/v2/transactions/${h}`);
  const keeperRows = [];
  for (const r of bridges) {
    const t = await bsTx(r.tx); await pause(300);
    keeperRows.push({keeper: t.from.hash.toLowerCase(), ens: await ensName(t.from.hash) || t.from.ens_domain_name || '', amount: r.amount, day: r.day,
      eth_spent: Number(BigInt(t.value || 0)) / 1e18 + Number(BigInt(t.fee?.value || 0)) / 1e18});
  }
  const kagg = new Map();
  for (const k of keeperRows) {
    if (!kagg.has(k.keeper)) kagg.set(k.keeper, {keeper: k.keeper, ens: k.ens, bridges: 0, imd_sent_to_burn: 0.0, eth_spent: 0.0, first_day: k.day, last_day: k.day});
    const a = kagg.get(k.keeper);
    a.bridges++; a.imd_sent_to_burn += k.amount; a.eth_spent += k.eth_spent;
    if (k.day < a.first_day) a.first_day = k.day;
    if (k.day > a.last_day) a.last_day = k.day;
    a.ens ||= k.ens;
  }
  const burnkeepers = [...kagg.values()].sort((a, b) => b.imd_sent_to_burn - a.imd_sent_to_burn);
  burnkeepers.forEach((a, i) => {
    a.rank = i + 1; a.label = a.ens || a.keeper.slice(0, 6) + '…' + a.keeper.slice(-4);
    a.imd_sent_to_burn = round(a.imd_sent_to_burn); a.eth_spent = round(a.eth_spent);
  });

  console.log('executor sources…');
  const inflows = [];
  for (const x of executors) {
    let q = {type: 'ERC-20', filter: 'to', token: ETH};
    while (true) {
      const d = await getJson(`${BLOCKSCOUT}/api/v2/addresses/${x}/token-transfers?` + query(q));
      for (const it of d.items || []) {
        if (it.to.hash.toLowerCase() !== x) continue;
        inflows.push({from: it.from.hash.toLowerCase(), from_ens: it.from.ens_domain_name || '', from_name: it.from.name || '', from_contract: Boolean(it.from.is_contract), amount: Number(BigInt(it.total.value)) / 1e18, day: it.timestamp.slice(0, 10), tx: it.transaction_hash, method: (it.method || '').toLowerCase()});
      }
      if (!d.next_page_params || !Object.keys(d.next_page_params).length) break;
      q = {type: 'ERC-20', filter: 'to', token: ETH, ...d.next_page_params}; await pause(300);
    }
  }
  const launches = new Map();
  let before = null;
  while (true) {
    const d = await getJson(LAUNCHES + '?limit=500' + (before ? `&before=${before}` : '')), L = d.launches || [];
    for (const x of L) launches.set(x.launchNumber, x);
    if (L.length < 500) break;
    const nb = Math.min(...L.map(x => x.launchNumber));
    if (nb === before) break;
    before = nb; await pause(500);
  }
  const ethLaunches = [...launches.values()].filter(x => x.chainId === 1), launchArt = new Map(), artName = new Map();
  for (const x of ethLaunches) for (const a of x.artifacts || []) { launchArt.set(a.address.toLowerCase(), x); artName.set(a.address.toLowerCase(), a.name); }
  async function launchIdentity(x, addr = '') {
    const arts = x.artifacts || [];
    const order = [...arts.filter(a => a.address.toLowerCase() === addr), ...arts.filter(a => a.role === 'token'), ...arts.filter(a => !['distributor', 'hook'].includes(a.role) && a.address.toLowerCase() !== addr)];
    for (const a of order) { const tr = await tokenTracker(a.address); if (tr) return [tr[0], tr[1] || '']; }
    return [artName.get(addr) || arts.find(a => a.name.toLowerCase().includes('burn'))?.name || (arts.length ? arts[0].name : x.kind), ''];
  }
  async function launchLabel(x, addr) {
    const [name, tick] = await launchIdentity(x, addr);
    return tick ? `${name} (${tick}) #${x.launchNumber}` : `${name} #${x.launchNumber}`;
  }
  const lpBurnTxs = new Set();
  for (let page = 1; ; page++) {
    const q = {module: 'logs', action: 'getLogs', address: LAUNCHPAD_HOOK, fromBlock: '0', toBlock: 'latest', topic0: topic('ImdBurned(uint256)'), page, offset: 1000};
    const d = await getJson(`${BLOCKSCOUT}/api?` + query(q)), result = d.result || [];
    if (!Array.isArray(result)) break;
    for (const l of result) lpBurnTxs.add(l.transactionHash.toLowerCase());
    if (result.length < 1000) break;
    await pause(400);
  }
  const txTo = new Map(), src = new Map(), launchSent = new Map();
  function addSrc(key, kind, amount, day, address = '') {
    if (!src.has(key)) src.set(key, {source: key, kind, address, imd_sent: 0.0, transfers: 0, first_day: day, last_day: day});
    const s = src.get(key); s.imd_sent += amount; s.transfers++;
    if (day < s.first_day) s.first_day = day;
    if (day > s.last_day) s.last_day = day;
  }
  for (const r of inflows) {
    if (executorSet.has(r.from)) continue;
    if (lpBurnTxs.has(r.tx.toLowerCase()) || r.method === BURN_ACCRUED_SEL) { addSrc('Community coins (LaunchpadHook)', 'community coins', r.amount, r.day, LAUNCHPAD_HOOK); continue; }
    if (r.from === POOL_MANAGER) { addSrc('IMD/ETH pool burn hook & other Uniswap v4 swaps', 'pool hook', r.amount, r.day, '0xc6c965bd164c483e87d0b550671798e9a3602840'); continue; }
    if (!txTo.has(r.tx)) {
      const t = await bsTx(r.tx); await pause(300);
      txTo.set(r.tx, [(t.to?.hash || '').toLowerCase(), t.to?.name || '']);
    }
    const [toAddr, toName] = txTo.get(r.tx), lx = launchArt.get(toAddr) || launchArt.get(r.from);
    if (lx) {
      const hit = launchArt.has(toAddr) ? toAddr : r.from;
      addSrc(await launchLabel(lx, hit), 'swarm launch', r.amount, r.day, hit);
      launchSent.set(lx.launchNumber, (launchSent.get(lx.launchNumber) || 0) + r.amount); continue;
    }
    if (toName && toAddr !== ETH && toAddr !== r.from) { addSrc(`${toName} (contract)`, 'contract', r.amount, r.day, toAddr); continue; }
    const who = await ensName(r.from) || r.from_ens || r.from_name || r.from.slice(0, 6) + '…' + r.from.slice(-4);
    addSrc(who, r.from_contract ? 'contract' : 'wallet', r.amount, r.day, r.from);
  }
  const executorSources = [...src.values()].sort((a, b) => b.imd_sent - a.imd_sent);
  for (const s of executorSources) s.imd_sent = round(s.imd_sent);

  console.log('community coins…');
  const coins = [];
  let after = null;
  while (true) {
    const body = {query: 'query($after:String){ coins(orderBy:"burnedImd", orderDirection:"desc", limit:500, after:$after){ items { address name symbol creator createdAt tradeCount volumeEth burnedImd } pageInfo { hasNextPage endCursor } } }', variables: {after}};
    let g, last;
    for (let i = 0; i < 6; i++) {
      try { g = await post(IDX, body); break; } catch (e) { last = e; }
      await pause(3 * (i + 1) * 1000);
    }
    if (!g) throw new Error(`community coins indexer unreachable: ${last?.message}`);
    const c = g.data.coins; coins.push(...c.items);
    if (!c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
  let burnCoins = coins.map(c => ({address: c.address.toLowerCase(), name: c.name, symbol: c.symbol, type: 'Community coin', burn_feature: "LaunchpadHook burn fee on every trade's IMD leg", imd_to_burn: round(Number(BigInt(c.burnedImd)) / 1e18), trades: Number(c.tradeCount), volume_eth: round(Number(BigInt(c.volumeEth)) / 1e18), launched: /^\d+$/.test(String(c.createdAt)) ? iso(Number(c.createdAt)).slice(0, 10) : ''}));
  for (const x of ethLaunches) {
    if (x.status !== 'live') continue;
    const arts = x.artifacts || [], burnArts = arts.filter(a => a.name.toLowerCase().includes('burn')).map(a => a.name), sent = launchSent.get(x.launchNumber) || 0;
    if (!burnArts.length && sent === 0) continue;
    const tok = arts.find(a => a.role === 'token') || arts.find(a => burnArts.includes(a.name)) || arts[0];
    if (!tok) continue;
    const hitAddr = (arts.find(a => burnArts.includes(a.name)) || tok).address.toLowerCase();
    const [nm, tick] = await launchIdentity(x, tok.role === 'token' ? tok.address.toLowerCase() : hitAddr);
    burnCoins.push({address: tok.address.toLowerCase(), name: `${nm} #${x.launchNumber}`, symbol: tick || '—', type: `Swarm launch #${x.launchNumber}`, burn_feature: burnArts.length ? burnArts.join(', ') : 'Sends IMD to the BurnExecutor', imd_to_burn: round(sent), trades: null, volume_eth: null, launched: (x.createdAt || '').slice(0, 10)});
  }
  const seen = new Set();
  burnCoins = burnCoins.sort((a, b) => b.imd_to_burn - a.imd_to_burn).filter(b => {
    if (seen.has(b.address)) return false;
    seen.add(b.address); return true;
  });
  burnCoins.forEach((b, i) => { b.rank = i + 1; });

  const problems = [], ethHistory = sum(ethEv.map(e => e[1])), rhHistory = sum(rhEv.map(e => e[1]));
  if (Math.abs(ethHistory - ethBw) > 0.01) problems.push(`eth history ${ethHistory.toFixed(4)} != dead balance ${ethBw.toFixed(4)}`);
  if (Math.abs(rhHistory - rhBw) > 0.01) problems.push(`rh history ${rhHistory.toFixed(4)} != burn wallets ${rhBw.toFixed(4)}`);
  if (!(0 < destroyed && destroyed < START_SUPPLY)) problems.push('base destroyed out of range');
  if (nativeFn < 0) problems.push('native burns negative');
  if (Math.abs(locked - (ethSup + rhSup)) > 5000) problems.push(`locked ${locked.toFixed(2)} vs bridged supply ${(ethSup + rhSup).toFixed(2)}`);
  if (history.length < 1000 || history.at(-1).day !== today) problems.push('history incomplete');
  if (history.some((r, i) => i && r.base_burned + 1e-6 < history[i - 1].base_burned)) problems.push('base history not monotonic');
  const circTotal = sum(Object.values(circ));
  if (Math.abs(circTotal - baseSup) > 5000) problems.push(`circulating per chain ${circTotal.toFixed(2)} != Base supply ${baseSup.toFixed(2)}`);
  if (circTotal > START_SUPPLY) problems.push('circulating exceeds starting supply');
  if (Math.abs(sum(breakdown.map(b => b.total_burned)) - (destroyed + baseBw + ethBw + rhBw)) > 0.01) problems.push('breakdown does not add up');
  const extIn = sum(executorSources.map(s => s.imd_sent)), bridged = sum(bridges.map(r => r.amount));
  if (Math.abs(extIn - (bridged + awaiting)) > 50) problems.push(`executor inflows ${extIn.toFixed(2)} vs bridged+waiting ${(bridged + awaiting).toFixed(2)}`);
  if (!burnkeepers.length || Math.abs(sum(burnkeepers.map(k => k.imd_sent_to_burn)) - bridged) > 0.01) problems.push('burnkeepers do not add up');
  if (coins.length < 50) problems.push('community coins list looks incomplete');
  if (!lpBurnTxs.size) problems.push('LaunchpadHook burn events missing');
  const summary = {ok: !problems.length, problems, as_of: bt, total_burned_all_chains: round(destroyed + baseBw + ethBw + rhBw, 2), base_native: round(nativeFn + baseBw, 2), base_executor: round(execBurned, 2), ethereum: round(ethBw, 2), robinhood: round(rhBw, 2), supply_now: round(baseSup, 2), executor_bridges: bridges.length, history_days: history.length, executors, circulating_all_chains: round(circTotal, 2), burnkeepers: burnkeepers.length, executor_sources: executorSources.length, burn_coins: burnCoins.length, executor_inflows: round(extIn, 2)};
  console.log(JSON.stringify(summary, null, 1));
  if (problems.length) throw new Error('sanity checks failed: ' + problems.join('; '));
  return {'imd-burns.json': burns, 'imd-base-split.json': baseSplit, 'imd-supply.json': supply, 'imd-executor-bridges.json': bridges, 'imd-burn-breakdown.json': breakdown, 'imd-burnkeepers.json': burnkeepers, 'imd-executor-sources.json': executorSources, 'imd-burn-coins.json': burnCoins, 'imd-burn-history.json': history, 'summary.json': summary};
}

// Retain Python JSON's integer/float distinction (e.g. burn_wallets: 0.0),
// one-space indentation, ASCII escapes, and compact daily history.
const INTEGER_KEYS = new Set(['initial_supply', 'starting_supply', 'block', 'eth_block', 'rank', 'trades', 'bridges', 'transfers', 'executor_bridges', 'history_days', 'burnkeepers', 'executor_sources', 'burn_coins']);
function jsonString(s) { return JSON.stringify(s).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); }
export function serialize(value, compact = false) {
  function encode(v, key, depth, integerField = false) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`non-finite ${key}`);
      let text = Object.is(v, -0) ? '-0' : String(v);
      // Python uses scientific notation below 1e-4. Its exponent has two digits.
      if (v !== 0 && (Math.abs(v) < 1e-4 || (Math.abs(v) >= 1e16 && !INTEGER_KEYS.has(key) && !integerField))) text = v.toExponential();
      if (text.includes('e')) text = text.replace(/e([+-]?)(\d+)$/, (_, sign, n) => 'e' + (sign || '+') + n.padStart(2, '0'));
      else if (!INTEGER_KEYS.has(key) && !integerField && Number.isInteger(v)) text += '.0';
      return text;
    }
    if (typeof v === 'string') return jsonString(v);
    if (v === null || typeof v === 'boolean') return String(v);
    const array = Array.isArray(v), entries = array ? v.map(x => encode(x, key, depth + 1)) : Object.entries(v).map(([k, x]) => jsonString(k) + (compact ? ':' : ': ') + encode(x, k, depth + 1, v[PYTHON_INTEGER_FIELDS]?.has(k)));
    if (!entries.length) return array ? '[]' : '{}';
    const open = array ? '[' : '{', close = array ? ']' : '}';
    return compact ? open + entries.join(',') + close : open + '\n' + ' '.repeat(depth + 1) + entries.join(',\n' + ' '.repeat(depth + 1)) + '\n' + ' '.repeat(depth) + close;
  }
  return encode(value, '', 0);
}

// Stage all ten files on the same filesystem, then publish. Keep backups for
// rollback if a rename fails midway; no final data is touched before validation.
export async function publish(out, data) {
  await mkdir(out, {recursive: true});
  const staging = await mkdtemp(path.join(out, '.imd-refresh-'));
  const backed = [], installed = [];
  try {
    for (const name of DATA_FILES) {
      if (!Object.hasOwn(data, name)) throw new Error(`missing output ${name}`);
      await writeFile(path.join(staging, name), serialize(data[name], name === 'imd-burn-history.json'));
    }
    for (const name of DATA_FILES) {
      try { await rename(path.join(out, name), path.join(staging, name + '.old')); backed.push(name); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await rename(path.join(staging, name), path.join(out, name)); installed.push(name);
    }
  } catch (e) {
    for (const name of installed.reverse()) await rm(path.join(out, name), {force: true});
    for (const name of backed.reverse()) await rename(path.join(staging, name + '.old'), path.join(out, name));
    throw e;
  } finally { await rm(staging, {recursive: true, force: true}); }
}

export async function main(out = process.argv[2] || '.', env = process.env, refresh = refreshData) {
  const attemptedAt = iso(Math.floor(Date.now() / 1000));
  let prior = {};
  try { const status = JSON.parse(await readFile(path.join(out, 'imd-refresh-status.json'), 'utf8')); prior = Array.isArray(status) ? status[0] || {} : status; } catch { /* First run. */ }
  let status;
  try {
    const data = await refresh(env);
    await publish(out, data);
    status = {last_attempt_at: attemptedAt, last_result: 'refreshed', message: 'Rebuilt from public RPCs and indexers; all sanity checks passed.', last_success_at: iso(Math.floor(Date.now() / 1000)), data_as_of: data['summary.json'].as_of};
    console.log('wrote files to', out);
  } catch (e) {
    status = {...prior, last_attempt_at: attemptedAt, last_result: 'failed', message: e.message || String(e)};
    console.error('IMD refresh failed; keeping previous data:', status.message);
  }
  try {
    await mkdir(out, {recursive: true});
    const temp = await mkdtemp(path.join(out, '.imd-status-'));
    try { await writeFile(path.join(temp, 'status.json'), JSON.stringify([status], null, 1)); await rename(path.join(temp, 'status.json'), path.join(out, 'imd-refresh-status.json')); }
    finally { await rm(temp, {recursive: true, force: true}); }
  } catch (e) { console.error('Could not write IMD refresh status:', e.message); }
  // A failed source must never break a static-site build.
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
