#!/usr/bin/env python3
"""IMD burn dashboard refresh.

Recomputes every data file the "IMD tokens burned" dashboard reads, from public
blockchain RPCs and eth.blockscout.com. Stateless: each run rebuilds everything.

Usage:  python3 refresh_imd.py OUT_DIR
Writes into OUT_DIR:
  imd-burns.json, imd-base-split.json, imd-supply.json,
  imd-executor-bridges.json, imd-burn-history.json, imd-burn-breakdown.json,
  imd-burnkeepers.json, imd-executor-sources.json, imd-burn-coins.json, summary.json
Extra sources: api.imd.fun/launches (swarm launches) and the communitycoins.imd.fun indexer.
Exits non-zero (and writes nothing final) if any sanity check fails.
Needs: pycryptodome (pip install --break-system-packages pycryptodome)
"""
import json, sys, os, time, datetime, urllib.request, urllib.parse, collections
from concurrent.futures import ThreadPoolExecutor
from Crypto.Hash import keccak

OUT = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(OUT, exist_ok=True)
UTC = datetime.timezone.utc

# ---- constants -------------------------------------------------------------
FP = "0xff0c532fdb8cd566ae169c1cb157ff2bdc83e105"      # Base: original token (Fren Pet / IMD), 10M minted once
ETH = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7"     # Ethereum: bridged IMD (LayerZero OFT)
RH = "0x5f7bb59365ce557c26dbcaa4ee9d39a4b95b7127"      # Robinhood Chain: bridged IMD
START_SUPPLY = 10_000_000
BASE_GENESIS_TS = 1686789347                            # Base block 0 timestamp, 2s blocks
BASE_LAUNCH = datetime.date(2023, 8, 31)
BASE_EID = 30184
BURN_WALLETS = ["0x000000000000000000000000000000000000dead",
                "0x0000000000000000000000000000000000000000",
                "0x0000000000000000000000000000000000000001"]
KNOWN_EXECUTORS = ["0x2ec59bed2fb9dee447bbec6e3bca249782c9b88b",
                   "0xe29386719c155b6847ad5a4e97c6674f10ffc750"]
RPC = {
    "base": ["https://base-mainnet.public.blastapi.io", "https://mainnet.base.org", "https://base.gateway.tenderly.co"],
    "base_latest": ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    "eth": ["https://ethereum-rpc.publicnode.com"],
    "rh": ["https://rpc.mainnet.chain.robinhood.com"],
}
BLOCKSCOUT = "https://eth.blockscout.com"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def sel(sig):
    k = keccak.new(digest_bits=256); k.update(sig.encode()); return "0x" + k.hexdigest()


def post(url, body, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json", "user-agent": "imd-dashboard-refresh"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def rpc(chain, method, params, tries=10):
    urls = RPC[chain]
    for i in range(tries):
        try:
            j = post(urls[i % len(urls)], {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
            if "result" in j:
                return j["result"]
        except Exception:
            pass
        time.sleep(min(20, 1.5 * (i + 1)))
    raise RuntimeError(f"{chain} {method} failed")


def get_json(url, tries=8):
    for i in range(tries):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "imd-dashboard-refresh"}), timeout=90))
        except Exception:
            time.sleep(3 * (i + 1))
    raise RuntimeError("GET failed " + url)


def pad(addr): return addr[2:].lower().rjust(64, "0")
def bal_data(addr): return "0x70a08231" + pad(addr)
def iso(ts): return datetime.datetime.fromtimestamp(ts, UTC).isoformat().replace("+00:00", "Z")
def num(hexstr): return int(hexstr, 16) / 1e18


def call(chain, to, data, block="latest"):
    return rpc(chain, "eth_call", [{"to": to, "data": data}, block])


def head(chain):
    b = rpc(chain, "eth_blockNumber", [])
    ts = int(rpc(chain, "eth_getBlockByNumber", [b, False])["timestamp"], 16)
    return b, int(b, 16), iso(ts)


# ---- ENS names (reverse record, confirmed by a forward lookup) and token trackers ----
ENS_REGISTRY = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e"
def _kk(b):
    h = keccak.new(digest_bits=256); h.update(b); return h.digest()
