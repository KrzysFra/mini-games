# Mini Games

Browser-based multiplayer mini-games collection. Early development stage.

## Stack
- **Client**: Phaser 4 (TypeScript), bundled by Vite 8
- **Server**: Colyseus 0.18 (`colyseus`, `@colyseus/schema` v5), Express 5
- **Runtime**: Node >= 22, ESM (`"type": "module"`)
- **Deploy**: Colyseus Cloud — client and server ship together as one app (pm2 via `ecosystem.config.cjs`,
  runs `dist/server/server.mjs`). Keep it a single deployable; don't split client/server hosting.

## Commands
- `npm start` / `npm run dev` — Vite dev server; the `colyseus/vite` plugin runs the server in-process
  (one port, rooms hot-reload, client does full reload)
- `npm test` — mocha + `@colyseus/testing` against the real server (`test/*.test.ts`)
- `npm run build` — builds `dist/client` and `dist/server`
- `npm run loadtest` — `@colyseus/loadtest` with `loadtest/example.ts`
- Dev-only routes: `/playground`, `/monitor` (disabled when `NODE_ENV=production`)

## Structure
```
src/server/            Colyseus server — app.config.ts (Vite serverEntry), rooms/, rooms/schema/
src/client/            Phaser client — main.ts (entry, game switcher), core/ (shared client services)
src/client/core/network.ts   the single shared Colyseus Client (same-origin endpoint)
src/client/sandbox/    experiments & prototypes (examples/, pill-move/) — not real games
src/client/game/scenes Phaser template scenes (currently unused)
src/shared/            code used by BOTH sides: constants + pure simulation logic
public/                static assets (served at /, e.g. 'assets/block.png')
test/                  server tests
```
Target layout as games are added: `server/games/<game>/`, `client/games/<game>/`, `shared/games/<game>/`.

### Import rules
- `client/` and `server/` may import from `shared/`, **never from each other** (keeps server-only
  `colyseus` code out of the browser bundle).
- Client code uses `@colyseus/sdk`; server code uses `colyseus` / `@colyseus/schema`.
- Use the shared `client` from `src/client/core/network.ts` — don't create new `Client` instances.

## Conventions
- **Client switching**: each client game/scene exports a `config<Name>` (`Types.Core.GameConfig`
  partial, at minimum `{ scene }`) and is registered in the `games` array in `src/client/main.ts`.
  `main.ts` provides the common config (1920×1080, `Scale.FIT`, `parent: 'game-container'`).
  Ctrl+←/→ cycles games.
- **Server rooms**: registered in `src/server/app.config.ts` via `defineRoom`. State is defined with the
  `schema({...})` / `t.*` API plus `SchemaType<>` type exports (not decorators).
- **Player input**: sent through `Room.defineInput()` with a `sanitize` clamp — never trust client values.
  Simulation runs on a fixed timestep (`setFixedTimestep`, `TICK_RATE` in `shared/constants.ts`).
- **Shared simulation code** (`src/shared/`) must be pure: a function of (state, input, dt) only — no
  clocks, randomness, or outside reads — so client prediction matches the server. Use structural
  interfaces, not schema classes.
- **Code style**:
  - Client: 2-space indent, single quotes, no semicolons, extensionless relative imports.
  - Server/shared/test: 2-space indent, double quotes, semicolons, relative imports with `.js` extension.
- TypeScript: `strict` but `strictNullChecks: false`; `experimentalDecorators` on,
  `useDefineForClassFields: false` (required by Colyseus schema).

## Notes
- The server room (`MyRoom`, `my_room`) and `/api/hello`, `/hi` routes are still from the
  `create-colyseus-app` template.
- The client does not connect to the server yet.
- `tsc --noEmit` currently reports implicit-any errors in `src/client/sandbox/pill-move/stick-man.ts`.
