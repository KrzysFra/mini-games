import assert from "assert";

import {
  CAR_LENGTH, CAR_MAX_SPEED, PHYSICS_STEP_MS, PHYSICS_SUBSTEPS,
} from "../src/shared/games/car-roquelike/constants.js";
import {
  addCar, createCarWorld, destroyCarWorld, readCar, resolveCarControls, stepCarWorld, writeCar,
  type CarInput, type CarWorld,
} from "../src/shared/games/car-roquelike/physics.js";

const step = (world: CarWorld, inputs: Map<string, CarInput>, ticks: number) => {
  for (let i = 0; i < ticks; i++) {
    stepCarWorld(world, inputs, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
  }
};

/** Wanted direction (+y down), optionally with the handbrake held. */
const toward = (dirX: number, dirY: number, handbrake = false): CarInput => ({ dirX, dirY, handbrake });
const deg = (degrees: number) => (degrees * Math.PI) / 180;
const direction = (degrees: number, length = 1) => toward(Math.cos(deg(degrees)) * length, Math.sin(deg(degrees)) * length);

/** A world with one car "a" in open space, facing +x. */
const openWorld = () => {
  const world = createCarWorld();
  const car = addCar(world, "a", 0);
  writeCar(car, { x: 1600, y: 1200, angle: 0, vx: 0, vy: 0, av: 0 });
  return { world, car };
};

describe("car-roquelike physics", () => {
  describe("directional controls", () => {
    it("steers toward the wanted direction, harder the further off it is", () => {
      const slight = resolveCarControls(0, direction(15));
      const more = resolveCarControls(0, direction(40));
      const left = resolveCarControls(0, direction(-40));
      assert.ok(slight.steer > 0 && more.steer > slight.steer, "clockwise (screen) = right, grows with the angle");
      assert.strictEqual(left.steer, -more.steer, "mirrored to the left");
      assert.strictEqual(resolveCarControls(0, direction(0)).steer, 0, "straight ahead: no steering");
    });

    it("throttles by the stick's deflection", () => {
      assert.strictEqual(resolveCarControls(0, direction(0, 0.5)).throttle, 0.5);
      assert.strictEqual(resolveCarControls(0, toward(3, 0)).throttle, 1, "capped at 1");
    });

    it("pulls the handbrake beyond 80° off the wanted direction", () => {
      assert.strictEqual(resolveCarControls(0, direction(75)).handbrake, false);
      assert.strictEqual(resolveCarControls(0, direction(85)).handbrake, true);
      assert.strictEqual(resolveCarControls(0, direction(-170)).handbrake, true);
      // Measured from the heading, across the ±180° seam
      assert.strictEqual(resolveCarControls(deg(170), direction(-170)).handbrake, false);
    });

    it("brakes when the stick is centered", () => {
      const centered = resolveCarControls(0, toward(0, 0));
      assert.strictEqual(centered.brake, true);
      assert.strictEqual(centered.throttle, 0);
      assert.strictEqual(centered.handbrake, false);
    });
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
    // Down the screen (+y) = 90° clockwise of its heading
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
    const slide = (handbrake: boolean) => {
      const { world, car } = openWorld();
      // Moving fast along +x, but turned 90°: the old motion is now all sideways
      writeCar(car, { x: 1600, y: 1200, angle: Math.PI / 2, vx: 10, vy: 0, av: 0 });
      step(world, new Map([["a", toward(0, 0, handbrake)]]), 5);
      return car.position.x - 1600;
    };
    assert.ok(slide(true) > slide(false) * 2, "the handbrake keeps much more sideways speed");
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
    // Head-on: centers stay about a car length apart (a little overlap is matter's contact slop)
    assert.ok(closest > CAR_LENGTH * 0.8, `centers stayed apart (closest = ${closest.toFixed(1)})`);
  });

  it("stops at the arena walls", () => {
    const { world, car } = openWorld();
    writeCar(car, { x: 1600, y: 1900, angle: Math.PI / 2, vx: 0, vy: 0, av: 0 });
    step(world, new Map([["a", direction(90)]]), 150);
    assert.ok(car.position.y < 2400 - 80, `stayed inside (y = ${car.position.y.toFixed(1)})`);
  });
});
