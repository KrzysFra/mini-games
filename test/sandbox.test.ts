import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/server/app.config.js";
import { testServer } from "./server.js";
import { GameSelectionRoomState } from "../src/server/rooms/schema/MiniGameRoomState.js";
import { DEFAULT_DOT_COLOR, MAX_PLAYERS_PER_ROOM } from "../src/shared/constants.js";
import { MINI_GAMES } from "../src/shared/games.js";

describe("sandbox room", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;
  const game = MINI_GAMES[1].id;

  before(async () => colyseus = await testServer());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("puts every client in the same room, already playing the given game", async () => {
    const client1 = await colyseus.sdk.joinOrCreate("sandbox", { game, name: "Tester" });
    const client2 = await colyseus.sdk.joinOrCreate("sandbox", { game, name: "Tester2" });
    assert.strictEqual(client1.roomId, client2.roomId);

    const room = colyseus.getRoomById<GameSelectionRoomState>(client1.roomId);
    assert.strictEqual(room.state.phase, "playing");
    assert.strictEqual(room.state.selectedMiniGame, game);
  });

  it("names players without a valid name", async () => {
    const client1 = await colyseus.sdk.joinOrCreate("sandbox", { game });
    const room = colyseus.getRoomById<GameSelectionRoomState>(client1.roomId);
    assert.strictEqual(room.state.players.get(client1.sessionId).name, "Player 1");
  });

  it(`rejects a client once ${MAX_PLAYERS_PER_ROOM} players are in`, async () => {
    const clients: { roomId: string }[] = [];
    for (let i = 0; i < MAX_PLAYERS_PER_ROOM; i++) {
      clients.push(await colyseus.sdk.joinOrCreate("sandbox", { game, name: `Tester${i}` }));
    }
    assert.ok(clients.every(c => c.roomId === clients[0].roomId));

    await assert.rejects(colyseus.sdk.joinOrCreate("sandbox", { game, name: "TooMany" }), /full/i);
    const room = colyseus.getRoomById<GameSelectionRoomState>(clients[0].roomId);
    assert.strictEqual(room.state.players.size, MAX_PLAYERS_PER_ROOM);
  });

  it("keeps playing once everyone escaped, resetting the players", async () => {
    const client1 = await colyseus.sdk.joinOrCreate("sandbox", { game, name: "Tester" });
    const client2 = await colyseus.sdk.joinOrCreate("sandbox", { game, name: "Tester2" });
    const room = colyseus.getRoomById<GameSelectionRoomState>(client1.roomId);

    client1.send("changeColor");
    await room.waitForNextMessage();
    client1.send("escape");
    await room.waitForNextMessage();
    client2.send("escape");
    await room.waitForNextMessage();

    assert.strictEqual(room.state.phase, "playing");
    for (const player of room.state.players.values()) {
      assert.strictEqual(player.escaped, false);
      assert.strictEqual(player.color, DEFAULT_DOT_COLOR);
    }
  });

  it("rejects an unknown mini-game", async () => {
    await assert.rejects(colyseus.sdk.joinOrCreate("sandbox", { game: "not-a-game", name: "Tester" }));
  });
});
