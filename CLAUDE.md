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
src/client/core/ui.ts   shared menu widgets: createButton / setButtonEnabled / setButtonLabel, textStyle, titleStyle,
                        HTML ones for panels over the game: createHtmlButton, htmlInputStyle
src/client/core/sandbox.ts   `SANDBOX_GAME` from `VITE_SANDBOX` (dev only), see Sandbox mode in Notes
src/client/core/session.ts   the game room the player is in (`currentRoom`), outlives scenes; keeps its
                             reconnection token in sessionStorage so the Lobby resumes it after a reload
src/client/sandbox/    experiments & prototypes (examples/, pill-move/) — not real games
src/client/game/scenes Lobby.ts (startup scene: connects to the `lobby` room, name input, live room list,
                       create/join), GameSelectionRoom.ts (after entering a room: leave/ready buttons, mini-game picker,
                       8 player slots with ready state — all rendered from the room state; gear button top right
                       → SettingsPanel.ts, an HTML panel with the selected game's settings editor)
src/client/games/      mini-game scenes: registry.ts (`MINI_GAMES` id → scene key + lazy `import()`),
                       MiniGameScene.ts (base: room handlers, back to selection/lobby),
                       settings.ts (`MINI_GAMES` id → room settings editor; none = "No settings available"),
                       placeholder/PlaceholderGame.ts (one dot per player, any key → random color),
                       car-roquelike/ (see car-roquelike in Notes: CarRoquelikeGame.ts (the scene), RoadView.ts
                       (dirt + road pieces), DestructionView.ts (void + crumbling edge), playerInput.ts
                       (keyboard/gamepad → `GameInput`), CpuDrivers.ts, SettingsEditor.ts (obstacle weights table))
src/server/games/      server side of mini-games that simulate: registry.ts (`MINI_GAMES` id → `ServerMiniGame`
                       factory), types.ts, car-roquelike/CarRoquelikeSim.ts (authoritative matter world)
src/shared/games/      per-game shared code: car-roquelike/ (constants, controls.ts (input → `CarControls`),
                       physics.ts (the `matter-js` world), handling.ts (axle-model tyre forces, `driveCar`),
                       map.ts, destruction.ts, road.ts, obstacles.ts (obstacle cars: kinds, spawn rolls, driving))
src/server/rooms/MainLobbyRoom.ts   built-in LobbyRoom + player names (join option `name`, `setName` msg)
src/server/rooms/GameSelectionRoom.ts   the game room (type `my_room`): selection → playing
src/server/rooms/SandboxRoom.ts   dev-only `sandbox` room (extends GameSelectionRoom)
src/shared/            code used by BOTH sides: constants, player-name sanitizing, games.ts (`MINI_GAMES`
                       list: car-roquelike first/default, then placeholders), game-settings.ts (per-game
                       room settings sanitizers),
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
- Room settings (gear button): `state.gameSettings` maps a `MINI_GAMES` id → its settings as JSON
  (missing = the game's defaults). `setGameSettings` (`{ game, settings }`, `settings: null` = defaults;
  `"selection"` only) sanitizes via `shared/game-settings.ts` (ignored if invalid or the game has none) and
  resets everyone's `ready`. A game gets settings with a sanitizer there plus an editor in
  `client/games/settings.ts`. car-roquelike: `{ obstacleWeights }` (`games/car-roquelike/settings.ts`,
  the `OBSTACLE_WEIGHTS` format, the default); the sim reads it at game start into `CarWorld.obstacleWeights`
  (`obstacleWeightSteps`), and the HUD bar follows it (`obstacleWeightStepsFor`).
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
  `state.roadSeed` (new per round). It starts at the origin with a fixed straight north (`START_STRAIGHT_LENGTH`, the running start plus 2400; the 2×4
  spawn grid is on it), then may go any direction. It is one fixed sequence per seed, generated on
  demand: `maintainRoad` (server each tick, client each frame) runs `ensureRoadAround`, and prunes old
  data. The road in play is measured along the road from the camera center (pure functions of
  `frontS`, so every side agrees): ahead, every piece starting within `ROAD_AHEAD` (5500;
  `piecesInPlay`, `roadEnd`), behind, up to `ROAD_BEHIND` (5000; `roadTail(road, frontS)`, never
  decreasing; road before it is deleted, dirt again, for good). Generator guarantees (`hasClearance`):
  stretches `VIEW_SEPARATION` (4500) or more apart along the road are never in the same view (+road
  half width +150), so pieces come into play and are deleted off screen; and road keeps 1200 clear of
  all road that can be in play with it (`CLEARANCE_WINDOW` = ahead + behind + longest piece), so the
  road in play never crosses itself (long-deleted ground is reused). Determinism however far/when each
  side generated: the generator runs `COMMIT_BUFFER` (15000) beyond the committed road it hands out,
  backtracking out of dead ends only within that; road is committed only up to an open piece end (a
  straight on from it passes the checks for the whole window, `isOpenEnd`), so stuck at committed road
  a straight always fits (never forced into a crossing). Only committed road is generated for good;
  lookups only see the road in play.
  Lookups: centerline samples (absolute indices, `sampleBase` after pruning) in a spatial
  grid: `isOnRoad(road, x, y, frontS)`, `roadDistanceAt`, `chunkOwnerS` (a chunk's owner = nearest
  sample within `ownerWindowStart`, deleted road included; memoized, updated incrementally). The server
  builds its own `buildRoad` per room; the client uses `getRoad` (cached per seed). Endless dirt
  everywhere else (no walls, no camera bounds); on dirt the top speed is ×`DIRT_SPEED_FACTOR` (0.5) and
  faster cars roll down to it. `CarWorld.road`/`frontS` carry the road into the physics. The client
  draws the dirt as a TileSprite re-fitted to the view each frame, and the road as one Graphics per
  piece in play (added as it comes into play, destroyed once deleted, the tail piece redrawn cut at the tail),
  culled to the view.
  Rounds: `state.carRoundTick` counts ticks; the first `COUNTDOWN_TICKS` are a countdown, the running start: inputs are ignored and every car drives
  straight north from its spawn at `CAR_MAX_SPEED` (`runningStartPose(seat, seed, tick)`, written directly, no
  physics or elimination; cars spawn already at that speed; `CarWorld.seats` maps ids to seats). The
  back row's base slots are `CHUNK_JITTER` + 150 up the road, just ahead of the void's edge; each round the seats are
  shuffled over the slots (`spawnSlot(seat, roadSeed)`, hashed, so a random grid position per race) and every slot moves up
  a further `SPAWN_STAGGER_MIN..MAX` (`spawnPoint(seat, roadSeed)`, hashed, so not lined up). The destruction front
  (`destruction.ts`) moves along the road from its start at `DESTRUCTION_SPEED` from tick 0 (countdown
  included), so the cars slowly pull away from it during the countdown: a chunk is void once the front passes its owner's distance along the road (dirt
  goes with the stretch of road beside it), and restored once its owner is deleted, so the void is a
  band following the front. The front edge is ragged: per-`CHUNK_SIZE`-chunk break points
  (`chunkBreakS`, integer-hash noise). A car whose center is over a void chunk, or outside the shared
  camera's view (`isOutOfView`, `camera.ts`), is eliminated (`stepCarRound` removes its body; `Car.eliminated`). Round end (`checkRoundEnd`): once
  one car is left in a round that has had 2+ cars (a leaver counts as out), it wins (`carWinner`,
  `carWinnerName`, `carWinTick`); the round runs on, clients show "<name> has won!!" for `WIN_TEXT_TICKS`,
  then fade the world to black (`WIN_FADE_TICKS`, timed by the server's `carRoundTick`), and the sim
  restarts. When every car is out with no winner (all at once, or alone), it restarts right away
  (`carRound++`, new road, cars back at their spawns). Eliminated players' inputs are still consumed so
  their acks advance. The client predicts the round tick with its inputs (in the sim world, adopted from
  `carRoundTick`), draws the front at that predicted time (fallen chunks as merged void runs,
  cracking/falling chunks at the edge). The client's world camera fades in from black (`FADE_IN_MS`)
  when the scene starts and whenever the drawn round tick jumps back (a new round).
  Room tests skip the countdown with the sim's `setRoundTick` (also moves the cars to the end of the running start). The scene enables gamepads itself via
  `input: { gamepad: true }` in its settings (missing from Phaser 4's `SettingsConfig` type, so it's widened). Camera: the same for everyone, north-up, fixed zoom (`CAMERA_ZOOM`), centered on the road `CAMERA_AHEAD_OF_FRONT` (1000) ahead of the predicted front
  (`cameraCenter`); its geometry is shared (`shared/games/car-roquelike/camera.ts`, re-exporting the view size from
  `constants.ts`, `SCREEN_WIDTH/HEIGHT` = the 1920×1080 logical screen) so the server eliminates cars off it;
  the HUD is on a second camera (world and HUD in separate layers, each camera ignores the other).
  Obstacle cars (`obstacles.ts`): computer-driven cars in the same matter world (`CarWorld.obstacles`,
  replicated in `state.obstacles`, cleared with each new road); their behavior is their kind = color.
  Only the server spawns them (`spawnObstacles`, each tick after `maintainRoad`): road after the first
  straight is rolled once per `OBSTACLE_SEGMENT` (100) as it comes within `ROAD_RADIUS` of the camera,
  `OBSTACLE_CHANCE` (30%) each, from a hash of (seed, segment) (`rollObstacle`), at most `MAX_OBSTACLES`
  (48) at once, each in a pose slot. Kinds are one table, `OBSTACLE_KINDS` (tune there): per kind
  `color`, `minSpeed..maxSpeed`
  (each car's `speed` = throttle, rolled in it), `direction` (1 along the road, -1 the wrong way)
  `avoidsCars` and `playerAttackDistance` (> 0: rams a player car next to it, i.e. level with it along the road
  (`ATTACK_ALONGSIDE`) and within that distance to its side, at its own speed, ahead of everything else; <= 0: never). How often each kind spawns: `OBSTACLE_WEIGHTS` (the default; the room's settings may replace it) (a list of `[distance, { kind → weight }]`, the distance relative to the previous entry's start, the first from the road's start; an entry applies from its start on, a step, not gradual, the last for good; a kind left out = 0). A weight is a spawn rate: a segment spawns with `OBSTACLE_CHANCE` × the total weight there (at most 1), its kind by share. The HUD shows the weights in use for spawning (the last segment rolled, followed client-side with `nextObstacleSegment`) as a vertical bar (top right, as wide as the total weight, kind colors, top to bottom in `OBSTACLE_KINDS` order).
  Every obstacle always drives at its own speed in its own `lane` (+ = right of
  the road's direction), aiming `OBSTACLE_LOOKAHEAD` along the road its way; it generates the road
  ahead of itself (`ensureRoad`), as it can outrun the road around the camera. `brown` (90%,
  0.5..0.9) avoids cars: it keeps `OBSTACLE_KEEP_GAP` (one car length) from every car, players' too,
  by steering only: in the road's frame (turned its way), a car whose path comes within that (now,
  or within `DODGE_TIME` at the closing speed) makes it swerve aside (around the other side if the
  road's edge is in the way; aiming closer for a car ahead); it won't move toward a car alongside
  (hemmed in: holds its line), unless that leaves it in the way of a car coming at it (head-ons
  stall both cars). In heavy traffic they still graze now and then. `red` (10%, 0.2) drives the
  wrong way, keeping to its lane whatever is in the way; it doesn't spawn with a car coming at it
  within `ONCOMING_SPAWN_CLEARANCE` (500) in its lane (tries a few other lanes first).
  `obstacleInput` is pure, so `stepCarWorld` drives them on both sides (also during the countdown,
  where the players' running start is written over the step); the client adopts them on each ack
  and draws them from the predicted world via per-slot pose fields. They're removed over the void.
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
