import type { InputAPI, StepContext } from "colyseus";
import { MAX_PLAYERS_PER_ROOM } from "../../../shared/constants.js";
import {
  addCar, createCarWorld, destroyCarWorld, maintainRoad, readCar, removeCar, stepCarRound, toCarInput,
  type CarInput, type CarWorld,
} from "../../../shared/games/car-roquelike/physics.js";
import { destructionFrontS } from "../../../shared/games/car-roquelike/destruction.js";
import { buildRoad } from "../../../shared/games/car-roquelike/road.js";
import { Car, type GameInput, type GameSelectionRoomState } from "../../rooms/schema/MiniGameRoomState.js";
import type { ServerMiniGame } from "../types.js";

/**
 * car-roquelike on the server: the authoritative matter world with one car per player.
 * Every tick it applies one input per player, steps the shared round (countdown, physics,
 * destruction front), and writes each car's state to `state.cars` (which clients adopt for
 * prediction). Cars caught by the front are eliminated; once every car is, the round restarts.
 */
export class CarRoquelikeSim implements ServerMiniGame {
  private world: CarWorld = createCarWorld();
  private inputs = new Map<string, CarInput>();
  private eliminated: string[] = [];

  constructor(private state: GameSelectionRoomState) {
    state.carRound = 0;
    state.carRoundTick = 0;
    this.newRoad();
    for (const sessionId of state.players.keys()) {
      this.addPlayer(sessionId);
    }
  }

  addPlayer(sessionId: string) {
    if (this.state.cars.has(sessionId)) { return; }

    const seat = this.freeSeat();
    const body = addCar(this.world, sessionId, seat);
    this.state.cars.set(sessionId, new Car({ ...readCar(body), slip: 0, inX: 0, inY: 0, inButtons: 0, seat }));
  }

  removePlayer(sessionId: string) {
    removeCar(this.world, sessionId);
    this.inputs.delete(sessionId);
    this.state.cars.delete(sessionId);
    this.restartIfAllEliminated();
  }

  step(ctx: StepContext, inputs: InputAPI<GameInput>) {
    // A shared world: exactly one input per player per tick (an empty tick repeats the last one,
    // see the room's `idle` policy), so the server's ack matches what it simulated. Eliminated
    // players keep sending, and their inputs are consumed too so their acks keep advancing.
    for (const [sessionId, car] of this.state.cars) {
      const input = inputs.get(sessionId).next();
      if (input && this.world.cars.has(sessionId)) {
        this.inputs.set(sessionId, toCarInput(input, this.inputs.get(sessionId)));
        car.inX = input.x;
        car.inY = input.y;
        car.inButtons = input.buttons;
      } else {
        this.inputs.delete(sessionId);
        car.inX = 0;
        car.inY = 0;
        car.inButtons = 0;
      }
    }

    maintainRoad(this.world, destructionFrontS(this.state.carRoundTick));
    stepCarRound(this.world, this.inputs, this.state.carRoundTick, ctx.subSteps, ctx.subDtMs, this.eliminated);
    this.state.carRoundTick++;

    for (const sessionId of this.eliminated) {
      this.inputs.delete(sessionId);
      const car = this.state.cars.get(sessionId);
      if (car) { car.eliminated = true; }
    }
    for (const [sessionId, body] of this.world.cars) {
      const car = this.state.cars.get(sessionId);
      if (car) { readCar(body, car); }
    }

    this.restartIfAllEliminated();
  }

  dispose() {
    destroyCarWorld(this.world);
    this.inputs.clear();
    this.state.cars.clear();
    this.state.carRound = 0;
    this.state.carRoundTick = 0;
  }

  /** Everyone is out: start a new round (countdown again), every car back at its seat's spawn. */
  private restartIfAllEliminated() {
    if (this.state.cars.size === 0) { return; }
    for (const car of this.state.cars.values()) {
      if (!car.eliminated) { return; }
    }

    this.inputs.clear();
    for (const [sessionId, car] of this.state.cars) {
      readCar(addCar(this.world, sessionId, car.seat), car);
      car.eliminated = false;
    }
    this.state.carRoundTick = 0;
    this.state.carRound++;
    this.newRoad();
  }

  /** A fresh random road for the round (clients build the same one from `roadSeed`). */
  private newRoad() {
    this.state.roadSeed = Math.floor(Math.random() * 0x100000000) >>> 0;
    // Its own instance (not the shared `getRoad` cache): the road grows and prunes with this room's front
    this.world.road = buildRoad(this.state.roadSeed);
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
