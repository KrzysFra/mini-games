import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/server/app.config.js";
import { testServer } from "./server.js";
import { GameSelectionRoomState } from "../src/server/rooms/schema/MiniGameRoomState.js";
import { DEFAULT_DOT_COLOR, MAX_PLAYERS_PER_ROOM, SANDBOX_CPU_PLAYERS } from "../src/shared/constants.js";
import { MINI_GAMES } from "../src/shared/games.js";

/** Resolves once `condition` holds (the server handles messages asynchronously). */
async function waitUntil(condition: () => boolean, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) { throw new Error("timed out waiting for a condition"); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

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

  it(`takes up to ${SANDBOX_CPU_PLAYERS} CPU players, named CPU N`, async () => {
    const human = await colyseus.sdk.joinOrCreate("sandbox", { game, name: "Tester" });
    const room = colyseus.getRoomById<GameSelectionRoomState>(human.roomId);

    const cpus = [];
    for (let i = 0; i < SANDBOX_CPU_PLAYERS; i++) {
      cpus.push(await colyseus.sdk.joinById(human.roomId, { cpu: true, name: "Sneaky" }));
    }
    await assert.rejects(colyseus.sdk.joinById(human.roomId, { cpu: true }), /CPU/);

    assert.deepStrictEqual(cpus.map(c => room.state.players.get(c.sessionId).name),
      Array.from({ length: SANDBOX_CPU_PLAYERS }, (_, i) => `CPU ${i + 1}`));
    assert.ok(cpus.every(c => room.state.players.get(c.sessionId).cpu));
    assert.strictEqual(room.state.players.get(human.sessionId).cpu, false);
  });

  it("holds no seat for a dropped CPU player", async () => {
    const human = await colyseus.sdk.joinOrCreate("sandbox", { game, name: "Tester" });
    const room = colyseus.getRoomById<GameSelectionRoomState>(human.roomId);
    const cpu = await colyseus.sdk.joinById(human.roomId, { cpu: true });

    // The tab closed: the socket closes without consent and nothing reconnects
    cpu.reconnection.enabled = false;
    await cpu.leave(false);
    await waitUntil(() => !room.state.players.has(cpu.sessionId));
    assert.strictEqual(room.hasReservedSeat(cpu.sessionId), false);
  });

  it("restarts once every human escaped, without the CPU players", async () => {
    const human = await colyseus.sdk.joinOrCreate("sandbox", { game, name: "Tester" });
    const room = colyseus.getRoomById<GameSelectionRoomState>(human.roomId);
    await colyseus.sdk.joinById(human.roomId, { cpu: true });

    const player = room.state.players.get(human.sessionId);
    human.send("changeColor");
    await waitUntil(() => player.color !== DEFAULT_DOT_COLOR);
    human.send("escape");
    // The restart resets everyone (escaped and color)
    await waitUntil(() => player.color === DEFAULT_DOT_COLOR);
    assert.strictEqual(player.escaped, false);
    assert.strictEqual(room.state.phase, "playing");
  });

  it("rejects an unknown mini-game", async () => {
    await assert.rejects(colyseus.sdk.joinOrCreate("sandbox", { game: "not-a-game", name: "Tester" }));
  });
});
