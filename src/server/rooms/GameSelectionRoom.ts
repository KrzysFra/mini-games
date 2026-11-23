import { Client, CloseCode, Room } from "colyseus"
import { DEFAULT_DOT_COLOR, MAX_PLAYERS_PER_ROOM } from "../../shared/constants.js"
import { isMiniGameId } from "../../shared/games.js"
import { isValidPlayerName, sanitizePlayerName } from "../../shared/player-name.js"
import { GameSelectionRoomState, Player } from "./schema/MiniGameRoomState.js"

export class GameSelectionRoom extends Room<{ state: GameSelectionRoomState }> {
  maxClients = MAX_PLAYERS_PER_ROOM;
  state = new GameSelectionRoomState();

  messages = {
    /** The player is (or is no longer) ready to start the selected mini-game. */
    setReady: (client: Client, ready: unknown) => {
      if (this.state.phase !== "selection") { return }
      const player = this.state.players.get(client.sessionId)
      if (!player || typeof ready !== "boolean") { return }
      player.ready = ready
      this.startIfAllReady()
    },

    /**
     * Pick the mini-game to play. Everyone's ready flag resets, since they agreed to
     * the previous game, not this one.
     */
    selectGame: (client: Client, id: unknown) => {
      if (this.state.phase !== "selection") { return }
      if (!this.state.players.has(client.sessionId) || !isMiniGameId(id)) { return }
      if (id === this.state.selectedMiniGame) { return }

      this.state.selectedMiniGame = id
      for (const player of this.state.players.values()) {
        player.ready = false
      }
    },

    /** Placeholder game: the player pressed a key, so their dot gets a random color (picked here, never by the client). */
    changeColor: (client: Client) => {
      if (this.state.phase !== "playing") { return }
      const player = this.state.players.get(client.sessionId)
      if (!player) { return }
      player.color = Math.floor(Math.random() * 0x1000000)
    },

    /** Placeholder game: the player wants to stop. Once everyone has, the room goes back to game selection. */
    escape: (client: Client) => {
      if (this.state.phase !== "playing") { return }
      const player = this.state.players.get(client.sessionId)
      if (!player) { return }
      player.escaped = true
      this.endIfAllEscaped()
    },
  };

  onCreate(options: any) {
    // The lobby lists rooms by type ("my_room"); the title is what players see.
    this.setMetadata({ title: `${sanitizePlayerName(options?.name) || "Unnamed"}'s room` })
  }

  onJoin(client: Client, options: any) {
    const name = sanitizePlayerName(options?.name)
    if (!isValidPlayerName(name)) {
      throw new Error("A player name is required to join.")
    }

    this.state.players.set(client.sessionId, new Player({ name }))
    console.log(client.sessionId, "joined as", name)
  }

  onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code)
    this.state.players.delete(client.sessionId)
    // The only player who wasn't ready (or hadn't escaped) may just have left
    this.startIfAllReady()
    this.endIfAllEscaped()
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...")
  }

  /** Start the selected mini-game once every player in the room is ready. */
  protected startIfAllReady() {
    if (this.state.phase !== "selection" || this.state.players.size === 0) { return }
    for (const player of this.state.players.values()) {
      if (!player.ready) { return }
    }
    this.state.phase = "playing"
  }

  /**
   * Back to game selection once every player has escaped the running game. Everyone's
   * per-game state resets, so the next game starts fresh and needs a new round of ready.
   */
  protected endIfAllEscaped() {
    if (this.state.phase !== "playing" || this.state.players.size === 0) { return }
    for (const player of this.state.players.values()) {
      if (!player.escaped) { return }
    }
    this.endGame()
  }

  /** The running mini-game is over: back to game selection. */
  protected endGame() {
    this.state.phase = "selection"
    this.resetPlayers()
  }

  /** Clear everyone's per-game state, so the next game starts fresh and needs a new round of ready. */
  protected resetPlayers() {
    for (const player of this.state.players.values()) {
      player.ready = false
      player.escaped = false
      player.color = DEFAULT_DOT_COLOR
    }
  }

  /**
   * Called on any disconnection the client did not ask for — a network blip, a
   * suspended tab, a tunnel change. Holding the seat lets the SDK retry into the
   * same session, so the player keeps their entity and their place in the room.
   */
  onDrop(client: Client, code: CloseCode) {
    // Deliberately not awaited: the framework routes the outcome to onReconnect()
    // or onLeave() by itself. The catch is only here because the promise also
    // rejects when the room is already disposing (server shutdown), which would
    // otherwise surface as an unhandled rejection.
    this.allowReconnection(client, 30).catch(() => { })
  }

  onReconnect(client: Client) {
    console.log(client.sessionId, "reconnected!")
  }
}
