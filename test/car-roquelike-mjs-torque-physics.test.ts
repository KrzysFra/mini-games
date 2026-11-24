import assert from "assert";

import {
  CAR_GRIP_MAX, CAR_LENGTH, CAR_MAX_SPEED, DIRT_SPEED_FACTOR, PHYSICS_STEP_MS, PHYSICS_SUBSTEPS,
} from "../src/shared/games/car-roquelike-mjs-torque/constants.js";
import {
  addCar, createCarWorld, destroyCarWorld, readCar, resolveCarControls, stepCarRound, stepCarWorld, writeCar,
  type CarInput, type CarWorld,
} from "../src/shared/games/car-roquelike-mjs-torque/physics.js";

/** The force-driven clone's handling; road and destruction are shared with car-roquelike (tested there). */

const step = (world: CarWorld, inputs: Map<string, CarInput>, ticks: number) => {
  for (let i = 0; i < ticks; i++) {
    stepCarWorld(world, inputs, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
  }
};

/** Wanted direction (+y down), optionally with the handbrake held. */
const toward = (dirX: number, dirY: number, handbrake = false): CarInput => ({ dirX, dirY, handbrake });
const deg = (degrees: number) => (degrees * Math.PI) / 180;
const direction = (degrees: number, length = 1) => toward(Math.cos(deg(degrees)) * length, Math.sin(deg(degrees)) * length);
/** Sideways speed of a body, in its own frame. */
const sideways = (car: { angle: number; velocity: { x: number; y: number } }) =>
  -car.velocity.x * Math.sin(car.angle) + car.velocity.y * Math.cos(car.angle);

/** A world with one car "a" in open space, facing +x. */
const openWorld = () => {
  const world = createCarWorld();
  const car = addCar(world, "a", 0);
  writeCar(car, { x: 1600, y: 1200, angle: 0, vx: 0, vy: 0, av: 0 });
  return { world, car };
};

describe("car-roquelike-mjs-torque physics", () => {
  it("steers toward the wanted direction (same controls as car-roquelike)", () => {
    assert.ok(resolveCarControls(0, direction(40)).steer > resolveCarControls(0, direction(15)).steer);
    assert.strictEqual(resolveCarControls(0, direction(85)).handbrake, true);
    assert.strictEqual(resolveCarControls(0, toward(0, 0)).brake, true);
  });

  it("is deterministic: the same inputs give the same result", () => {
    const run = () => {
      const world = createCarWorld();
      addCar(world, "a", 0);
      addCar(world, "b", 1);
      const inputs = new Map([["a", direction(30)], ["b", direction(200, 0.7)]]);
      step(world, inputs, 90);
      const result = [readCar(world.cars.get("a")), readCar(world.cars.get("b"))];
      destroyCarWorld(world);
      return result;
    };
    assert.deepStrictEqual(run(), run());
  });

  it("drives straight when pointed where it faces", () => {
    const { world, car } = openWorld();
    step(world, new Map([["a", direction(0)]]), 30);
    assert.ok(car.position.x > 1700, `moved along +x (x = ${car.position.x})`);
    assert.ok(Math.abs(car.position.y - 1200) < 1, "no sideways drift");
  });

  it("turns to face the wanted direction and settles there", () => {
    const { world, car } = openWorld();
    step(world, new Map([["a", direction(90)]]), 90);
    assert.ok(Math.abs(car.angle - deg(90)) < deg(10), `faces down (angle = ${(car.angle * 180 / Math.PI).toFixed(1)}°)`);
    assert.ok(car.position.y > 1300, "and drives that way");
  });

  it("turns around when pointed behind it", () => {
    const { world, car } = openWorld();
    step(world, new Map([["a", direction(180)]]), 120);
    const heading = Math.atan2(Math.sin(car.angle), Math.cos(car.angle));
    assert.ok(Math.abs(Math.abs(heading) - Math.PI) < deg(15), `faces -x (heading = ${(heading * 180 / Math.PI).toFixed(1)}°)`);
  });

  it("brakes to a stop (without reversing) when the stick is let go", () => {
    const { world, car } = openWorld();
    writeCar(car, { x: 1600, y: 1200, angle: 0, vx: CAR_MAX_SPEED, vy: 0, av: 0 });
    step(world, new Map([["a", toward(0, 0)]]), 20);
    assert.ok(Math.hypot(car.velocity.x, car.velocity.y) < 0.01, "stopped");
    const stoppedAt = car.position.x;
    step(world, new Map([["a", toward(0, 0)]]), 10);
    assert.ok(Math.abs(car.position.x - stoppedAt) < 0.01, "stays put, no reverse");
  });

  it("slides sideways more with the handbrake held", () => {
    // A sideways speed the tyres would catch (a fully sideways slide slides either way)
    const slide = (handbrake: boolean) => {
      const { world, car } = openWorld();
      writeCar(car, { x: 1600, y: 1200, angle: Math.PI / 2, vx: 2.5, vy: 0, av: 0 });
      step(world, new Map([["a", toward(0, 0, handbrake)]]), 5);
      return car.position.x - 1600;
    };
    assert.ok(slide(true) > slide(false) * 2, "the handbrake keeps much more sideways speed");
  });

  it("holds a full-speed corner within its grip", () => {
    const { world, car } = openWorld();
    writeCar(car, { x: 1600, y: 1200, angle: 0, vx: CAR_MAX_SPEED, vy: 0, av: 0 });
    // Stay 60° right of the heading: full steer, no handbrake
    let most = 0;
    for (let tick = 0; tick < 60; tick++) {
      step(world, new Map([["a", direction((car.angle * 180) / Math.PI + 60)]]), 1);
      if (tick > 20) most = Math.max(most, Math.abs(sideways(car)));
    }
    destroyCarWorld(world);
    assert.ok(most < CAR_GRIP_MAX, `barely slides sideways (up to ${most.toFixed(2)})`);
  });

  it("cars driving into each other collide instead of passing through", () => {
    const world = createCarWorld();
    const a = addCar(world, "a", 0);
    const b = addCar(world, "b", 1);
    writeCar(a, { x: 1300, y: 1200, angle: 0, vx: 0, vy: 0, av: 0 });
    writeCar(b, { x: 1900, y: 1200, angle: Math.PI, vx: 0, vy: 0, av: 0 });

    const inputs = new Map([["a", direction(0)], ["b", direction(180)]]);
    let closest = Infinity;
    for (let tick = 0; tick < 90; tick++) {
      step(world, inputs, 1);
      closest = Math.min(closest, Math.abs(b.position.x - a.position.x));
    }
    assert.ok(a.position.x < b.position.x, "they never swap sides");
    assert.ok(closest > CAR_LENGTH * 0.8, `centers stayed apart (closest = ${closest.toFixed(1)})`);
  });

  it("a car hit in the side overpowers its grip: shoved off its line and turned, then grips again", () => {
    const world = createCarWorld();
    const a = addCar(world, "a", 0);
    const b = addCar(world, "b", 1);
    writeCar(a, { x: 1600, y: 1350, angle: -Math.PI / 2, vx: 0, vy: -14, av: 0 });
    writeCar(b, { x: 1465, y: 1200, angle: 0, vx: 14, vy: 0, av: 0 });
    const inputs = new Map([["a", direction(-90)], ["b", direction(0)]]);
    let maxTurn = 0;
    let maxSide = 0;
    for (let tick = 0; tick < 40; tick++) {
      step(world, inputs, 1);
      maxTurn = Math.max(maxTurn, Math.abs(b.angle));
      maxSide = Math.max(maxSide, Math.abs(sideways(b)));
    }
    destroyCarWorld(world);
    assert.ok(maxSide > CAR_GRIP_MAX * 2, `slid (sideways up to ${maxSide.toFixed(2)})`);
    assert.ok(Math.abs(b.position.y - 1200) > 20, `shoved sideways (y = ${b.position.y.toFixed(1)})`);
    assert.ok(maxTurn > deg(10), `turned (up to ${(maxTurn * 180 / Math.PI).toFixed(1)}°)`);
    assert.ok(Math.abs(sideways(b)) < 0.5, `grips again (sideways ${sideways(b).toFixed(2)})`);
  });

  it("freezes cars during the countdown", () => {
    const { world, car } = openWorld();
    stepCarRound(world, new Map([["a", direction(0)]]), 0, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
    assert.strictEqual(car.position.x, 1600);
  });

  describe("road and dirt", () => {
    /** Forward speed after driving north for `ticks` from (x, y), starting at `speed`. */
    const driveNorth = (x: number, y: number, speed: number, ticks: number) => {
      const { world, car } = openWorld();
      writeCar(car, { x, y, angle: -Math.PI / 2, vx: 0, vy: -speed, av: 0 });
      step(world, new Map([["a", direction(-90)]]), ticks);
      return -car.velocity.y;
    };
    const DIRT_X = 200_000;

    it("keeps full top speed on the road", () => {
      const speed = driveNorth(0, -100, CAR_MAX_SPEED, 30);
      assert.ok(Math.abs(speed - CAR_MAX_SPEED) < 0.01, `speed = ${speed.toFixed(2)}`);
    });

    it("only reaches the reduced top speed on dirt", () => {
      const speed = driveNorth(DIRT_X, 0, 0, 120);
      assert.ok(Math.abs(speed - CAR_MAX_SPEED * DIRT_SPEED_FACTOR) < 0.01, `speed = ${speed.toFixed(2)}`);
    });

    it("rolls down to the dirt top speed instead of stopping dead", () => {
      const dirtMax = CAR_MAX_SPEED * DIRT_SPEED_FACTOR;
      const early = driveNorth(DIRT_X, 0, CAR_MAX_SPEED, 1);
      assert.ok(early > dirtMax + 1, `still fast right after entering (${early.toFixed(2)})`);
      const later = driveNorth(DIRT_X, 0, CAR_MAX_SPEED, 60);
      assert.ok(Math.abs(later - dirtMax) < 0.01, `settled at the dirt cap (${later.toFixed(2)})`);
    });
  });
});
