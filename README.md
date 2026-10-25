# IMD tokens burned

A static dashboard of every IMD token burned on Base, Ethereum and Robinhood Chain.

- `dist/` is the site, served as it is: `index.html`, `fonts.css` (IBM Plex Mono, SIL OFL 1.1),
  `d3.v7.9.0.min.js` (ISC) and `data/*.json`, the ten files the page reads from its own origin.
- `npm run build` refreshes `dist/data/` from public sources (`node refresh/refresh.mjs dist/data`). It replaces
  the files only when every sanity check passes, and otherwise keeps them and records why in
  `dist/data/imd-refresh-status.json`.
- `refresh/refresh_imd.py` is the original Python refresh (needs `pycryptodome`). `refresh/refresh.mjs` and `refresh/keccak.mjs` are
  its Node port, written by the IMD swarm in launch-2523 (commit b829e62, 2026-10-23, compared against the Python output there);
  `refresh/PORT.md` describes the port. Both scripts start from the two known BurnExecutors and add a contract that
  Blockscout lists under that name only when its `token()` is IMD and its runtime bytecode equals a known executor's (2026-10-25).

Burn definitions: Base burns = 10,000,000 minted - Base totalSupply + Base burn wallets; Ethereum and
Robinhood Chain = tokens in 0x...dEaD, 0x...0000 and 0x...0001. BurnExecutor share = IMD bridged by the
Ethereum BurnExecutors to the Base burn receiver and burned there. Bridging itself is not burning.
