import { LobbyRoom, type Client } from "colyseus";
import { isValidPlayerName, sanitizePlayerName } from "../../shared/player-name.js";

/** Room type listed in the lobby. */
const LISTED_ROOM = "my_room";

/**
 * The built-in LobbyRoom (room list with live "+" / "-" updates), plus the player's name,
 * so the server knows who is in the lobby before they join a game room.
 */
export class MainLobbyRoom extends LobbyRoom {
  /** sessionId → player name ("" until a valid name is set). */
  names = new Map<string, string>();

  /** Message types clients may send (types `room.send` in the SDK and tests). */
  declare messages: LobbyRoom["messages"] & {
    setName: (client: Client, name: string) => void;
  };

  async onCreate(options: any) {
    await super.onCreate(options);

    this.onMessage("setName", (client, raw) => {
      const name = sanitizePlayerName(raw);
      if (!isValidPlayerName(name) || !this.names.has(client.sessionId)) { return; }

      this.names.set(client.sessionId, name);
      console.log(client.sessionId, "is now", name);
    });
  }

  onJoin(client: Client, options: any) {
    const name = sanitizePlayerName(options?.name);
    this.names.set(client.sessionId, isValidPlayerName(name) ? name : "");
    console.log(client.sessionId, "entered the lobby as", name || "(no name)");

    // The server picks the filter, so clients only ever see game rooms.
    super.onJoin(client, { filter: { name: LISTED_ROOM } });
  }

  onLeave(client: Client) {
    this.names.delete(client.sessionId);
    super.onLeave(client);
  }
}