def namehash(name):
    node = b"\0" * 32
    if name:
        for label in reversed(name.split(".")):
            node = _kk(node + _kk(label.encode()))
    return node.hex()
def _ens_resolver(node):
    try:
        r = call("eth", ENS_REGISTRY, "0x0178b8bf" + node)
    except Exception:
        return None
    return ("0x" + r[-40:]) if r and int(r, 16) else None
_ens_cache = {}
def ens_name(addr):
    addr = (addr or "").lower()
    if not addr.startswith("0x") or len(addr) != 42:
        return ""
    if addr in _ens_cache:
        return _ens_cache[addr]
    name = ""
    try:
        node = namehash(addr[2:] + ".addr.reverse")
        res = _ens_resolver(node)
        if res:
            r = call("eth", res, "0x691f3431" + node)
            if r and len(r) >= 130:
                b = bytes.fromhex(r[2:]); n = int.from_bytes(b[32:64], "big")
                cand = b[64:64 + n].decode(errors="ignore").strip()
                if cand:
                    fn = namehash(cand); fres = _ens_resolver(fn)
                    if fres:
                        a = call("eth", fres, "0x3b3b57de" + fn)
                        if a and a[-40:].lower() == addr[2:]:
                            name = cand
    except Exception:
        name = ""
    _ens_cache[addr] = name
    return name
_tracker_cache = {}
def token_tracker(addr):
    """(name, symbol) from Blockscout's token tracker, or None if the contract isn't a token."""
    addr = addr.lower()
    if addr not in _tracker_cache:
        try:
            t = json.load(urllib.request.urlopen(urllib.request.Request(f"https://eth.blockscout.com/api/v2/tokens/{addr}",
                                                 headers={"user-agent": "imd-dashboard-refresh"}), timeout=60))
            _tracker_cache[addr] = (t.get("name"), t.get("symbol")) if t.get("name") else None
        except Exception:
            _tracker_cache[addr] = None
        time.sleep(0.3)
    return _tracker_cache[addr]

# ---- 1. current snapshot ---------------------------------------------------
print("snapshot…", flush=True)
bb, bn, bt = head("base_latest"); eb, en, et = head("eth"); rb, rn, rt = head("rh")
base_sup = num(call("base_latest", FP, "0x18160ddd", bb))
eth_sup = num(call("eth", ETH, "0x18160ddd", eb))
rh_sup = num(call("rh", RH, "0x18160ddd", rb))
base_bw = sum(num(call("base_latest", FP, bal_data(a), bb)) for a in BURN_WALLETS)
eth_bw = sum(num(call("eth", ETH, bal_data(a), eb)) for a in BURN_WALLETS)
rh_bw = sum(num(call("rh", RH, bal_data(a), rb)) for a in BURN_WALLETS)
peer = call("eth", ETH, sel("peers(uint32)")[:10] + hex(BASE_EID)[2:].rjust(64, "0"), eb)
adapter = "0x" + peer[-40:]
locked = num(call("base_latest", FP, bal_data(adapter), bb))

# ---- 2. BurnExecutors (Ethereum) -------------------------------------------
print("executors…", flush=True)
executors = set(KNOWN_EXECUTORS)
try:
    # A contract found by name counts only with the token and the runtime bytecode of a known BurnExecutor.
    known_code = {c for c in (rpc("eth", "eth_getCode", [k, eb]) for k in KNOWN_EXECUTORS) if c and c != "0x"}
    found = get_json(BLOCKSCOUT + "/api/v2/search?q=BurnExecutor")
    for it in found.get("items", []):
        if it.get("name") == "BurnExecutor" and it.get("type") == "contract":
            a = it["address_hash"].lower()
            if a in executors:
                continue
            tok = call("eth", a, sel("token()")[:10], eb)
            if not tok or tok[-40:].lower() != ETH[2:]:
                continue
            if rpc("eth", "eth_getCode", [a, eb]) in known_code:
                executors.add(a)
            else:
                print("executor found by name but ignored, unknown bytecode:", a)
except Exception as e:
    print("executor search skipped:", e)
executors = sorted(executors)
current_receivers = set()
awaiting = 0.0
for x in executors:
    r = call("eth", x, sel("baseBurnReceiver()")[:10], eb)
    current_receivers.add("0x" + r[-40:].lower())
    awaiting += num(call("eth", ETH, bal_data(x), eb))

