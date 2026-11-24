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
                       placeholder/PlaceholderGame.ts (one dot per player, any key → random color),
                       car-roquelike/ (see car-roquelike in Notes: CarRoquelikeGame.ts (the scene), RoadView.ts
                       (dirt + road pieces), DestructionView.ts (void + crumbling edge), playerInput.ts
                       (keyboard/gamepad → `GameInput`), CpuDrivers.ts)
src/server/games/      server side of mini-games that simulate: registry.ts (`MINI_GAMES` id → `ServerMiniGame`
                       factory), types.ts, car-roquelike/CarRoquelikeSim.ts (authoritative matter world)
src/shared/games/      per-game shared code: car-roquelike/ (constants, controls.ts (input → `CarControls`),
                       physics.ts (the `matter-js` world), handling.ts (axle-model tyre forces, `driveCar`),
                       map.ts, destruction.ts, road.ts)
src/server/rooms/MainLobbyRoom.ts   built-in LobbyRoom + player names (join option `name`, `setName` msg)
src/server/rooms/GameSelectionRoom.ts   the game room (type `my_room`): selection → playing
src/server/rooms/SandboxRoom.ts   dev-only `sandbox` room (extends GameSelectionRoom)
src/shared/            code used by BOTH sides: constants, player-name sanitizing, games.ts (`MINI_GAMES`
                       list: car-roquelike first/default, then placeholders),
                       pure simulation logic
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
  `GameSelectionRoom` has one input schema for every mini-game, `GameInput` (`x`, `y` axes clamped to -1..1,
  `buttons` bitmask, see `INPUT_BUTTONS`); an empty tick repeats the player's last input (`idle`). Its fixed
  tick steps the running `ServerMiniGame` (created by `startGame()` when `phase` becomes `"playing"`,
  disposed by `stopGame()`), which takes exactly one input per player per tick (`inputs.get(id).next()`).
- **Physics engines for multiplayer**: use standalone `matter-js` in `src/shared/games/<game>/`, not
  Phaser's Matter plugin (Phaser steps it on its render clock; rollback needs fixed-dt stepping and
  replay, and the server needs the same engine). Phaser only draws.
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
  Clients follow it: GameSelectionRoom starts the selected game's scene via the registry (`car-roquelike` →
  `CarRoquelikeGame`, the placeholder entries → `PlaceholderGame`), which goes back if the phase returns to `"selection"`.
- Placeholder game messages (no payload, `"playing"` only): `changeColor` — the server picks a random
  `Player.color`; dots start at `DEFAULT_DOT_COLOR` (red). `escape` (Escape key) — sets `Player.escaped`
  ("ESC" in the dot); once every player has escaped (checked on `escape` and on leave) the phase returns
  to `"selection"` and everyone's `ready`/`escaped`/`color` reset.
