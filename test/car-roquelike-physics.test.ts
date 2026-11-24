import assert from "assert";

import {
  CAR_LENGTH, CAR_MAX_SPEED, DIRT_SPEED_FACTOR, PHYSICS_STEP_MS, PHYSICS_SUBSTEPS, ROAD_WIDTH,
} from "../src/shared/games/car-roquelike/constants.js";
import { SPAWN_POINTS } from "../src/shared/games/car-roquelike/map.js";
import {
  CHUNK_JITTER, COUNTDOWN_TICKS, DESTRUCTION_SPEED, destructionFrontS, isDestroyed,
} from "../src/shared/games/car-roquelike/destruction.js";
import {
  buildRoad, CORNER_MAX_RADIUS, CORNER_MAX_TURN, CORNER_MIN_RADIUS, ensureRoad, isOnRoad, ownerWindowStart, pruneRoad, ROAD_AHEAD,
  ROAD_KEEP_BEHIND, START_STRAIGHT_LENGTH, STRAIGHT_MAX_LENGTH, STRAIGHT_MIN_LENGTH, type Road,
} from "../src/shared/games/car-roquelike/road.js";
import {
  addCar, createCarWorld, destroyCarWorld, readCar, resolveCarControls, stepCarRound, stepCarWorld, writeCar,
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

  describe("road", () => {
    /** A road generated to at least `length`. */
    const roadTo = (seed: number, length: number) => {
      const road = buildRoad(seed);
      ensureRoad(road, length);
      return road;
    };
    const committed = (road: Road) => road.pieces.slice(0, road.committedPieces);
    const road = roadTo(12345, 60_000);

    it("is the same for the same seed, and different for another", () => {
      assert.deepStrictEqual(committed(roadTo(12345, 60_000)), committed(road));
      assert.notDeepStrictEqual(committed(roadTo(54321, 60_000)), committed(road));
    });

    it("is the same however it's generated: all at once, or bit by bit while old road is pruned", () => {
      const bitByBit = buildRoad(12345);
      for (let front = 0; bitByBit.committedLength < 60_000; front += 500) {
        ensureRoad(bitByBit, front + 6000);
        pruneRoad(bitByBit, front);
      }
      const n = Math.min(bitByBit.committedPieces, road.committedPieces);
      assert.deepStrictEqual(bitByBit.pieces.slice(0, n), road.pieces.slice(0, n));
    });

    it("is endless: generated on demand, while the data kept stays bounded", () => {
      const endless = buildRoad(99);
      let mostSamples = 0;
      for (let front = 0; front < 500_000; front += 2000) {
        ensureRoad(endless, front + 10_000);
        pruneRoad(endless, front);
        mostSamples = Math.max(mostSamples, endless.samples.length);
      }
      assert.ok(endless.committedLength >= 500_000);
      assert.ok(mostSamples < 3000, `at most ${mostSamples} samples kept`);
    });

    it("starts with a straight north from the origin", () => {
      const first = road.pieces[0];
      assert.deepStrictEqual(
        { kind: first.kind, x: first.x, y: first.y, heading: first.heading, length: first.length },
        { kind: "straight", x: 0, y: 0, heading: -Math.PI / 2, length: START_STRAIGHT_LENGTH },
      );
      assert.ok(buildRoad(1).committedLength >= ROAD_AHEAD, "a new road is ready well past the spawns");
    });

    it("is made of straights of 400..2000 and corners of radius 400..2000 turning up to 120°", () => {
      for (const piece of committed(road).slice(1)) {
        if (piece.kind === "straight") {
          assert.ok(piece.length >= STRAIGHT_MIN_LENGTH && piece.length <= STRAIGHT_MAX_LENGTH, `straight ${piece.length}`);
        } else {
          assert.ok(piece.radius >= CORNER_MIN_RADIUS && piece.radius <= CORNER_MAX_RADIUS, `radius ${piece.radius}`);
          assert.ok(Math.abs(piece.turn) <= CORNER_MAX_TURN, `turn ${piece.turn}`);
        }
      }
      assert.ok(road.pieces.some(p => p.kind === "corner"), "has corners");
    });

    it("is continuous: every piece starts where the previous one ended", () => {
      for (let k = 1; k < road.pieces.length; k++) {
        const piece = road.pieces[k];
        const prev = road.pieces[k - 1];
        assert.ok(Math.abs(piece.startS - (prev.startS + prev.length)) < 1e-6);
      }
    });

    it("never crosses the road still around (it may cross long-deleted road)", () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const samples = roadTo(seed, 60_000).samples;
        for (let a = 0; a < samples.length; a += 4) {
          for (let b = a + 4; b < samples.length; b += 4) {
            const apart = samples[b].s - samples[a].s;
            if (apart < 3 * ROAD_WIDTH || apart > 10_000) continue;
            const gap = Math.hypot(samples[a].x - samples[b].x, samples[a].y - samples[b].y);
            assert.ok(gap > ROAD_WIDTH, `seed ${seed}: s ${samples[a].s} and ${samples[b].s} are ${gap.toFixed(0)} apart`);
          }
        }
      }
    });

    it("is ROAD_WIDTH wide, with square ends", () => {
      const inUse = road.samples.filter((_, k) => k % 50 === 25 && road.sampleBase + k < road.committedSamples);
      for (const sample of inUse) {
        // Sideways from the centerline: (−sin, cos) of the heading
        const side = (offset: number) =>
          isOnRoad(road, sample.x - Math.sin(sample.heading) * offset, sample.y + Math.cos(sample.heading) * offset, 0);
        assert.ok(side(0) && side(ROAD_WIDTH / 2 - 5) && side(-ROAD_WIDTH / 2 + 5), `on the road at s ${sample.s}`);
        assert.ok(!side(ROAD_WIDTH / 2 + 5) && !side(-ROAD_WIDTH / 2 - 5), `dirt beside the road at s ${sample.s}`);
      }
      assert.ok(isOnRoad(road, 0, -5, 0));
      assert.ok(!isOnRoad(road, 0, 5, 0), "nothing before the start");
    });

    it("is gone (dirt again) more than ROAD_KEEP_BEHIND behind the front", () => {
      const frontS = 20_000;
      const tail = frontS - ROAD_KEEP_BEHIND;
      const inUse = road.samples.filter((_, k) => k % 20 === 0 && road.sampleBase + k < road.committedSamples);
      for (const sample of inUse) {
        if (sample.s < tail - 50) assert.ok(!isOnRoad(road, sample.x, sample.y, frontS), `deleted at s ${sample.s}`);
        if (sample.s > tail + 50) assert.ok(isOnRoad(road, sample.x, sample.y, frontS), `still there at s ${sample.s}`);
      }
    });
  });

  describe("destruction", () => {
    const road = buildRoad(777);
    ensureRoad(road, 40_000);

    it("waits for the countdown at the road's start, then moves along it at DESTRUCTION_SPEED", () => {
      assert.strictEqual(destructionFrontS(0), 0);
      assert.strictEqual(destructionFrontS(COUNTDOWN_TICKS), 0);
      const perTick = destructionFrontS(COUNTDOWN_TICKS + 1) - destructionFrontS(COUNTDOWN_TICKS);
      assert.ok(Math.abs(perTick - PHYSICS_SUBSTEPS * DESTRUCTION_SPEED) < 1e-6, `per tick = ${perTick}`);
      assert.ok(DESTRUCTION_SPEED < CAR_MAX_SPEED, "outrunnable at full speed");
    });

    it("is a band that follows the road: void behind the front, ground restored past ROAD_KEEP_BEHIND", () => {
      const frontS = 30_000;
      const tail = frontS - ROAD_KEEP_BEHIND;
      for (const sample of road.samples.filter((_, k) => k % 8 === 0)) {
        for (const offset of [0, 300, -300]) {
          const x = sample.x - Math.sin(sample.heading) * offset;
          const y = sample.y + Math.cos(sample.heading) * offset;
          const where = `s ${sample.s}, offset ${offset}`;
          if (sample.s > tail + 100 && sample.s < frontS - 100) assert.ok(isDestroyed(road, x, y, frontS), `void at ${where}`);
          // Deleted road owns its ground for a while (further back, the nearest road around does)
          if (sample.s < tail - 100 && sample.s > ownerWindowStart(frontS) + 600) {
            assert.ok(!isDestroyed(road, x, y, frontS), `restored at ${where}`);
          }
          if (sample.s > frontS + CHUNK_JITTER + 100 && sample.s < frontS + 5000) {
            assert.ok(!isDestroyed(road, x, y, frontS), `ahead at ${where}`);
          }
        }
      }
    });

    it("voids everything around the start before the front moves, and restores it later", () => {
      assert.ok(isDestroyed(road, 0, 500, 0), "south of the start");
      assert.ok(isDestroyed(road, -2000, 2000, 0), "far behind the start");
      for (const spawn of SPAWN_POINTS) assert.ok(!isDestroyed(road, spawn.x, spawn.y, 0), "but not the spawns");
      assert.ok(!isDestroyed(road, 0, 500, 1500), "restored once the front is past ROAD_KEEP_BEHIND");
    });

    it("has a ragged edge, not a straight line", () => {
      // Across the first straight (heading north), where the edge is with the front at 1000
      const edgeAt = (x: number) => {
        let y = 0;
        while (isDestroyed(road, x, y - 10, 1000)) y -= 10;
        return y;
      };
      const edges = new Set([-180, -120, -60, 0, 60, 120, 180].map(edgeAt));
      assert.ok(edges.size > 1, "the edge varies across the road");
    });

    it("freezes cars during the countdown", () => {
      const { world, car } = openWorld();
      stepCarRound(world, new Map([["a", direction(0)]]), 0, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
      assert.strictEqual(car.position.x, 1600);
    });

    it("eliminates (removes) a car once it's over destroyed ground", () => {
      const world = createCarWorld();
      const spawned = addCar(world, "a", 0);
      const { x: startX, y: startY } = spawned.position;
      const inputs = new Map<string, CarInput>();
      let tick = COUNTDOWN_TICKS;
      let eliminated: string[] = [];
      while (world.cars.has("a") && tick < COUNTDOWN_TICKS + 1000) {
        eliminated = stepCarRound(world, inputs, tick++, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
      }
      assert.deepStrictEqual(eliminated, ["a"]);
      assert.ok(isDestroyed(world.road, startX, startY, destructionFrontS(tick)), "the front had reached the parked car");
    });
  });

  describe("road and dirt", () => {
    /** Forward speed after driving north for `ticks` from (x, y), starting at `speed`. */
    const driveNorth = (x: number, y: number, speed: number, ticks: number) => {
      const { world, car } = openWorld();
      writeCar(car, { x, y, angle: -Math.PI / 2, vx: 0, vy: -speed, av: 0 });
      step(world, new Map([["a", direction(-90)]]), ticks);
      return -car.velocity.y;
    };
    /** Far off to the side of every road: always dirt. */
    const DIRT_X = 200_000;

    it("spawns every seat on the road's first straight, facing north", () => {
      const road = createCarWorld().road;
      for (const spawn of SPAWN_POINTS) {
        assert.ok(isOnRoad(road, spawn.x, spawn.y, 0), `spawn (${spawn.x}, ${spawn.y}) is on the road`);
        assert.ok(-spawn.y < START_STRAIGHT_LENGTH - CAR_LENGTH, "on the first piece");
        assert.strictEqual(spawn.angle, -Math.PI / 2);
      }
    });

    it("keeps full top speed on the road", () => {
      // Up the first straight (2000 long): 30 ticks at top speed is ~840
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