ev = sel("TokensBridgedForBurn(address,uint32,bytes32,uint256,uint256,bytes32)")
bridges_raw = []
for x in executors:
    q = {}
    while True:
        url = f"{BLOCKSCOUT}/api/v2/addresses/{x}/logs" + ("?" + urllib.parse.urlencode(q) if q else "")
        d = get_json(url)
        for it in d.get("items", []):
            topics = it.get("topics") or []
            if not topics or (topics[0] or "").lower() != ev:
                continue
            data = (it.get("data") or "0x")[2:]
            bridges_raw.append({"executor": x, "base_receiver": "0x" + topics[3][-40:].lower(),
                                "amount": int(data[0:64], 16) / 1e18, "eth_block": it["block_number"],
                                "tx": it["transaction_hash"]})
        q = d.get("next_page_params")
        if not q:
            break
        time.sleep(0.4)
blk_ts = {}
for b in sorted({r["eth_block"] for r in bridges_raw}):
    blk_ts[b] = int(rpc("eth", "eth_getBlockByNumber", [hex(b), False])["timestamp"], 16)
    time.sleep(0.1)
bridges = sorted([{"bridged_at": iso(blk_ts[r["eth_block"]]), "day": iso(blk_ts[r["eth_block"]])[:10],
                   "executor": r["executor"], "base_receiver": r["base_receiver"], "amount": round(r["amount"], 6),
                   "eth_block": r["eth_block"], "tx": r["tx"]} for r in bridges_raw], key=lambda r: r["eth_block"])

receivers = sorted({r["base_receiver"] for r in bridges} | current_receivers)
recv_bal = {r: num(call("base_latest", FP, bal_data(r), bb)) for r in receivers}
sent_to = collections.defaultdict(float)
for r in bridges:
    sent_to[r["base_receiver"]] += r["amount"]
# burned via executor = everything that reached a receiver and is no longer held by it
exec_burned = sum(max(0.0, sent_to[r] - recv_bal[r]) for r in receivers)
stuck_old = sum(recv_bal[r] for r in receivers if r not in current_receivers)

# ---- 3. Base daily history (archive eth_call, batched) ---------------------
print("base history…", flush=True)
latest_base = bn
days = []
d = datetime.datetime.combine(BASE_LAUNCH + datetime.timedelta(days=1), datetime.time(), UTC)
while True:
    b = (int(d.timestamp()) - BASE_GENESIS_TS) // 2
    if b > latest_base:
        break
    days.append(((d.date() - datetime.timedelta(days=1)).isoformat(), b))   # value at 00:00 = end of previous day
    d += datetime.timedelta(days=1)
reqs = []
for i, (day, b) in enumerate(days):
    reqs += [(i, "s", FP, "0x18160ddd", b), (i, "d", FP, bal_data(BURN_WALLETS[0]), b), (i, "o", FP, bal_data(BURN_WALLETS[2]), b)]