- **car-roquelike**: server-authoritative matter world (`CarRoquelikeSim`, 30 inputs/s, physics
  sub-stepped ×2 = 60 Hz, `patchRate` = one tick); every car's full state is in `state.cars` (by sessionId,
  `seat` picks spawn/color; cleared when the game ends). The client runs the same `physics.ts` world and
  predicts its own car with `predict.sim` (`@colyseus/sdk` `Predict`): it adopts all server cars on each
  ack and replays unacked inputs. Other cars are predicted in the same world with the input the server
  last applied to them (`Car.inX`/`inY`/`inButtons`), and every car is drawn from the predicted world:
  the sim's pose has a fixed x/y/angle slot per seat, so the SDK interpolates and smooths all of them
  (`attachAll('cars', lerp)` is only the fallback before our car exists). Steering is
  directional: input (`x`, `y`) is the world/screen direction to drive in (+y down; length = throttle,
  0 = brake), and `resolveCarControls` steers toward it (proportional to the angle off, full at
  `CAR_STEER_FULL_ANGLE`), with an automatic handbrake beyond `CAR_AUTO_HANDBRAKE_ANGLE` (80°); there is
  no reverse. `INPUT_BUTTONS.ACTION` forces the handbrake. Keyboard (WASD/arrows), D-pad and `pad1`'s left
  stick (round deadzone) are summed and capped at length 1; A/Space = handbrake, Start/Back = escape.
  Cars without an input coast (wheels straight). Handling (`handling.ts`, `driveCar`, called by
  `stepCarWorld` before each matter update with the resolved controls and the top speed there): an axle
  ("bicycle") model driven by matter forces. `forwardSpeedChange` at the center (engine only below
  `throttle × top speed`, drag above it, brake, handbrake bleed), plus `applyAxleGrip` at the front axle
  (wheels turned by steer × full lock) and the rear axle (`±CAR_AXLE_OFFSET`). Each cancels
  `CAR_TYRE_GAIN` of the axle's sideways speed (v + ω × r) via an impulse with the effective mass at that
  point, capped at `CAR_AXLE_GRIP_MAX` (lowered while that axle slides, `CAR_SLIDE_*`; rear
  `CAR_HANDBRAKE_REAR_GRIP_MAX` with handbrake), applied as `Body.applyForce` at the axle (matter adds
  `F/m·dt²`), so matter turns the car from it; a hit that overpowers the grip makes the car slide and
  spin, with no extra state. Full lock is speed-sensitive: the wheel angle that turns at
  `CAR_TURN_RATE` (`speed × tan(angle) / wheelbase`), at most `CAR_MAX_WHEEL_ANGLE`
  (×`CAR_HANDBRAKE_TURN_BOOST` with handbrake). World: an endless random road (`road.ts`):
  `ROAD_WIDTH` 400 wide, straights 400..2000 and corners of radius 400..2000 turning 0..120°, from
  `state.roadSeed` (new per round). It starts at the origin with a fixed 2000 straight north (the 2×4
  spawn grid is on it), then may go any direction. It is one fixed sequence per seed, generated on
  demand: `maintainRoad` (server each tick, client each frame) keeps it `ROAD_AHEAD` (4000) beyond the
  leading car and prunes old data. Road more than `ROAD_KEEP_BEHIND` (1000) behind the front is deleted
  (dirt again; `roadTail`). Determinism however far/when each side generated: a new piece keeps 1200
  clear only of the last `CLEARANCE_WINDOW` (12000) of road (older ground is reused), and the generator
  runs `COMMIT_BUFFER` (15000) beyond the committed road it hands out, backtracking out of dead ends
  only within that (stuck at committed road, it forces a piece: rarely, a crossing). Only committed
  road is used. Lookups: centerline samples (absolute indices, `sampleBase` after pruning) in a spatial
  grid: `isOnRoad(road, x, y, frontS)`, `roadDistanceAt`, `chunkOwnerS` (a chunk's owner = nearest
  sample within `ownerWindowStart`, deleted road included; memoized, updated incrementally). The server
  builds its own `buildRoad` per room; the client uses `getRoad` (cached per seed). Endless dirt
  everywhere else (no walls, no camera bounds); on dirt the top speed is ×`DIRT_SPEED_FACTOR` (0.5) and
  faster cars roll down to it. `CarWorld.road`/`frontS` carry the road into the physics. The client
  draws the dirt as a TileSprite re-fitted to the view each frame, and the road as one Graphics per
  committed piece (added as committed, destroyed once deleted, the tail piece redrawn cut at the tail),
  culled to the view.
  Rounds: `state.carRoundTick` counts ticks; the first `COUNTDOWN_TICKS` are a countdown with physics
  frozen. Then the destruction front (`destruction.ts`) moves along the road from its start at
  `DESTRUCTION_SPEED`: a chunk is void once the front passes its owner's distance along the road (dirt
  goes with the stretch of road beside it), and restored once its owner is deleted, so the void is a
  band following the front. The front edge is ragged: per-`CHUNK_SIZE`-chunk break points
  (`chunkBreakS`, integer-hash noise). A car whose center is over a void chunk, or outside the shared
  camera's view (`isOutOfView`, `camera.ts`), is eliminated (`stepCarRound` removes its body; `Car.eliminated`). When every car is out, the sim restarts the round
  (`carRound++`, new road, cars back at their spawns). Eliminated players' inputs are still consumed so
  their acks advance. The client predicts the round tick with its inputs (in the sim world, adopted from
  `carRoundTick`), draws the front at that predicted time (fallen chunks as merged void runs,
  cracking/falling chunks at the edge).
  Room tests skip the countdown by setting `state.carRoundTick`. The scene enables gamepads itself via
  `input: { gamepad: true }` in its settings (missing from Phaser 4's `SettingsConfig` type, so it's widened). Camera: the same for everyone, north-up, fixed zoom (`CAMERA_ZOOM`), centered on the road `CAMERA_AHEAD_OF_FRONT` (1000) ahead of the predicted front
  (`cameraCenter`); its geometry is shared (`shared/games/car-roquelike/camera.ts`, `SCREEN_WIDTH/HEIGHT` = the
  1920×1080 logical screen) so the server eliminates cars off it;
  the HUD is on a second camera (world and HUD in separate layers, each camera ignores the other).
  Velocities are matter units (px per 1000/60 ms), which is also the physics step.
  Physics tests: `car-roquelike-physics.test.ts` (controls, road, destruction, rounds) and
  `car-roquelike-handling.test.ts` (driving, grip, collisions).
