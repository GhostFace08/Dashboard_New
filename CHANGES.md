# Changes in this pass

## Bugs fixed
1. **AdminMiddleware stub responses** — `/api/network-devices` and `/api/processes` now
   actually read `backend/data/network-devices.json` / `processes.json` (real data that
   was sitting on disk, completely unused, since the stub never touched the filesystem).
2. **Dead `DashboardMiddleware.java`** (port 8080) — deleted, along with all stale `.class`
   files across the middleware folder.
3. **Shared `PORT` env var** — every service now has its own name:
   `OBSERVABILITY_PORT`, `CAPACITY_PORT`, `ADMIN_PORT`, `SETTINGS_PORT`, `TOPOLOGY_PORT`,
   `CHAT_PORT`.
4. **Stale/incorrect doc comments** in `api.js` — fixed.
5. **Settings schema migration shim** — `registry.payloadIsUpload` → `registry.usesPayload`
   is now normalized on load in `settings.js`.
6. **User Management ID collision** — `user_management.js` now mixes `Date.now()` into
   generated ids, same fix `topology.js` already had.
7. **`topology.json` was orphaned** — now the real, live backing store for the Topology
   page via `TopologyMiddleware`'s new `GET/PUT /api/topology`.
8. **`chatstats.json` fetched via a fragile raw relative path** — moved to a real endpoint,
   `GET /api/chat-stats` on `ObservabilityMiddleware`.
9. **Capacity forecast** — `CapacityMiddleware` now runs the real port of capacity.js's
   PRNG + series generator + all four forecast algorithms; `capacity.js` calls it for
   real, falling back to local computation only if the endpoint is unreachable.

## New settings-file layout (backend/data/)
| File | Contents |
|---|---|
| `conf.properties` | General section |
| `mcpconf.ini` | Per-server "Details" tab (JSON content; filename changed per spec, format stayed JSON since a flat properties format can't express nested arrays like `registry.paths` cleanly) |
| `capacity.ini` | Left intentionally blank per instruction |
| `llm.ini` | AI & Models section + per-server Keywords tab (merged) |
| `rag.ini` | Retrieval (RAG) section |
| `performance.ini` | Performance section |
| `chat.ini` | Advanced section |
| `categorization.json` | Per-server Categorization tab (unchanged) |
| `mapping.json` | Per-server Mapping/Dashboards/Time-Mapping tabs — **previously an orphaned, unwritten legacy file**; this data actually lived embedded inside `mcpservers.json`. Now genuinely split out and live. |

Deleted (superseded): `mcpservers.json`, `keywords.json`, `conf.ini`, `mcpconf.properties`,
`apmconf.properties`, `category.json` (the last was already dead/orphaned, referenced only
in comments, not in your spec).

New: `users.json` (real backing store for User Management, replacing localStorage-only).

## Data enrichment
`topology.json` — each application now has **multiple topologies** (2 each for the
original 3 apps) and a **4th application** (Inventory Service) was added with 2
topologies of its own, each with multiple host/procgroup/service nodes and edges.

## Topology page — new features
- **Update Topology** button: diffs the current in-browser (possibly unsaved) graph
  against the last real save on the server, shows a popup listing every added/removed/
  changed app, topology, node, and edge. Confirming pushes the change to
  `backend/data/topology.json` via `TopologyMiddleware`. If nothing changed, shows an
  "already up to date" toast instead of an empty diff.
- **Undo / Redo** buttons for unsaved changes, implemented as a history stack piggybacking
  on the existing `saveStore()` call sites (no rewrite of the ~12 places that mutate the
  graph was needed).

## Known limitations / assumptions made
- `mcpconf.ini` keeps JSON content despite the `.ini` extension — noted inline in code.
  A true flat ini/properties format can't cleanly represent the nested `registry`/
  per-server object shape without a custom encoding.
- `llm.ini`'s `[keywords]` section is ini-style (`serverId = kw1, kw2, ...`); parsing is
  handled by `parseKeywordsFromLlmIni()` in `settings.js`.
- Capacity & Forecasting section fields are not wired to any settings file — `capacity.ini`
  exists as a placeholder only, per your explicit instruction ("leave blank").
- Not a full line-by-line audit of every remaining page (`ai_chat.js`, `about_faq.js`,
  etc.) beyond what came up during this pass — see the conversation history for exactly
  what was and wasn't checked.
