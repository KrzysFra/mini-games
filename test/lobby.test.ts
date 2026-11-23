import assert from "assert";
import type { ColyseusTestServer } from "@colyseus/testing";

import type appConfig from "../src/server/app.config.js";
import { testServer } from "./server.js";
import type { MainLobbyRoom } from "../src/server/rooms/MainLobbyRoom.js";

/** Resolves with the next message of `type` the SDK room receives. */
const nextMessage = <T = any>(room: { onMessage: (type: string, cb: (payload: T) => void) => () => void }, type: string) =>
  new Promise<T>((resolve) => {
    const off = room.onMessage(type, (payload) => { off(); resolve(payload); });
  });

describe("lobby", () => {
  let colyseus: ColyseusTestServer<typeof appConfig>;

  before(async () => colyseus = await testServer());

  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it("knows the player's name before they join a game room", async () => {
    const lobbyClient = await colyseus.sdk.joinOrCreate("lobby", { name: "  Alice  " });
    const lobby = colyseus.getRoomById<MainLobbyRoom>(lobbyClient.roomId);
    assert.strictEqual(lobby.names.get(lobbyClient.sessionId), "Alice");

    lobbyClient.send("setName", "Alice Cooper");
    await lobby.waitForNextMessage();
    assert.strictEqual(lobby.names.get(lobbyClient.sessionId), "Alice Cooper");

    // Too short: ignored
    lobbyClient.send("setName", "Al");
    await lobby.waitForNextMessage();
    assert.strictEqual(lobby.names.get(lobbyClient.sessionId), "Alice Cooper");
  });

  it("lists game rooms with their title, live", async () => {
    const lobbyClient = await colyseus.sdk.joinOrCreate("lobby", { name: "Bobby" });

    const added = nextMessage<[string, any]>(lobbyClient, "+");
    const gameClient = await colyseus.sdk.create("my_room", { name: "Alice" });
    const [roomId, listing] = await added;
    assert.strictEqual(roomId, gameClient.roomId);
    assert.strictEqual(listing.metadata.title, "Alice's room");

    const removed = nextMessage<string>(lobbyClient, "-");
    await gameClient.leave();
    assert.strictEqual(await removed, gameClient.roomId);
  });

  it("rejects joining a game room without a valid name", async () => {
    const room = await colyseus.createRoom("my_room", {});
    await assert.rejects(colyseus.connectTo(room, { name: "Al" }));
  });
});
