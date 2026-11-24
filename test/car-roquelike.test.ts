import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/server/app.config.js";
import { testServer } from "./server.js";
import type { GameSelectionRoomState } from "../src/server/rooms/schema/MiniGameRoomState.js";
import { INPUT_BUTTONS } from "../src/shared/constants.js";
import { COUNTDOWN_TICKS } from "../src/shared/games/car-roquelike/destruction.js";

/** car-roquelike and its force-driven clones share the room, schema and round logic. */
const CAR_GAMES = ["car-roquelike", "car-roquelike-mjs-torque", "car-roquelike-mjs-axle"];

/** Jump the round past its 5 s countdown, so cars can move right away. */
const skipCountdown = (state: GameSelectionRoomState) => { state.carRoundTick = COUNTDOWN_TICKS; };

for (const GAME of CAR_GAMES) describe(`${GAME} room`, () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await testServer());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  /** A `my_room` with two players, car-roquelike selected, and the game started. */
  const startGame = async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const client2 = await colyseus.connectTo(room, { name: "Tester2" });
    client1.send("selectGame", GAME);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.selectedMiniGame, GAME);
    client1.send("setReady", true);
    client2.send("setReady", true);
    await room.waitForNextMessage();
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "playing");
    return { room, client1, client2 };
  };

  it("gives every player a car at its own spawn when the game starts", async () => {
    const { room, client1, client2 } = await startGame();
    const car1 = room.state.cars.get(client1.sessionId);
    const car2 = room.state.cars.get(client2.sessionId);
    assert.ok(car1 && car2, "one car per player");
    assert.notStrictEqual(car1.seat, car2.seat);
    assert.ok(car1.x !== car2.x || car1.y !== car2.y, "distinct spawn points");
  });

  it("holds cars still during the countdown", async () => {
    const { room, client1 } = await startGame();
    const car = room.state.cars.get(client1.sessionId);
    const startY = car.y;

    const input = client1.input();
    for (let i = 0; i < 10; i++) {
      input.data.y = -1;
      input.send();
      await room.waitForNextSimulationTick();
    }
    assert.ok(room.state.carRoundTick < COUNTDOWN_TICKS, "still counting down");
    assert.strictEqual(car.y, startY, "didn't move");
  });

  it("eliminates cars caught by the destruction, and restarts once everyone is out", async () => {
    const { room, client1, client2 } = await startGame();
    const car1 = room.state.cars.get(client1.sessionId);
    const car2 = room.state.cars.get(client2.sessionId);
    const spawnY = car1.y;
    // Nobody drives, and the front starts out almost at the spawn (it takes ~60 ticks to get there)
    room.state.carRoundTick = COUNTDOWN_TICKS + 50;

    for (let i = 0; i < 60 && room.state.carRound === 0; i++) {
      await room.waitForNextSimulationTick();
    }
    assert.strictEqual(room.state.carRound, 1, "a new round started");
    assert.ok(!car1.eliminated && !car2.eliminated, "everyone is back in");
    assert.strictEqual(car1.y, spawnY, "back at the spawn point");
    assert.ok(room.state.carRoundTick < COUNTDOWN_TICKS, "counting down again");
  });

  it("moves a car forward with throttle input", async () => {
    const { room, client1 } = await startGame();
    skipCountdown(room.state);
    const car = room.state.cars.get(client1.sessionId);
    const startY = car.y;

    // Cars spawn facing up (-y)
    const input = client1.input();
    for (let i = 0; i < 20; i++) {
      input.data.y = -1; // up the screen, the way cars spawn facing
      input.send();
      await room.waitForNextSimulationTick();
    }
    assert.ok(car.y < startY - 20, `drove up (from ${startY.toFixed(1)} to ${car.y.toFixed(1)})`);
  });

  it("shows every car's last applied input, so clients can predict other players", async () => {
    const { room, client1, client2 } = await startGame();
    skipCountdown(room.state);
    const input = client1.input();
    for (let i = 0; i < 5; i++) {
      input.data.x = 0.5;
      input.data.y = -0.75;
      input.data.buttons = INPUT_BUTTONS.ACTION;
      input.send();
      await room.waitForNextSimulationTick();
    }
    const car = room.state.cars.get(client1.sessionId);
    assert.strictEqual(car.inX, 0.5);
    assert.strictEqual(car.inY, -0.75);
    assert.strictEqual(car.inButtons, INPUT_BUTTONS.ACTION);
    // No input from client2 yet: zeros
    const other = room.state.cars.get(client2.sessionId);
    assert.deepStrictEqual([other.inX, other.inY, other.inButtons], [0, 0, 0]);
  });

  it("removes a leaving player's car, and clears all cars when the game ends", async () => {
    const { room, client1, client2 } = await startGame();

    await client2.leave();
    await room.waitForNextPatch();
    assert.ok(!room.state.cars.has(client2.sessionId), "the leaver's car is gone");
    assert.strictEqual(room.state.cars.size, 1);

    client1.send("escape");
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "selection");
    assert.strictEqual(room.state.cars.size, 0, "cars cleared on the way back to selection");
  });

  it("after a dev-mode restore, drops players with no seat and restarts the game for the rest", async () => {
    const client = await colyseus.sdk.joinOrCreate("sandbox", { game: GAME, name: "Tester" });
    const room = colyseus.getRoomById<GameSelectionRoomState>(client.roomId);
    // What a restore leaves behind: a player who had dropped before the reload, with no seat
    const ghost = room.state.players.get(client.sessionId).clone();
    room.state.players.set("ghost", ghost);
    room.state.carRoundTick = COUNTDOWN_TICKS + 100;

    room.onRestoreRoom();

    assert.ok(!room.state.players.has("ghost"), "the ghost is gone");
    assert.ok(room.state.players.has(client.sessionId), "the connected player stays");
    assert.deepStrictEqual([...room.state.cars.keys()], [client.sessionId], "cars only for real players");
    assert.strictEqual(room.state.carRoundTick, 0, "a fresh round");
    await client.leave();
  });

  it("starts the sandbox room with cars, and respawns them when everyone escaped", async () => {
    const client = await colyseus.sdk.joinOrCreate("sandbox", { game: GAME, name: "Tester" });
    const room = colyseus.getRoomById<GameSelectionRoomState>(client.roomId);
    const car = room.state.cars.get(client.sessionId);
    assert.ok(car, "a car on join");
    skipCountdown(room.state);

    const input = client.input();
    for (let i = 0; i < 10; i++) {
      input.data.y = -1; // up the screen, the way cars spawn facing
      input.send();
      await room.waitForNextSimulationTick();
    }
    const movedY = room.state.cars.get(client.sessionId).y;

    client.send("escape");
    await room.waitForNextMessage();
    const respawned = room.state.cars.get(client.sessionId);
    assert.ok(respawned.y > movedY, "back at the spawn point");
    await client.leave();
  });
});
