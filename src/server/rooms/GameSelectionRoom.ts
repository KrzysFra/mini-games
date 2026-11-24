import { Client, CloseCode, Room } from "colyseus"
import { DEFAULT_DOT_COLOR, INPUT_BUTTONS_MASK, MAX_PLAYERS_PER_ROOM, TICK_RATE } from "../../shared/constants.js"
import { hasGameSettings, sanitizeGameSettings } from "../../shared/game-settings.js"
import { isMiniGameId } from "../../shared/games.js"
import { PHYSICS_SUBSTEPS } from "../../shared/games/car-roquelike/constants.js"
import { isValidPlayerName, sanitizePlayerName } from "../../shared/player-name.js"
import { serverMiniGame } from "../games/registry.js"
import type { ServerMiniGame } from "../games/types.js"
import { GameInput, GameSelectionRoomState, Player } from "./schema/MiniGameRoomState.js"

const clampAxis = (value: number) => (Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0)

export class GameSelectionRoom extends Room<{ state: GameSelectionRoomState, input: GameInput }> {
  maxClients = MAX_PLAYERS_PER_ROOM;
  state = new GameSelectionRoomState();

  /**
   * One input per player per fixed tick, for mini-games that simulate continuously. Never trusted:
   * axes are clamped to -1..1 and unknown buttons dropped. A tick with no input (a packet gap)
   * repeats the player's last one, so a held key keeps acting.
   */
  inputs = this.defineInput(GameInput, {
    sanitize: (input: GameInput) => {
      input.x = clampAxis(input.x)
      input.y = clampAxis(input.y)
      input.buttons = (input.buttons | 0) & INPUT_BUTTONS_MASK
    },
    idle: ({ latest }) => latest ?? true,
  });

  /** The running mini-game's simulation, if the selected game has one. */
  protected activeGame: ServerMiniGame | undefined;

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

    /**
     * Change a mini-game's room settings: `{ game, settings }`, `settings: null` = back to its
     * defaults. Sanitized here; invalid settings are ignored. Everyone's ready flag resets, since
     * they agreed to the old settings.
     */
    setGameSettings: (client: Client, message: unknown) => {
      if (this.state.phase !== "selection" || !this.state.players.has(client.sessionId)) { return }
      const { game, settings } = (message ?? {}) as { game?: unknown, settings?: unknown }
      if (!isMiniGameId(game) || !hasGameSettings(game)) { return }

      if (settings === null) {
        if (!this.state.gameSettings.has(game)) { return }
        this.state.gameSettings.delete(game)
      } else {
        const json = sanitizeGameSettings(game, settings)
        if (json === undefined || json === this.state.gameSettings.get(game)) { return }
        this.state.gameSettings.set(game, json)
      }
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
      console.log(client.sessionId, "escaped")
      this.endIfAllEscaped()
    },
  };

  onCreate(options: any) {
    // The lobby lists rooms by type ("my_room"); the title is what players see.
    this.setMetadata({ title: `${sanitizePlayerName(options?.name) || "Unnamed"}'s room` })
    this.startSimulationLoop()
  }

  /** Fixed-tick loop driving the running mini-game's simulation; call once from `onCreate`. */
  protected startSimulationLoop() {
    // Inputs at TICK_RATE, physics sub-stepped inside each tick (the same numbers reach predicting clients)
    this.setFixedTimestep(ctx => this.activeGame?.step(ctx, this.inputs), TICK_RATE, { subSteps: PHYSICS_SUBSTEPS })
    this.patchRate = 1000 / TICK_RATE
  }

  onJoin(client: Client, options: any) {
    const name = sanitizePlayerName(options?.name)
    if (!isValidPlayerName(name)) {
      throw new Error("A player name is required to join.")
    }

    this.state.players.set(client.sessionId, new Player({ name }))
    this.activeGame?.addPlayer(client.sessionId)
    console.log(client.sessionId, "joined as", name)
  }

  onLeave(client: Client, code: CloseCode) {
    console.log(client.sessionId, "left!", code)
    this.state.players.delete(client.sessionId)
    this.activeGame?.removePlayer(client.sessionId)
    // The only player who wasn't ready (or hadn't escaped) may just have left
    this.startIfAllReady()
    this.endIfAllEscaped()
  }

  /**
   * Dev mode only: after a hot reload the room is re-created (`onCreate`) and its old state
   * restored over it.
   *
   * Only players who were connected at the reload get a seat to reconnect into (and an `onLeave`
   * if they don't). Players who had dropped and were waiting to reconnect come back in the state
   * without one, so nothing would ever remove them: drop them here.
   *
   * The running simulation isn't restored either: it would have none of the restored players
   * (they come back through `onReconnect`, not `onJoin`). Start the game afresh from the
   * remaining players so the simulation and the state agree again.
   */
  onRestoreRoom() {
    for (const sessionId of [...this.state.players.keys()]) {
      if (this.clients.getById(sessionId) || this.hasReservedSeat(sessionId)) { continue }
      console.log(sessionId, "dropped on restore (no seat to reconnect into)")
      this.state.players.delete(sessionId)
    }
    if (this.state.phase === "playing") { this.startGame() }
  }

  onDispose() {
    this.stopGame()
    console.log("room", this.roomId, "disposing...")
  }

  /** Start the selected mini-game once every player in the room is ready. */
  protected startIfAllReady() {
    if (this.state.phase !== "selection" || this.state.players.size === 0) { return }
    for (const player of this.state.players.values()) {
      if (!player.ready) { return }
    }
    this.startGame()
  }

  /** Switch to `"playing"` and start the selected mini-game's simulation (if it has one). */
  protected startGame() {
    this.stopGame()
    this.state.phase = "playing"
    this.activeGame = serverMiniGame(this.state.selectedMiniGame)?.(this.state)
    console.log("room", this.roomId, "started", this.state.selectedMiniGame)
  }

  /** Dispose the running simulation, clearing what it put in the state. */
  protected stopGame() {
    this.activeGame?.dispose()
    this.activeGame = undefined
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
    this.stopGame()
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