- **Sandbox mode** (for developing a mini-game): put `VITE_SANDBOX=<MINI_GAMES id>` (or `true` for the
  default game) in `.env.local` (git-ignored) and restart `npm run dev`. Every client then skips the lobby:
  the Lobby scene `joinOrCreate`s the `sandbox` room (`filterBy(["game"])`, so all clients share one room)
  and starts the game scene directly. `SandboxRoom` starts in `"playing"` and stays there (all escaped →
  players reset and the game restarts, no return to selection). Its `onCreate` must not call
  `super.onCreate` (that breaks the `filterBy` matchmaking); it calls `startSimulationLoop()` instead. Max `MAX_PLAYERS_PER_ROOM` players; more are rejected with
  "Sandbox is full" (enforced in `onJoin`; `maxClients` is unlimited so joinOrCreate never opens a second
  room). Players without a valid name become "Player N". CPU drivers (car-roquelike): `CpuDrivers.ts` in
  the car scene keeps `SANDBOX_CPU_PLAYERS` (2) of them in the room. Each is an extra connection from
  that tab (`client.joinById(roomId, { cpu: true })`) that sends `GameInput` through `room.input()` at
  `TICK_RATE`, steering from its own copy of the state, so it gets the same network path and latency as a
  player. They aim at a point clamped inside the camera's view (less `VIEW_MARGIN`) and ease off the
  throttle near its edge (`stayInView`). The server names them "CPU N", sets `Player.cpu`, caps them (another tab tops up when the host
  tab leaves), holds no seat when one drops, and ignores them for "everyone escaped". The room is only registered when
  `NODE_ENV !== "production"`, and the client ignores `VITE_SANDBOX` outside `import.meta.env.DEV`.
- Player names: `sanitizePlayerName` / `isValidPlayerName` in `src/shared/player-name.ts`
  (`NAME_MIN_LENGTH` / `NAME_MAX_LENGTH` in `shared/constants.ts`); the server re-sanitizes everything.
- Right after `create`/`join`/`reconnect` resolves, `room.state` is an empty instance (fields undefined)
  until the first full state arrives. Locally it arrives before the next scene starts, on a real network it
  doesn't, so scenes' `state` getters return `undefined` until then (an exception in `create` kills the
  Phaser loop: frozen screen).
- Scenes must clean up on `destroy` as well as `shutdown`: Ctrl+←/→ destroys the whole game, which
  doesn't emit `shutdown`.
- Don't `boot()` a second test server in one mocha run (matchmaking breaks); use `testServer()`.
- `tsc --noEmit` currently reports implicit-any errors in `src/client/sandbox/pill-move/stick-man.ts`.
