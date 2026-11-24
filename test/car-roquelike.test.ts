import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/server/app.config.js";
import { testServer } from "./server.js";
import type { GameSelectionRoomState } from "../src/server/rooms/schema/MiniGameRoomState.js";
import { INPUT_BUTTONS } from "../src/shared/constants.js";
import { COUNTDOWN_TICKS } from "../src/shared/games/car-roquelike/destruction.js";
import { CAR_MAX_SPEED, PHYSICS_SUBSTEPS } from "../src/shared/games/car-roquelike/constants.js";
import { spawnPoint } from "../src/shared/games/car-roquelike/map.js";
import { OBSTACLE_KINDS, type ObstacleKind } from "../src/shared/games/car-roquelike/obstacles.js";
import type { Room } from "colyseus";
import type { CarRoquelikeSim } from "../src/server/games/car-roquelike/CarRoquelikeSim.js";

const GAME = "car-roquelike";

/** Jump the round past its countdown (cars where the running start ends), so players drive right away. */
const skipCountdown = (room: Room<any>) => {
  (room as unknown as { activeGame: CarRoquelikeSim }).activeGame.setRoundTick(COUNTDOWN_TICKS);
};

describe("car-roquelike room", () => {
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

  it("drives every car straight north at top speed during the countdown, ignoring input", async () => {
    const { room, client1 } = await startGame();
    const car = room.state.cars.get(client1.sessionId);
    const startX = car.x;
    const startY = car.y;

    const input = client1.input();
    for (let i = 0; i < 10; i++) {
      input.data.x = 1; // east: ignored
      input.send();
      await room.waitForNextSimulationTick();
    }
    assert.ok(room.state.carRoundTick < COUNTDOWN_TICKS, "still counting down");
    assert.strictEqual(car.x, startX, "straight");
    assert.ok(car.y < startY - 10 * CAR_MAX_SPEED, `drove north (from ${startY} to ${car.y})`);
    assert.deepStrictEqual([car.vx, car.vy, car.angle], [0, -CAR_MAX_SPEED, -Math.PI / 2], "at top speed");
  });

  it("eliminates cars caught by the destruction, and restarts once everyone is out", async () => {
    const { room, client1, client2 } = await startGame();
    const car1 = room.state.cars.get(client1.sessionId);
    const car2 = room.state.cars.get(client2.sessionId);
    // The front jumps past the cars (left near their spawns): everyone is out at once
    room.state.carRoundTick = COUNTDOWN_TICKS + 50;

    for (let i = 0; i < 60 && room.state.carRound === 0; i++) {
      await room.waitForNextSimulationTick();
    }
    assert.strictEqual(room.state.carRound, 1, "a new round started");
    assert.ok(!car1.eliminated && !car2.eliminated, "everyone is back in");
    assert.strictEqual(car1.y, spawnPoint(car1.seat, room.state.roadSeed).y, "back at the new round's spawn point");
    assert.ok(room.state.carRoundTick < COUNTDOWN_TICKS, "counting down again");
  });

  it("moves a car forward with throttle input", async () => {
    const { room, client1 } = await startGame();
    skipCountdown(room);
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
    skipCountdown(room);
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

  it("spawns obstacle cars on the road ahead, driving along it, and clears them when the game ends", async () => {
    const { room, client1, client2 } = await startGame();
    skipCountdown(room);
    await room.waitForNextSimulationTick();
    assert.ok(room.state.obstacles.size > 0, "obstacles on the road ahead");
    const [id, obstacle] = [...room.state.obstacles][0];
    const kind = OBSTACLE_KINDS[obstacle.kind as ObstacleKind];
    assert.ok(kind, `a known kind (${obstacle.kind})`);
    assert.ok(obstacle.speed >= Math.fround(kind.minSpeed) && obstacle.speed <= Math.fround(kind.maxSpeed), `speed ${obstacle.speed}`);
    const start = { x: obstacle.x, y: obstacle.y };
    for (let i = 0; i < 5; i++) { await room.waitForNextSimulationTick(); }
    const moved = Math.hypot(obstacle.x - start.x, obstacle.y - start.y);
    const expected = 5 * PHYSICS_SUBSTEPS * obstacle.speed * CAR_MAX_SPEED;
    assert.ok(room.state.obstacles.get(id) === obstacle && moved > 0.8 * expected, `drives (${moved} of ${expected})`);

    client1.send("escape");
    client2.send("escape");
    await room.waitForNextMessage();
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "selection");
    assert.strictEqual(room.state.obstacles.size, 0, "obstacles cleared");
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
    skipCountdown(room);

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
