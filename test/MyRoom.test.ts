import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/server/app.config.js";
import { testServer } from "./server.js";
import { GameSelectionRoomState } from "../src/server/rooms/schema/MiniGameRoomState.js";
import { DEFAULT_DOT_COLOR } from "../src/shared/constants.js";
import { MINI_GAMES } from "../src/shared/games.js";

describe("testing your Colyseus app", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await testServer());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("adds a player with their name on join", async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });

    const player = room.state.players.get(client1.sessionId);
    assert.ok(player, "a Player is created on join");
    assert.strictEqual(player.name, "Tester");
    assert.strictEqual(player.color, DEFAULT_DOT_COLOR);
  });

  it("keeps a dropped player's seat for a reconnect by token (page reload)", async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
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
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    // A second, unready player keeps the game from starting
    await colyseus.connectTo(room, { name: "Tester2" });
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
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
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

  it("changes a game's settings (sanitized), resetting everyone's ready flag; null restores the defaults", async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    await colyseus.connectTo(room, { name: "Tester2" });
    client1.send("setReady", true);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "selection");

    client1.send("setGameSettings", {
      game: "car-roquelike",
      settings: { obstacleWeights: [[-5, { brown: 2, red: -1, nope: 3 }], [1000.4, { black: 99 }]] },
    });
    await room.waitForNextMessage();
    assert.deepStrictEqual(JSON.parse(room.state.gameSettings.get("car-roquelike")),
      { obstacleWeights: [[0, { brown: 2 }], [1000, { black: 10 }]] }, "clamped, unknown kinds dropped");
    assert.strictEqual(room.state.players.get(client1.sessionId).ready, false);

    client1.send("setGameSettings", { game: "car-roquelike", settings: { obstacleWeights: "lots" } });
    await room.waitForNextMessage();
    client1.send("setGameSettings", { game: "placeholder-1", settings: {} });
    await room.waitForNextMessage();
    assert.ok(room.state.gameSettings.has("car-roquelike"), "invalid settings are ignored");
    assert.ok(!room.state.gameSettings.has("placeholder-1"), "games without settings take none");

    client1.send("setGameSettings", { game: "car-roquelike", settings: null });
    await room.waitForNextMessage();
    assert.ok(!room.state.gameSettings.has("car-roquelike"), "back to the defaults");
  });

  it("starts the game once every player is ready", async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const client2 = await colyseus.connectTo(room, { name: "Tester2" });

    client1.send("setReady", true);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "selection", "one player is still not ready");

    client2.send("setReady", true);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "playing");
  });

  it("starts the game when the last unready player leaves", async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const client2 = await colyseus.connectTo(room, { name: "Tester2" });

    client1.send("setReady", true);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "selection");

    await client2.leave();
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "playing");
  });

  it("changes a player's dot color only while playing", async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const player = room.state.players.get(client1.sessionId);

    client1.send("changeColor");
    await room.waitForNextMessage();
    assert.strictEqual(player.color, DEFAULT_DOT_COLOR, "ignored in the selection room");

    client1.send("setReady", true);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "playing");

    // A random color could happen to be red again; a few presses make that vanishingly unlikely
    for (let i = 0; i < 3 && player.color === DEFAULT_DOT_COLOR; i++) {
      client1.send("changeColor");
      await room.waitForNextMessage();
    }
    assert.notStrictEqual(player.color, DEFAULT_DOT_COLOR);
    assert.ok(player.color >= 0 && player.color <= 0xffffff);
  });

  it("returns to game selection once every player has escaped, resetting them", async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const client2 = await colyseus.connectTo(room, { name: "Tester2" });
    const player1 = room.state.players.get(client1.sessionId);
    const player2 = room.state.players.get(client2.sessionId);

    client1.send("escape");
    await room.waitForNextMessage();
    assert.strictEqual(player1.escaped, false, "ignored in the selection room");

    client1.send("setReady", true);
    await room.waitForNextMessage();
    client2.send("setReady", true);
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "playing");

    client1.send("changeColor");
    await room.waitForNextMessage();
    client1.send("escape");
    await room.waitForNextMessage();
    assert.strictEqual(player1.escaped, true);
    assert.strictEqual(room.state.phase, "playing", "one player is still playing");

    client2.send("escape");
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "selection");
    for (const player of [player1, player2]) {
      assert.strictEqual(player.escaped, false);
      assert.strictEqual(player.ready, false);
      assert.strictEqual(player.color, DEFAULT_DOT_COLOR);
    }
  });

  it("returns to game selection when the last player still playing leaves", async () => {
    const room = await colyseus.createRoom<GameSelectionRoomState>("my_room", {});
    const client1 = await colyseus.connectTo(room, { name: "Tester" });
    const client2 = await colyseus.connectTo(room, { name: "Tester2" });

    client1.send("setReady", true);
    await room.waitForNextMessage();
    client2.send("setReady", true);
    await room.waitForNextMessage();
    client1.send("escape");
    await room.waitForNextMessage();
    assert.strictEqual(room.state.phase, "playing");

    await client2.leave();
    await room.waitForNextPatch();
    assert.strictEqual(room.state.phase, "selection");
  });
});
