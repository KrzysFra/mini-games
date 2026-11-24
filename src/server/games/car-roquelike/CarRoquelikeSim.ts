import type { InputAPI, StepContext } from "colyseus";
import { MAX_PLAYERS_PER_ROOM } from "../../../shared/constants.js";
import { toCarInput, type CarInput } from "../../../shared/games/car-roquelike/controls.js";
import {
  addCar, clearObstacles, createCarWorld, destroyCarWorld, maintainRoad, readCar, removeCar, runningStartPose,
  spawnObstacles, stepCarRound, type CarWorld,
} from "../../../shared/games/car-roquelike/physics.js";
import { destructionFrontS } from "../../../shared/games/car-roquelike/destruction.js";
import { buildRoad } from "../../../shared/games/car-roquelike/road.js";
import {
  Car, ObstacleCar, type GameInput, type GameSelectionRoomState,
} from "../../rooms/schema/MiniGameRoomState.js";
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
    // Joining during the running start: alongside the others (later, where they took over)
    const body = addCar(this.world, sessionId, seat, runningStartPose(seat, this.state.roadSeed, this.state.carRoundTick));
    this.state.cars.set(sessionId, new Car({ ...readCar(body), inX: 0, inY: 0, inButtons: 0, seat }));
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

    const frontS = destructionFrontS(this.state.carRoundTick);
    maintainRoad(this.world, frontS);
    spawnObstacles(this.world, frontS);
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
    this.syncObstacles();

    this.restartIfAllEliminated();
  }

  /** Mirror the world's obstacles into `state.obstacles` (spawned, moved, gone). */
  private syncObstacles() {
    const { obstacles } = this.world;
    for (const id of this.state.obstacles.keys()) {
      if (!obstacles.has(id)) { this.state.obstacles.delete(id); }
    }
    for (const [id, obstacle] of obstacles) {
      let car = this.state.obstacles.get(id);
      if (!car) {
        const { kind, speed, lane, slot } = obstacle;
        this.state.obstacles.set(id, new ObstacleCar({ ...readCar(obstacle.body), kind, speed, lane, slot }));
      } else {
        readCar(obstacle.body, car);
      }
    }
  }

  /**
   * Jump the round to `roundTick` (tests skip the countdown with it): the front follows from the
   * tick, and every car is put where the running start has it by then.
   */
  setRoundTick(roundTick: number) {
    this.state.carRoundTick = roundTick;
    // (a copy of the ids: addCar re-inserts each one)
    for (const sessionId of [...this.world.cars.keys()]) {
      const car = this.state.cars.get(sessionId);
      if (car) { readCar(addCar(this.world, sessionId, car.seat, runningStartPose(car.seat, this.state.roadSeed, roundTick)), car); }
    }
  }

  dispose() {
    destroyCarWorld(this.world);
    this.inputs.clear();
    this.state.cars.clear();
    this.state.obstacles.clear();
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
    // The new road first: its seed staggers the spawns
    this.newRoad();
    for (const [sessionId, car] of this.state.cars) {
      readCar(addCar(this.world, sessionId, car.seat), car);
      car.eliminated = false;
    }
    this.state.carRoundTick = 0;
    this.state.carRound++;
  }

  /** A fresh random road for the round (clients build the same one from `roadSeed`). */
  private newRoad() {
    this.state.roadSeed = Math.floor(Math.random() * 0x100000000) >>> 0;
    // Its own instance (not the shared `getRoad` cache): the road grows and prunes with this room's front
    this.world.road = buildRoad(this.state.roadSeed);
    // The old road's obstacles go with it; the new road's spawn as it comes into play
    clearObstacles(this.world);
    this.state.obstacles.clear();
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
