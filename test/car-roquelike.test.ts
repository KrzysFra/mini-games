import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/server/app.config.js";
import { testServer } from "./server.js";
import type { GameSelectionRoomState } from "../src/server/rooms/schema/MiniGameRoomState.js";

const GAME = "car-roquelike";

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

  it("moves a car forward with throttle input", async () => {
    const { room, client1 } = await startGame();
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

  it("starts the sandbox room with cars, and respawns them when everyone escaped", async () => {
    const client = await colyseus.sdk.joinOrCreate("sandbox", { game: GAME, name: "Tester" });
    const room = colyseus.getRoomById<GameSelectionRoomState>(client.roomId);
    const car = room.state.cars.get(client.sessionId);
    assert.ok(car, "a car on join");

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
