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
src/client/core/player-name.ts   player name persisted in localStorage (load/save, failure-safe)
src/client/core/ui.ts   shared menu widgets: createButton / setButtonEnabled / setButtonLabel, textStyle, titleStyle
src/client/core/sandbox.ts   `SANDBOX_GAME` from `VITE_SANDBOX` (dev only), see Sandbox mode in Notes
src/client/core/session.ts   the game room the player is in (`currentRoom`), outlives scenes; keeps its
                             reconnection token in sessionStorage so the Lobby resumes it after a reload
src/client/sandbox/    experiments & prototypes (examples/, pill-move/) — not real games
src/client/game/scenes Lobby.ts (startup scene: connects to the `lobby` room, name input, live room list,
                       create/join), GameSelectionRoom.ts (after entering a room: leave/ready buttons, mini-game picker,
                       8 player slots with ready state — all rendered from the room state)
src/client/games/      mini-game scenes: registry.ts (`MINI_GAMES` id → scene key + lazy `import()`),
                       MiniGameScene.ts (base: room handlers, back to selection/lobby),
                       placeholder/PlaceholderGame.ts (one dot per player, any key → random color)
src/server/rooms/MainLobbyRoom.ts   built-in LobbyRoom + player names (join option `name`, `setName` msg)
src/server/rooms/GameSelectionRoom.ts   the game room (type `my_room`): selection → playing
src/server/rooms/SandboxRoom.ts   dev-only `sandbox` room (extends GameSelectionRoom)
src/shared/            code used by BOTH sides: constants, player-name sanitizing, games.ts (`MINI_GAMES`
                       list, placeholders for now), pure simulation logic
public/                static assets (served at /, e.g. 'assets/block.png')
test/                  server tests; all files share one booted server via `test/server.ts`
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
  Ctrl+←/→ cycles games (ignored while an `<input>` has focus). The first entry is the startup scene.
- **Mini-games**: one persistent Phaser `Game` runs Lobby → GameSelectionRoom → mini-game; don't create a
  new `Game` per mini-game (destroying it leaves the room). A mini-game extends `MiniGameScene`
  (`createGame` / `renderState`, optional `onDroppedChanged` / `disposeGame`) and is listed in
  `src/client/games/registry.ts`; GameSelectionRoom loads and `scene.add`s it when `phase` becomes `"playing"`.
  Physics is per scene: `super({ key, physics: { default: 'arcade' | 'matter', ... } })`, none if omitted;
  external engines are created in `createGame`, stepped in `update`, freed in `disposeGame`.
- **HTML inputs in scenes**: append the element to `this.game.domContainer` with absolute positioning in
  game coordinates (the container is game-sized and CSS-scaled with the canvas), set
  `pointer-events: auto`, remove it on scene `shutdown` and `destroy`, and add `dom: { createContainer: true }` to the
  scene's config. Don't use Phaser `DOMElement` (`this.add.dom`) in scenes with extra cameras: it is
  repositioned per camera, and any camera that `ignore`s it sets `display: none` on it.
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
- The `/api/hello`, `/hi` routes are still from the `create-colyseus-app` template.
- Connection flow: the Lobby joins `lobby` (with `{ name }`) on startup; the server forces the listing
  filter to `my_room`. Create/Join call `client.create('my_room')` / `joinById` with `{ name }`, then
  the Lobby leaves `lobby` and starts `GameSelectionRoom`. `GameSelectionRoom` (server) rejects joins without a valid name
  and puts a display `title` ("<name>'s room") in its metadata — the listing's `name` is the room type.
- Game selection room messages: `setReady` (boolean) and `selectGame` (a `MINI_GAMES` id; any player may
  switch, and switching resets everyone's `ready`). Both only apply while `phase` is `"selection"`.
- Room `phase`: `"selection"` → `"playing"` once every player is ready (checked on `setReady` and on leave).
  Clients follow it: GameSelectionRoom starts the selected game's scene via the registry (every
  `MINI_GAMES` entry maps to `PlaceholderGame` for now), which goes back if the phase returns to `"selection"`.
- Placeholder game messages (no payload, `"playing"` only): `changeColor` — the server picks a random
  `Player.color`; dots start at `DEFAULT_DOT_COLOR` (red). `escape` (Escape key) — sets `Player.escaped`
  ("ESC" in the dot); once every player has escaped (checked on `escape` and on leave) the phase returns
  to `"selection"` and everyone's `ready`/`escaped`/`color` reset.
- **Sandbox mode** (for developing a mini-game): put `VITE_SANDBOX=<MINI_GAMES id>` (or `true` for the
  default game) in `.env.local` (git-ignored) and restart `npm run dev`. Every client then skips the lobby:
  the Lobby scene `joinOrCreate`s the `sandbox` room (`filterBy(["game"])`, so all clients share one room)
  and starts the game scene directly. `SandboxRoom` starts in `"playing"` and stays there (all escaped →
  players reset, no return to selection). Max `MAX_PLAYERS_PER_ROOM` players; more are rejected with
  "Sandbox is full" (enforced in `onJoin`; `maxClients` is unlimited so joinOrCreate never opens a second
  room). Players without a valid name become "Player N". The room is only registered when
  `NODE_ENV !== "production"`, and the client ignores `VITE_SANDBOX` outside `import.meta.env.DEV`.
- Player names: `sanitizePlayerName` / `isValidPlayerName` in `src/shared/player-name.ts`
  (`NAME_MIN_LENGTH` / `NAME_MAX_LENGTH` in `shared/constants.ts`); the server re-sanitizes everything.
- Scenes must clean up on `destroy` as well as `shutdown`: Ctrl+←/→ destroys the whole game, which
  doesn't emit `shutdown`.
- Don't `boot()` a second test server in one mocha run (matchmaking breaks); use `testServer()`.
- `tsc --noEmit` currently reports implicit-any errors in `src/client/sandbox/pill-move/stick-man.ts`.
