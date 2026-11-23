import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/server/app.config.js";
import { testServer } from "./server.js";
import { MyRoomState, type MoveInput } from "../src/server/rooms/schema/MiniGameRoomState.js";
import { PLAYER_SPEED, TICK_RATE } from "../src/shared/constants.js";
import { MINI_GAMES } from "../src/shared/games.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await testServer());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("advances a player from its buffered input", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });

    const player = room.state.players.get(client1.sessionId);
    assert.ok(player, "a Player is created on join");
    const startX = player.x;

    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.moveX = 1;
    input.data.moveY = 0;
    input.send();

    await room.waitForNextMessage();  // the input reaches the server
    await room.waitForNextTimestep(); // the step that consumes it runs

    assert.ok(player.x > startX, "the buffered input advanced the player");
  });

  it("clamps input that is out of range", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });

    const player = room.state.players.get(client1.sessionId);
    const startX = player.x;

    // A modified client claiming a huge axis value: sanitize clamps it to 1.
    const input = client1.input<MoveInput>({ mode: "reliable" });
    input.data.moveX = 100 as any;
    input.send();

    await room.waitForNextMessage();
    await room.waitForNextTimestep();

    // The room steps once per received input, so one input is exactly one step
    // of travel — at moveX clamped to 1, not the 100 the client asked for.
    assert.strictEqual(player.x, startX + PLAYER_SPEED * (1 / TICK_RATE));
  });

  it("keeps a dropped player's seat for a reconnect by token (page reload)", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const { sessionId, reconnectionToken } = client1;

    // A reload: the socket closes without consent and the page can't auto-reconnect
    client1.reconnection.enabled = false;
    await client1.leave(false);
    assert.ok(room.state.players.has(sessionId), "the seat is held after the drop");

    const resumed = await colyseus.sdk.reconnect(reconnectionToken);
    assert.strictEqual(resumed.sessionId, sessionId, "the same session is resumed");
    assert.ok(room.state.players.has(sessionId));
    await resumed.leave();
  });

  it("toggles a player's ready flag, ignoring non-boolean values", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const player = room.state.players.get(client1.sessionId);
    assert.strictEqual(player.ready, false);

    client1.send("setReady", true);
    await room.waitForNextMessage();
    assert.strictEqual(player.ready, true);

    client1.send("setReady", "no" as any);
    await room.waitForNextMessage();
    assert.strictEqual(player.ready, true, "a non-boolean is ignored");

    client1.send("setReady", false);
    await room.waitForNextMessage();
    assert.strictEqual(player.ready, false);
  });

  it("selects a known mini-game and resets everyone's ready flag", async () => {
    const room = await colyseus.createRoom<MyRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const client2 = await colyseus.connectTo(room, { name: "Tester2" });
    assert.strictEqual(room.state.selectedMiniGame, MINI_GAMES[0].id);

    client1.send("setReady", true);
    await room.waitForNextMessage();
    client2.send("selectGame", MINI_GAMES[1].id);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.selectedMiniGame, MINI_GAMES[1].id);
    assert.strictEqual(room.state.players.get(client1.sessionId).ready, false);

    client2.send("selectGame", "not-a-game");
    await room.waitForNextMessage();
    assert.strictEqual(room.state.selectedMiniGame, MINI_GAMES[1].id, "unknown ids are ignored");
  });
});
