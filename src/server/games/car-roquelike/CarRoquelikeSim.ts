import type { InputAPI, StepContext } from "colyseus";
import { MAX_PLAYERS_PER_ROOM } from "../../../shared/constants.js";
import {
  addCar, createCarWorld, destroyCarWorld, readCar, removeCar, stepCarWorld, toCarInput,
  type CarInput, type CarWorld,
} from "../../../shared/games/car-roquelike/physics.js";
import { Car, type GameInput, type GameSelectionRoomState } from "../../rooms/schema/MiniGameRoomState.js";
import type { ServerMiniGame } from "../types.js";

/**
 * car-roquelike on the server: the authoritative matter world with one car per player.
 * Every tick it applies one input per player, steps the shared physics, and writes each
 * car's state to `state.cars` (which clients adopt for prediction).
 */
export class CarRoquelikeSim implements ServerMiniGame {
  private world: CarWorld = createCarWorld();
  private inputs = new Map<string, CarInput>();

  constructor(private state: GameSelectionRoomState) {
    for (const sessionId of state.players.keys()) {
      this.addPlayer(sessionId);
    }
  }

  addPlayer(sessionId: string) {
    if (this.state.cars.has(sessionId)) { return; }

    const seat = this.freeSeat();
    const body = addCar(this.world, sessionId, seat);
    this.state.cars.set(sessionId, new Car({ ...readCar(body), seat }));
  }

  removePlayer(sessionId: string) {
    removeCar(this.world, sessionId);
    this.inputs.delete(sessionId);
    this.state.cars.delete(sessionId);
  }

  step(ctx: StepContext, inputs: InputAPI<GameInput>) {
    // A shared world: exactly one input per player per tick (an empty tick repeats the last one,
    // see the room's `idle` policy), so the server's ack matches what it simulated
    for (const sessionId of this.world.cars.keys()) {
      const input = inputs.get(sessionId).next();
      if (input) {
        this.inputs.set(sessionId, toCarInput(input, this.inputs.get(sessionId)));
      } else {
        this.inputs.delete(sessionId);
      }
    }

    stepCarWorld(this.world, this.inputs, ctx.subSteps, ctx.subDtMs);

    for (const [sessionId, body] of this.world.cars) {
      const car = this.state.cars.get(sessionId);
      if (car) { readCar(body, car); }
    }
  }

  dispose() {
    destroyCarWorld(this.world);
    this.inputs.clear();
    this.state.cars.clear();
  }

  /** The lowest seat no car uses (seats pick spawn points and colors). */
  private freeSeat(): number {
    const taken = new Set([...this.state.cars.values()].map(car => car.seat));
    for (let seat = 0; seat < MAX_PLAYERS_PER_ROOM; seat++) {
      if (!taken.has(seat)) { return seat; }
    }
    return taken.size;
  }
}
