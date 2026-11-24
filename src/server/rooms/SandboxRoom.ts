import { Client, CloseCode } from "colyseus";
import { MAX_PLAYERS_PER_ROOM, SANDBOX_CPU_PLAYERS } from "../../shared/constants.js";
import { isMiniGameId } from "../../shared/games.js";
import { isValidPlayerName, sanitizePlayerName } from "../../shared/player-name.js";
import { GameSelectionRoom } from "./GameSelectionRoom.js";

/**
 * Dev-only room for working on a mini-game: everyone joins the same room (one per game id),
 * which starts directly in the given game and never goes back to game selection.
 *
 * CPU drivers: a client may join with `{ cpu: true }` (by id). They are ordinary connections from
 * a player's tab that send inputs like anyone else (so they go through the same network), named
 * "CPU N" and capped at `SANDBOX_CPU_PLAYERS`.
 */
export class SandboxRoom extends GameSelectionRoom {
  // Unlimited, so `joinOrCreate` always finds this room rather than opening a second one once it
  // is full; the player cap is enforced in onJoin instead.
  maxClients = Infinity;

  onCreate(options: any) {
    if (!isMiniGameId(options?.game)) {
      throw new Error(`Unknown mini-game "${options?.game}".`);
    }
    this.startSimulationLoop();
    this.state.selectedMiniGame = options.game;
    this.startGame();
  }

  onJoin(client: Client, options: any) {
    // Dropped players waiting to reconnect are still in `players`, so a reload keeps its seat
    if (this.state.players.size >= MAX_PLAYERS_PER_ROOM) {
      throw new Error("Sandbox is full.");
    }

    if (options?.cpu === true) {
      this.joinCpu(client);
      return;
    }

    const name = sanitizePlayerName(options?.name);
    super.onJoin(client, {
      ...options,
      name: isValidPlayerName(name) ? name : `Player ${this.state.players.size + 1}`,
    });
  }

  private joinCpu(client: Client) {
    const names = new Set<string>();
    for (const player of this.state.players.values()) {
      if (player.cpu) { names.add(player.name); }
    }
    if (names.size >= SANDBOX_CPU_PLAYERS) {
      throw new Error("Enough CPU players.");
    }

    let n = 1;
    while (names.has(`CPU ${n}`)) { n++; }
    super.onJoin(client, { name: `CPU ${n}` });
    this.state.players.get(client.sessionId).cpu = true;
  }

  /** A CPU driver lives in some player's tab: when its connection is gone, so is it (no seat held). */
  onDrop(client: Client, code: CloseCode) {
    if (this.state.players.get(client.sessionId)?.cpu) { return; }
    super.onDrop(client, code);
  }

  /** Only the (human) players need to escape; CPU drivers never do. */
  protected endIfAllEscaped() {
    if (this.state.phase !== "playing") { return; }
    let humans = 0;
    for (const player of this.state.players.values()) {
      if (player.cpu) { continue; }
      if (!player.escaped) { return; }
      humans++;
    }
    if (humans > 0) { this.endGame(); }
  }

  /** Everyone escaped: start the round over (fresh simulation) instead of returning to game selection. */
  protected endGame() {
    this.resetPlayers();
    this.startGame();
  }
}