res = {}
for s in range(0, len(reqs), 20):
    chunk = reqs[s:s + 20]
    body = [{"jsonrpc": "2.0", "id": n, "method": "eth_call", "params": [{"to": to, "data": data}, hex(b)]}
            for n, (i, f, to, data, b) in enumerate(chunk)]
    for attempt in range(12):
        u = ["https://base-mainnet.public.blastapi.io", "https://mainnet.base.org"][(s // 20 + attempt) % 2]
        try:
            j = post(u, body)
            if isinstance(j, list) and len(j) == len(chunk) and all("result" in x for x in j):
                for x in j:
                    i, f = chunk[x["id"]][0], chunk[x["id"]][1]
                    res[(i, f)] = num(x["result"])
                break
        except Exception:
            pass
        time.sleep(min(20, 1 + attempt))
    else:
        raise RuntimeError(f"base history chunk {s} failed")
    time.sleep(0.2)
base_end = {day: START_SUPPLY - res[(i, "s")] + res[(i, "d")] + res[(i, "o")] for i, (day, b) in enumerate(days)}
today = bt[:10]
base_end[today] = START_SUPPLY - base_sup + base_bw

# ---- 4. Ethereum burn-wallet history (Blockscout transfers) ----------------
print("ethereum history…", flush=True)
eth_ev = []
q = {"token": ETH, "type": "ERC-20"}
while True:
    d_ = get_json(f"{BLOCKSCOUT}/api/v2/addresses/0x000000000000000000000000000000000000dEaD/token-transfers?" + urllib.parse.urlencode(q))
    for it in d_.get("items", []):
        v = int(it["total"]["value"]) / 1e18
        if it["to"]["hash"].lower().endswith("dead"):
            eth_ev.append((it["timestamp"][:10], v))
        elif it["from"]["hash"].lower().endswith("dead"):
            eth_ev.append((it["timestamp"][:10], -v))
    np_ = d_.get("next_page_params")
    if not np_:
        break
    q = {"token": ETH, "type": "ERC-20", **np_}
    time.sleep(0.4)

# ---- 5. Robinhood burn-wallet history (logs in 100k-block chunks) ----------
print("robinhood history…", flush=True)
W = ["0x" + pad(BURN_WALLETS[0]), "0x" + pad(BURN_WALLETS[2])]
chunks = [(s, min(s + 99999, rn)) for s in range(0, rn + 1, 100000)]
def rh_logs(c):
    return rpc("rh", "eth_getLogs", [{"address": RH, "fromBlock": hex(c[0]), "toBlock": hex(c[1]), "topics": [TRANSFER, None, W]}])
with ThreadPoolExecutor(4) as ex:
    parts = list(ex.map(rh_logs, chunks))
rh_ev, tsc = [], {}
for l in [l for p in parts for l in p]:
    b = l["blockNumber"]
    if b not in tsc:
        tsc[b] = int(rpc("rh", "eth_getBlockByNumber", [b, False])["timestamp"], 16)
    rh_ev.append((iso(tsc[b])[:10], int(l["data"], 16) / 1e18))

# ---- 6. assemble -----------------------------------------------------------
def per_day(evts):
    p = collections.defaultdict(float)
    for d0, v in evts:
        p[d0] += v
    return p
pe, pr = per_day(eth_ev), per_day(rh_ev)
history, ce, cr = [], 0.0, 0.0
d0 = BASE_LAUNCH
while d0.isoformat() <= today:
    k = d0.isoformat()
    ce += pe.get(k, 0); cr += pr.get(k, 0)
    history.append({"day": k, "base_burned": round(base_end[k], 6), "ethereum_burned": round(ce, 6), "robinhood_burned": round(cr, 6)})
    d0 += datetime.timedelta(days=1)

destroyed = START_SUPPLY - base_sup
native_fn = destroyed - exec_burned
burns = [
    {"chain": "Base", "contract": FP, "token": "Fren Pet (original IMD)", "supply_destroyed": round(destroyed, 6),
     "burn_wallets": round(base_bw, 6), "total_burned": round(destroyed + base_bw, 6), "current_supply": round(base_sup, 6),
     "initial_supply": START_SUPPLY, "block": bn, "as_of": bt},
    {"chain": "Ethereum", "contract": ETH, "token": "Identity.md (IMD, bridged)", "supply_destroyed": 0.0,
     "burn_wallets": round(eth_bw, 6), "total_burned": round(eth_bw, 6), "current_supply": round(eth_sup, 6),
     "initial_supply": None, "block": en, "as_of": et},
    {"chain": "Robinhood Chain", "contract": RH, "token": "Identity.md (IMD, bridged)", "supply_destroyed": 0.0,
     "burn_wallets": round(rh_bw, 6), "total_burned": round(rh_bw, 6), "current_supply": round(rh_sup, 6),
     "initial_supply": None, "block": rn, "as_of": rt}]
base_split = [
    {"method": "Burned natively on Base", "amount": round(native_fn + base_bw, 6), "burn_function": round(native_fn, 6),
     "burn_wallets": round(base_bw, 6),
     "note": "burn() on the Base token by anyone other than the BurnExecutor's receiver, plus tokens sent to 0x…dEaD/0x…0000/0x…0001 on Base"},
    {"method": "Bridged from Ethereum via BurnExecutor", "amount": round(exec_burned, 6), "burn_function": round(exec_burned, 6),
     "burn_wallets": 0.0, "note": "IMD sent from the Ethereum BurnExecutors to the Base burn receiver, which burns all it holds"}]
supply = [{"starting_supply": START_SUPPLY, "supply_now": round(base_sup, 6), "in_burn_wallets": round(base_bw + eth_bw + rh_bw, 6),
           "circulating_now": round(base_sup - base_bw - eth_bw - rh_bw, 6), "on_base": round(base_sup - locked, 6),
           "locked_for_bridges": round(locked, 6), "on_ethereum": round(eth_sup, 6), "on_robinhood": round(rh_sup, 6),
           "awaiting_executor": round(awaiting, 6), "stuck_old_receiver": round(stuck_old, 6), "as_of": bt}]
# Circulating per chain without double counting: Base's totalSupply includes the IMD locked in the
# Base bridge contract that backs every bridged token on Ethereum and Robinhood, so it is left out here.
circ = {"Base": base_sup - locked, "Ethereum": eth_sup, "Robinhood Chain": rh_sup}
for r in burns:
    r["circulating_on_chain"] = round(circ[r["chain"]], 6)
    r["locked_in_bridge"] = round(locked, 6) if r["chain"] == "Base" else 0.0

# Burn routes, Base split into the Fren Pet token's own burns and burns arriving through the BurnExecutor
breakdown = [
    {"route": "Base · Fren Pet native", "chain": "Base", "burn_function": round(native_fn, 6), "burn_wallets": round(base_bw, 6),
     "total_burned": round(native_fn + base_bw, 6),
     "how": "burn() on the Base token (Fren Pet) by anyone except the BurnExecutor's receiver, plus Base burn wallets"},
    {"route": "Base · via BurnExecutor", "chain": "Base", "burn_function": round(exec_burned, 6), "burn_wallets": 0.0,
     "total_burned": round(exec_burned, 6),
     "how": "IMD collected by the Ethereum BurnExecutors, bridged to the Base burn receiver and burned there"},
    {"route": "Ethereum", "chain": "Ethereum", "burn_function": 0.0, "burn_wallets": round(eth_bw, 6), "total_burned": round(eth_bw, 6),
     "how": "IMD sent to burn wallets on Ethereum"},
    {"route": "Robinhood Chain", "chain": "Robinhood Chain", "burn_function": 0.0, "burn_wallets": round(rh_bw, 6), "total_burned": round(rh_bw, 6),
     "how": "IMD sent to burn wallets on Robinhood Chain"}]

# ---- 6b. burnkeepers, BurnExecutor sources, launched tokens with built-in burns ----------
print("burnkeepers…", flush=True)
POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90"
BURN_ACCRUED_SEL = "0x9cb568de"   # LaunchpadHook.burnAccruedImd()
def bs_tx(h):
    return get_json(f"{BLOCKSCOUT}/api/v2/transactions/{h}")
keeper_rows = []
for r in bridges:
    t = bs_tx(r["tx"]); time.sleep(0.3)
    keeper_rows.append({"keeper": t["from"]["hash"].lower(), "ens": ens_name(t["from"]["hash"]) or t["from"].get("ens_domain_name") or "",
                        "amount": r["amount"], "day": r["day"],
                        "eth_spent": int(t.get("value") or 0) / 1e18 + int((t.get("fee") or {}).get("value") or 0) / 1e18})
kagg = collections.OrderedDict()
for k in keeper_rows:
    a = kagg.setdefault(k["keeper"], {"keeper": k["keeper"], "ens": k["ens"], "bridges": 0, "imd_sent_to_burn": 0.0, "eth_spent": 0.0,
                                      "first_day": k["day"], "last_day": k["day"]})
    a["bridges"] += 1; a["imd_sent_to_burn"] += k["amount"]; a["eth_spent"] += k["eth_spent"]
    a["first_day"] = min(a["first_day"], k["day"]); a["last_day"] = max(a["last_day"], k["day"])
    a["ens"] = a["ens"] or k["ens"]
burnkeepers = sorted(kagg.values(), key=lambda a: -a["imd_sent_to_burn"])
for i, a in enumerate(burnkeepers):
    a["rank"] = i + 1; a["label"] = a["ens"] or (a["keeper"][:6] + "…" + a["keeper"][-4:])
    a["imd_sent_to_burn"] = round(a["imd_sent_to_burn"], 6); a["eth_spent"] = round(a["eth_spent"], 6)

print("executor sources…", flush=True)
inflows = []
for x in executors:
    q = {"type": "ERC-20", "filter": "to", "token": ETH}
    while True:
        d_ = get_json(f"{BLOCKSCOUT}/api/v2/addresses/{x}/token-transfers?" + urllib.parse.urlencode(q))
        for it in d_.get("items", []):
            if it["to"]["hash"].lower() != x:
                continue
            inflows.append({"from": it["from"]["hash"].lower(), "from_ens": it["from"].get("ens_domain_name") or "",
                            "from_name": it["from"].get("name") or "", "from_contract": bool(it["from"].get("is_contract")), "amount": int(it["total"]["value"]) / 1e18,
                            "day": it["timestamp"][:10], "tx": it["transaction_hash"], "method": (it.get("method") or "").lower()})
        np_ = d_.get("next_page_params")
        if not np_:
            break
        q = {"type": "ERC-20", "filter": "to", "token": ETH, **np_}; time.sleep(0.3)
# imd.fun swarm launches (all chains listed; Ethereum ones are matched here)
launches, before = {}, None
while True:
    d_ = get_json("https://api.imd.fun/launches?limit=500" + (f"&before={before}" if before else ""))
    L_ = d_.get("launches", [])
    for x in L_:
        launches[x["launchNumber"]] = x
    if len(L_) < 500:
        break
    nb = min(x["launchNumber"] for x in L_)
    if nb == before:
        break
    before = nb; time.sleep(0.5)
eth_launches = [x for x in launches.values() if x.get("chainId") == 1]
launch_art = {a["address"].lower(): x for x in eth_launches for a in x.get("artifacts", [])}
art_name = {a["address"].lower(): a["name"] for x in eth_launches for a in x.get("artifacts", [])}
def launch_identity(x, addr=None):
    """Name and ticker for a swarm launch: the token tracker of the contract involved, else of any token the
    launch deployed, else the contract's own name. Returns (name, ticker or '')."""
    arts = x.get("artifacts", [])
    order = ([a for a in arts if a["address"].lower() == (addr or "")] + [a for a in arts if a.get("role") == "token"]
             + [a for a in arts if a.get("role") not in ("distributor", "hook") and a["address"].lower() != (addr or "")])
    for a in order:
        tr = token_tracker(a["address"])
        if tr:
            return tr[0], tr[1] or ""
    base = art_name.get(addr or "") or next((a["name"] for a in arts if "burn" in a["name"].lower()), None) or (arts[0]["name"] if arts else x["kind"])
    return base, ""
def launch_label(x, addr):
    name, tick = launch_identity(x, addr)
    return f"{name} ({tick}) #{x['launchNumber']}" if tick else f"{name} #{x['launchNumber']}"
# Community-coin burns: transactions in which the LaunchpadHook emitted ImdBurned (exact, not inferred)
LAUNCHPAD_HOOK = "0x51768f5da32ba2008304cc81674da51acb802888"
lp_burn_txs, lp_page = set(), 1
while True:
    q_ = {"module": "logs", "action": "getLogs", "address": LAUNCHPAD_HOOK, "fromBlock": "0", "toBlock": "latest",
          "topic0": sel("ImdBurned(uint256)"), "page": lp_page, "offset": 1000}
    d_ = get_json(f"{BLOCKSCOUT}/api?" + urllib.parse.urlencode(q_))
    res_ = d_.get("result") or []
    if not isinstance(res_, list):
        break
    lp_burn_txs |= {l["transactionHash"].lower() for l in res_}
    if len(res_) < 1000:
        break
    lp_page += 1; time.sleep(0.4)
tx_to = {}
src = collections.OrderedDict()
def add_src(key, kind, amount, day, address=""):
    s = src.setdefault(key, {"source": key, "kind": kind, "address": address, "imd_sent": 0.0, "transfers": 0, "first_day": day, "last_day": day})
    s["imd_sent"] += amount; s["transfers"] += 1; s["first_day"] = min(s["first_day"], day); s["last_day"] = max(s["last_day"], day)
launch_sent = collections.defaultdict(float)
for r in inflows:
    if r["from"] in executors:
        continue                                   # moves between the two executors, not new IMD
    if r["tx"].lower() in lp_burn_txs or r["method"] == BURN_ACCRUED_SEL:
        add_src("Community coins (LaunchpadHook)", "community coins", r["amount"], r["day"], "0x51768f5da32ba2008304cc81674da51acb802888"); continue
    if r["from"] == POOL_MANAGER:
        add_src("IMD/ETH pool burn hook & other Uniswap v4 swaps", "pool hook", r["amount"], r["day"], "0xc6c965bd164c483e87d0b550671798e9a3602840"); continue
    if r["tx"] not in tx_to:
        t = bs_tx(r["tx"]); time.sleep(0.3)
        tx_to[r["tx"]] = ((t.get("to") or {}).get("hash") or "").lower(), (t.get("to") or {}).get("name") or ""
    to_addr, to_name = tx_to[r["tx"]]
    lx = launch_art.get(to_addr) or launch_art.get(r["from"])
    if lx:
        hit = to_addr if to_addr in launch_art else r["from"]
        add_src(launch_label(lx, hit), "swarm launch", r["amount"], r["day"], hit)
        launch_sent[lx["launchNumber"]] += r["amount"]; continue
    if to_name and to_addr != ETH and to_addr != r["from"]:
        add_src(f"{to_name} (contract)", "contract", r["amount"], r["day"], to_addr); continue
    who = ens_name(r["from"]) or r["from_ens"] or r["from_name"] or (r["from"][:6] + "…" + r["from"][-4:])
    add_src(who, "contract" if r["from_contract"] else "wallet", r["amount"], r["day"], r["from"])
executor_sources = sorted(src.values(), key=lambda s: -s["imd_sent"])
for s in executor_sources:
    s["imd_sent"] = round(s["imd_sent"], 6)

print("community coins…", flush=True)
IDX = "https://imd-communitycoins-indexer.up.railway.app/graphql"
coins, after = [], None
while True:
    body = {"query": 'query($after:String){ coins(orderBy:"burnedImd", orderDirection:"desc", limit:500, after:$after){ items { address name symbol creator createdAt tradeCount volumeEth burnedImd } pageInfo { hasNextPage endCursor } } }',
            "variables": {"after": after}}
    for i in range(6):
        try:
            g = post(IDX, body); break
        except Exception:
            time.sleep(3 * (i + 1))
    else:
        raise RuntimeError("community coins indexer unreachable")
    c = g["data"]["coins"]; coins += c["items"]
    if not c["pageInfo"]["hasNextPage"]:
        break
    after = c["pageInfo"]["endCursor"]
burn_coins = []
for c in coins:
    burn_coins.append({"address": c["address"].lower(), "name": c["name"], "symbol": c["symbol"], "type": "Community coin",
                       "burn_feature": "LaunchpadHook burn fee on every trade's IMD leg",
                       "imd_to_burn": round(int(c["burnedImd"]) / 1e18, 6), "trades": int(c["tradeCount"]),
                       "volume_eth": round(int(c["volumeEth"]) / 1e18, 6),
                       "launched": iso(int(c["createdAt"]))[:10] if str(c["createdAt"]).isdigit() else ""})
BURN_WORDS = ("burn",)
for x in eth_launches:
    if x.get("status") != "live":
        continue
    burn_arts = [a["name"] for a in x.get("artifacts", []) if any(w in a["name"].lower() for w in BURN_WORDS)]
    sent = launch_sent.get(x["launchNumber"], 0.0)
    if not burn_arts and sent == 0:
        continue
    arts = x.get("artifacts", [])
    tok = next((a for a in arts if a.get("role") == "token"), None) or next((a for a in arts if a["name"] in burn_arts), None) or (arts[0] if arts else None)
    if not tok:
        continue
    hit_addr = next((a["address"].lower() for a in arts if a["name"] in burn_arts), tok["address"].lower())
    nm, tick = launch_identity(x, tok["address"].lower() if tok.get("role") == "token" else hit_addr)
    burn_coins.append({"address": tok["address"].lower(), "name": f"{nm} #{x['launchNumber']}", "symbol": tick or "—", "type": f"Swarm launch #{x['launchNumber']}",
                       "burn_feature": (", ".join(burn_arts) if burn_arts else "Sends IMD to the BurnExecutor"),
                       "imd_to_burn": round(sent, 6), "trades": None, "volume_eth": None,
                       "launched": (x.get("createdAt") or "")[:10]})
seen_addr, uniq = set(), []
for b in sorted(burn_coins, key=lambda b: -b["imd_to_burn"]):
    if b["address"] in seen_addr:
        continue
    seen_addr.add(b["address"]); uniq.append(b)
burn_coins = uniq
for i, b in enumerate(burn_coins):
    b["rank"] = i + 1

# ---- 7. sanity checks ------------------------------------------------------
problems = []
if abs(sum(v for _, v in eth_ev) - eth_bw) > 0.01: problems.append(f"eth history {sum(v for _, v in eth_ev):.4f} != dead balance {eth_bw:.4f}")
if abs(sum(v for _, v in rh_ev) - rh_bw) > 0.01: problems.append(f"rh history {sum(v for _, v in rh_ev):.4f} != burn wallets {rh_bw:.4f}")
if not (0 < destroyed < START_SUPPLY): problems.append("base destroyed out of range")
if native_fn < 0: problems.append("native burns negative")
if abs(locked - (eth_sup + rh_sup)) > 5000: problems.append(f"locked {locked:.2f} vs bridged supply {eth_sup + rh_sup:.2f}")
if len(history) < 1000 or history[-1]["day"] != today: problems.append("history incomplete")
if any(history[i]["base_burned"] + 1e-6 < history[i - 1]["base_burned"] for i in range(1, len(history))): problems.append("base history not monotonic")
if abs(sum(circ.values()) - base_sup) > 5000: problems.append(f"circulating per chain {sum(circ.values()):.2f} != Base supply {base_sup:.2f}")
if sum(circ.values()) > START_SUPPLY: problems.append("circulating exceeds starting supply")
if abs(sum(b["total_burned"] for b in breakdown) - (destroyed + base_bw + eth_bw + rh_bw)) > 0.01: problems.append("breakdown does not add up")
ext_in = sum(s["imd_sent"] for s in executor_sources)
if abs(ext_in - (sum(r["amount"] for r in bridges) + awaiting)) > 50: problems.append(f"executor inflows {ext_in:.2f} vs bridged+waiting {sum(r['amount'] for r in bridges) + awaiting:.2f}")
if len(burnkeepers) == 0 or abs(sum(k["imd_sent_to_burn"] for k in burnkeepers) - sum(r["amount"] for r in bridges)) > 0.01: problems.append("burnkeepers do not add up")
if len(coins) < 50: problems.append("community coins list looks incomplete")
if len(lp_burn_txs) == 0: problems.append("LaunchpadHook burn events missing")

summary = {"ok": not problems, "problems": problems, "as_of": bt,
           "total_burned_all_chains": round(destroyed + base_bw + eth_bw + rh_bw, 2),
           "base_native": round(native_fn + base_bw, 2), "base_executor": round(exec_burned, 2),
           "ethereum": round(eth_bw, 2), "robinhood": round(rh_bw, 2), "supply_now": round(base_sup, 2),
           "executor_bridges": len(bridges), "history_days": len(history), "executors": executors,
           "circulating_all_chains": round(sum(circ.values()), 2), "burnkeepers": len(burnkeepers),
           "executor_sources": len(executor_sources), "burn_coins": len(burn_coins), "executor_inflows": round(ext_in, 2)}
json.dump(summary, open(os.path.join(OUT, "summary.json"), "w"), indent=1)
print(json.dumps(summary, indent=1))
if problems:
    sys.exit(2)
for name, obj in [("imd-burns.json", burns), ("imd-base-split.json", base_split), ("imd-supply.json", supply),
                  ("imd-executor-bridges.json", bridges), ("imd-burn-breakdown.json", breakdown),
                  ("imd-burnkeepers.json", burnkeepers), ("imd-executor-sources.json", executor_sources),
                  ("imd-burn-coins.json", burn_coins)]:
    json.dump(obj, open(os.path.join(OUT, name), "w"), indent=1)
json.dump(history, open(os.path.join(OUT, "imd-burn-history.json"), "w"), separators=(",", ":"))
print("wrote files to", OUT)
