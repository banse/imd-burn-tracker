# Node refresh port

Run with Node 22 or newer; no install step and no runtime dependencies:

```sh
node refresh/refresh.mjs dist/data
```

`package.json`, `dist/` and `refresh_imd.py` are unchanged. The port rebuilds the
reference's ten outputs: `imd-burns.json`, `imd-base-split.json`,
`imd-supply.json`, `imd-executor-bridges.json`, `imd-burn-breakdown.json`,
`imd-burnkeepers.json`, `imd-executor-sources.json`, `imd-burn-coins.json`,
`imd-burn-history.json`, and `summary.json`. It also writes the site's existing
one-row-array status interface in `imd-refresh-status.json`.

## Sources and behavior

The defaults are the Python reference's public endpoints:

| Purpose | Sources, in fallback order |
| --- | --- |
| Base calls | `https://base-mainnet.public.blastapi.io`, `https://mainnet.base.org`, `https://base.gateway.tenderly.co` |
| Base snapshot | `https://base-rpc.publicnode.com`, `https://mainnet.base.org` |
| Base archive batches | `https://base-mainnet.public.blastapi.io`, `https://mainnet.base.org` (alternating starting endpoint per chunk) |
| Ethereum RPC / ENS | `https://ethereum-rpc.publicnode.com` |
| Robinhood Chain RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Ethereum explorer | `https://eth.blockscout.com` (v2 search, logs, transfers, transactions, tokens; v1 LaunchpadHook logs) |
| Swarm launches | `https://api.imd.fun/launches` |
| Community coins indexer | `https://imd-communitycoins-indexer.up.railway.app/graphql` (the reference's communitycoins.imd.fun indexer) |

The snapshot pins calls to each chain's captured head. History uses 20-call Base
archive batches, paginated Ethereum burn-wallet transfers, and 100,000-block
Robinhood log chunks with four workers. Batch results are matched by ID, with
additional rejection of duplicate, missing or invalid IDs. Pagination, stable
sorts and insertion order mirror Python. Reverse ENS names require a confirming
forward resolution. Failed executor discovery falls back to the two known
executors; failed ENS and token trackers fall back to the reference's address,
explorer or artifact labels. These optional failures have the same semantics as
Python. Required source failures reject the refresh.

All fourteen reference sanity conditions are retained: Ethereum and Robinhood
history balances, destroyed-supply range, nonnegative native burns, bridge
backing, history length/end date and monotonicity, per-chain circulation sum and
ceiling, route totals, executor inflows, keeper totals, community list size and
LaunchpadHook events. Amounts use the same binary64 arithmetic and Python-style
rounding to six decimals (two in summary). JSON preserves field order, float
`.0`, scientific notation, ASCII escapes, one-space indentation and compact
history. `keccak.mjs` implements Keccak-256 with Ethereum padding, selectors and
literal UTF-8 ENS namehash, without using SHA3-256 or any package.

No final data file is opened for writing during collection or validation.
All ten serialized files are staged on the output filesystem before publication;
previous files are backed up during renames and restored on a publication error.
A source or sanity failure preserves all ten old data files, including summary,
records `last_result: "failed"` with the reason in status `message`, preserves
previous `last_success_at` and `data_as_of`, and exits 0. Success records
`last_result: "refreshed"` with new timestamps and `data_as_of`. An empty output
directory receives only failure status when collection fails. The previous
Python script can write a failed summary; the Node port deliberately preserves
that file as requested. Unwritable output/status paths are logged and also do
not cause a nonzero build exit.

RPC retry counts, backoffs and request deadlines match the reference: ten RPC
attempts, twelve archive batch attempts, eight GET attempts, six indexer POST
attempts; POST timeout 60 seconds and GET timeout 90 seconds. Optional token
trackers make one attempt. Normal inter-page/request pauses are preserved.

## Environment overrides

Each RPC override replaces its whole fallback list with a comma-separated list
of HTTP(S) URLs (spaces around entries are allowed):

| Variable | Replaces |
| --- | --- |
| `IMD_RPC_BASE` | Base calls; also the archive list unless separately overridden |
| `IMD_RPC_BASE_LATEST` | Base snapshot RPCs |
| `IMD_RPC_BASE_HISTORY` | Base archive batch RPCs only |
| `IMD_RPC_ETH` | Ethereum RPCs, including ENS |
| `IMD_RPC_RH` | Robinhood Chain RPCs |

For local integration fixtures, `IMD_BLOCKSCOUT_URL` replaces the explorer origin,
`IMD_LAUNCHES_URL` the launches endpoint, and `IMD_INDEXER_URL` the GraphQL endpoint.
Normal operation needs no variables. There is no fixture data or source fallback
bundled into production execution.

To test an outage against a disposable copy of existing outputs:

```sh
IMD_RPC_BASE_LATEST=http://127.0.0.1:1 node refresh/refresh.mjs OUT
```

This exercises the real CLI and normal ten-attempt retry schedule (about 83
seconds for immediate connection failures). Expect exit 0, unchanged data
bytes, and failed status mentioning `base_latest eth_blockNumber failed`.

## Reproducible checks

```sh
node --check refresh/refresh.mjs
node --check refresh/keccak.mjs
node refresh/check.mjs
```

The offline checks use a clearly synthetic local HTTP server with the same
JSON-RPC, Blockscout, launches and GraphQL interfaces. They cover the three
required Keccak vectors, `abc`, `eth`/empty namehash, multi-block Keccak inputs
of 135/136/137/272 bytes, half-way rounding, UTF-8 error handling, all pagination
paths, shuffled/duplicate batch IDs, RPC fallback, four-worker log collection,
source attribution, ENS confirmation/rejection, optional metadata fallbacks,
stable ranking and address deduplication. They also check failed RPCs,
nonmonotonic history, mismatched Robinhood history, missing burn events,
incorrect executor totals, a short community list, successful status, failure
status retention, all-ten-file byte preservation and staging failure cleanup.
Only the test harness substitutes an immediate pause; production delays remain.

If Python and its existing reference-only `pycryptodome` dependency are available:

```sh
node refresh/check.mjs --python
```

This additionally runs the **unmodified** Python file through `runpy` with HTTP
requests redirected to that same local fixture server and sleeps disabled. All
ten outputs must match byte for byte, not just numeric values. Python is used
only by this optional differential test, never by `refresh.mjs` or the build.

Live outputs can be compared without dependencies:

```sh
node refresh/refresh.mjs NODE_OUT
python3 refresh/refresh_imd.py PYTHON_OUT
node refresh/compare.mjs NODE_OUT PYTHON_OUT
```

`compare.mjs` reports every field/value difference, row count and key order;
it does not suppress changing blocks, timestamps or balances. It exits nonzero
for missing files or differing structure. Value differences need inspection
against the two snapshots because the chains and indexers can advance.

## Recorded validation (2026-10-23 UTC)

- Node 22.23.4: syntax checks and offline component checks passed.
- All ten fixture outputs matched the unchanged Python 3.12.3 reference byte for byte.
  Another 1,006 deterministic values matched Python rounding at both two and six decimals.
- Real Node 22 CLI with an unreachable local Base-snapshot RPC exited 0. All nine seeded
  static-site data files remained byte-identical; absent `summary.json` stayed
  absent. Status recorded the failed RPC reason and retained the previous
  success timestamp and data timestamp. The fixture test separately checked
  preservation of all ten outputs, including an existing summary.

### Sequential live comparison

Executed the normal CLI under Node 24.21.0, immediately followed by the unchanged
reference under Python 3.12.3, immediately followed by the final implementation
under **Node 22.23.4**. All three completed successfully, with `ok: true` and no
sanity problems. No URLs, RPC results or API responses were substituted. The
optional Python dependency was used only for reference verification, outside
the deliverable; the Node build has no such dependency.

The final Node 22 versus Python comparison:

| File | Node 22 rows | Python rows | Different values | Byte equal |
| --- | ---: | ---: | ---: | --- |
| imd-burns.json | 3 | 3 | 6 | no |
| imd-base-split.json | 2 | 2 | 0 | yes |
| imd-supply.json | 1 | 1 | 1 | no |
| imd-executor-bridges.json | 79 | 79 | 0 | yes |
| imd-burn-breakdown.json | 4 | 4 | 0 | yes |
| imd-burnkeepers.json | 15 | 15 | 0 | yes |
| imd-executor-sources.json | 10 | 10 | 0 | yes |
| imd-burn-coins.json | 218 | 218 | 0 | yes |
| imd-burn-history.json | 1150 | 1150 | 0 | yes |
| summary.json | object | object | 1 | no |

All ten files had identical keys, key order, row counts and row order. All
amounts, supplies, history values, ranks, counts, labels and addresses matched
exactly. The eight differences were solely three newer chain heads and five
associated `as_of` fields (the three burn rows, supply row and summary). The
initial Node 24 versus Python comparison had the same equality pattern, also
with no amount differences.

| Chain | Initial Node 24 block / timestamp | Python block / timestamp | Final Node 22 block / timestamp |
| --- | --- | --- | --- |
| Base | 52999914 / 2026-10-23T20:59:35Z | 53000042 / 2026-10-23T21:03:51Z | 53000200 / 2026-10-23T21:09:07Z |
| Ethereum | 26257874 / 2026-10-23T20:59:23Z | 26257896 / 2026-10-23T21:03:47Z | 26257922 / 2026-10-23T21:08:59Z |
| Robinhood Chain | 96235067 / 2026-10-23T20:59:35Z | 96237571 / 2026-10-23T21:03:51Z | 96240651 / 2026-10-23T21:09:06Z |

The shared summary had total burned **2,909,085.30 IMD**, Base supply
**7,091,869.01 IMD**, 79 bridges, 15 keepers, 10 executor sources, 218 coins and
1,150 history days. `refresh/compare.mjs` produced both comparisons and exited 0.
The final Node 22 run additionally wrote `last_result: "refreshed"` status.

Final scope check: every new file is under `refresh/`; all tracked files,
including the Python reference, package file and static site, remain unchanged.
