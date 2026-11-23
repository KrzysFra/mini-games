import { Client } from "colyseus";
import { MAX_PLAYERS_PER_ROOM } from "../../shared/constants.js";
import { isMiniGameId } from "../../shared/games.js";
import { isValidPlayerName, sanitizePlayerName } from "../../shared/player-name.js";
import { GameSelectionRoom } from "./GameSelectionRoom.js";

/**
 * Dev-only room for working on a mini-game: everyone joins the same room (one per game id),
 * which starts directly in the given game and never goes back to game selection.
 */
export class SandboxRoom extends GameSelectionRoom {
  // Unlimited, so `joinOrCreate` always finds this room rather than opening a second one once it
  // is full; the player cap is enforced in onJoin instead.
  maxClients = Infinity;

  onCreate(options: any) {
    if (!isMiniGameId(options?.game)) {
      throw new Error(`Unknown mini-game "${options?.game}".`);
    }
    this.state.selectedMiniGame = options.game;
    this.state.phase = "playing";
  }

  onJoin(client: Client, options: any) {
    // Dropped players waiting to reconnect are still in `players`, so a reload keeps its seat
    if (this.state.players.size >= MAX_PLAYERS_PER_ROOM) {
      throw new Error("Sandbox is full.");
    }

    const name = sanitizePlayerName(options?.name);
    super.onJoin(client, {
      ...options,
      name: isValidPlayerName(name) ? name : `Player ${this.state.players.size + 1}`,
    });
  }

  /** Everyone escaped: start the round over instead of returning to game selection. */
  protected endGame() {
    this.resetPlayers();
  }
}
