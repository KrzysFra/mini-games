import assert from "assert";
import Matter from "matter-js";

import {
  CAR_LENGTH, CAR_MAX_SPEED, CAR_WIDTH, DIRT_SPEED_FACTOR, PHYSICS_STEP_MS, PHYSICS_SUBSTEPS, ROAD_WIDTH, RUNNING_START_DISTANCE,
} from "../src/shared/games/car-roquelike/constants.js";
import { SPAWN_POINTS, SPAWN_STAGGER_MAX, SPAWN_STAGGER_MIN, spawnPoint, spawnSlot } from "../src/shared/games/car-roquelike/map.js";
import { cameraCenter, isOutOfView, VIEW_HALF_HEIGHT, VIEW_HALF_WIDTH } from "../src/shared/games/car-roquelike/camera.js";
import {
  CHUNK_JITTER, COUNTDOWN_TICKS, DESTRUCTION_SPEED, destructionFrontS, isDestroyed,
} from "../src/shared/games/car-roquelike/destruction.js";
import {
  buildRoad, cameraS, CORNER_MAX_RADIUS, CORNER_MAX_TURN, CORNER_MIN_RADIUS, ensureRoad, ensureRoadAround, isOnRoad, ownerWindowStart,
  piecesInPlay, pointOnPiece, pruneRoad, ROAD_AHEAD, ROAD_BEHIND, ROAD_RADIUS, roadDistanceAt, roadEnd, roadPointAt, roadTail, sampleAt, START_STRAIGHT_LENGTH, STRAIGHT_MAX_LENGTH, STRAIGHT_MIN_LENGTH, type Road,
} from "../src/shared/games/car-roquelike/road.js";
import { resolveCarControls, type CarInput } from "../src/shared/games/car-roquelike/controls.js";
import {
  addCar, createCarWorld, maintainRoad, removeObstacle, runningStartPose, spawnObstacles, stepCarRound, stepCarWorld, writeCar,
  type CarWorld,
} from "../src/shared/games/car-roquelike/physics.js";
import {
  lanePoint, MAX_OBSTACLES, OBSTACLE_KINDS, OBSTACLE_CHANCE, OBSTACLE_KEEP_GAP, OBSTACLE_SEGMENT,
  obstacleWeight, rollObstacle, type ObstacleKind,
} from "../src/shared/games/car-roquelike/obstacles.js";
import { TICK_RATE } from "../src/shared/constants.js";

/** The world: controls, road, destruction, rounds (the handling is in car-roquelike-handling.test.ts). */

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
        ensureRoadAround(bitByBit, front);
        pruneRoad(bitByBit, front);
      }
      const n = Math.min(bitByBit.committedPieces, road.committedPieces);
      assert.deepStrictEqual(bitByBit.pieces.slice(0, n), road.pieces.slice(0, n));
    });

    it("is endless: generated on demand, while the data kept stays bounded", () => {
      const endless = buildRoad(99);
      let mostSamples = 0;
      for (let front = 0; front < 500_000; front += 2000) {
        ensureRoadAround(endless, front);
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
      const fresh = buildRoad(1);
      assert.ok(fresh.committedLength >= roadEnd(fresh, 0), "a new road is generated for the road in play");
      assert.ok(roadEnd(fresh, 0) >= cameraS(0) + ROAD_AHEAD, "which reaches ROAD_AHEAD beyond the camera");
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

    /** Moves the front along a road of each seed, calling `check` at each step. */
    const drive = (seeds: number[], to: number, step: number, check: (road: Road, frontS: number, seed: number) => void) => {
      for (const seed of seeds) {
        const driven = buildRoad(seed);
        for (let frontS = 0; frontS < to; frontS += step) {
          ensureRoadAround(driven, frontS);
          check(driven, frontS, seed);
          pruneRoad(driven, frontS);
        }
      }
    };
    /** How far (x, y) is outside the view with the front at `frontS` (negative: inside). */
    const outsideView = (road: Road, x: number, y: number, frontS: number) => {
      const center = cameraCenter(road, frontS);
      return Math.max(Math.abs(x - center.x) - VIEW_HALF_WIDTH, Math.abs(y - center.y) - VIEW_HALF_HEIGHT);
    };

    it("only adds road off screen: pieces come into play out of view, and are deleted out of view", () => {
      let shown = 0;
      let tailBefore = 0;
      drive([1, 2, 3, 4, 5, 6], 80_000, 30, (driven, frontS) => {
        if (frontS === 0) shown = piecesInPlay(driven, 0);
        for (const inPlay = piecesInPlay(driven, frontS); shown < inPlay; shown++) {
          const piece = driven.pieces[shown];
          for (let u = 0; u <= piece.length; u += 10) {
            const point = pointOnPiece(piece, u);
            const outside = outsideView(driven, point.x, point.y, frontS);
            assert.ok(outside > ROAD_WIDTH / 2, `piece ${shown} comes into play ${outside.toFixed(0)} from the view`);
          }
        }
        if (frontS === 0) tailBefore = 0;
        const tail = roadTail(driven, frontS);
        for (let s = tailBefore; s < tail; s += 25) {
          const point = roadPointAt(driven, s);
          const outside = outsideView(driven, point.x, point.y, frontS);
          assert.ok(outside > ROAD_WIDTH / 2, `s ${s} is deleted ${outside.toFixed(0)} from the view`);
        }
        tailBefore = tail;
      });
    });

    it("never crosses itself: the road in play keeps clear of itself", () => {
      drive([1, 2, 3, 4, 5, 6], 80_000, 1500, (driven, frontS, seed) => {
        const from = roadTail(driven, frontS) / 25;
        const to = Math.ceil(roadEnd(driven, frontS) / 25);
        for (let a = from; a < to; a += 2) {
          for (let b = a + 2; b < to; b += 2) {
            const sa = sampleAt(driven, a);
            const sb = sampleAt(driven, b);
            if (sb.s - sa.s < 3 * ROAD_WIDTH) continue;
            const gap = Math.hypot(sa.x - sb.x, sa.y - sb.y);
            assert.ok(gap > 2 * ROAD_WIDTH, `seed ${seed}: s ${sa.s} and ${sb.s} are ${gap.toFixed(0)} apart`);
          }
        }
      });
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
      const inUse = road.samples.filter((sample, k) => k % 50 === 25 && sample.s < roadEnd(road, 0));
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

    it("is gone (dirt again) ROAD_BEHIND behind the camera, and not there yet beyond the road in play", () => {
      const frontS = 20_000;
      const tail = roadTail(road, frontS);
      assert.ok(Math.abs(cameraS(frontS) - ROAD_BEHIND - tail) <= 25, `tail ${tail} is ROAD_BEHIND behind the camera along the road`);
      const end = roadEnd(road, frontS);
      assert.ok(end >= cameraS(frontS) + ROAD_AHEAD, `the end ${end} is at least ROAD_AHEAD ahead of the camera`);
      for (const sample of road.samples.filter((sample, k) => k % 20 === 0 && sample.s > end + 50 && sample.s < end + 3000)) {
        assert.ok(!isOnRoad(road, sample.x, sample.y, frontS), `not in play yet at s ${sample.s}`);
      }
      const inUse = road.samples.filter((sample, k) => k % 20 === 0 && sample.s < end);
      for (const sample of inUse) {
        if (sample.s < tail - 50) assert.ok(!isOnRoad(road, sample.x, sample.y, frontS), `deleted at s ${sample.s}`);
        if (sample.s > tail + 50) assert.ok(isOnRoad(road, sample.x, sample.y, frontS), `still there at s ${sample.s}`);
      }
    });

    it("deletes road for good: the tail never moves back", () => {
      for (const seed of [1, 2, 3]) {
        const long = buildRoad(seed);
        let prev = 0;
        for (let frontS = 0; frontS < 60_000; frontS += 100) {
          ensureRoadAround(long, frontS);
          const tail = roadTail(long, frontS);
          assert.ok(tail >= prev, `seed ${seed}: tail went back from ${prev} to ${tail}`);
          prev = tail;
          pruneRoad(long, frontS);
        }
        assert.ok(prev > 40_000, `seed ${seed}: the tail followed (at ${prev})`);
      }
    });
  });

  describe("destruction", () => {
    const road = buildRoad(777);
    ensureRoad(road, 40_000);

    it("moves along the road from its start at DESTRUCTION_SPEED, countdown included", () => {
      assert.strictEqual(destructionFrontS(0), 0);
      assert.ok(START_STRAIGHT_LENGTH > RUNNING_START_DISTANCE + 2000, "the running start is all on the first straight");
      for (const tick of [0, COUNTDOWN_TICKS]) {
        const perTick = destructionFrontS(tick + 1) - destructionFrontS(tick);
        assert.ok(Math.abs(perTick - PHYSICS_SUBSTEPS * DESTRUCTION_SPEED) < 1e-6, `per tick = ${perTick}`);
      }
      assert.ok(DESTRUCTION_SPEED < CAR_MAX_SPEED, "outrunnable at full speed");
    });

    it("is a band that follows the road: void behind the front, ground restored behind the road's tail", () => {
      const frontS = 30_000;
      const tail = roadTail(road, frontS);
      for (const sample of road.samples.filter((_, k) => k % 8 === 0)) {
        for (const offset of [0, 300, -300]) {
          const x = sample.x - Math.sin(sample.heading) * offset;
          const y = sample.y + Math.cos(sample.heading) * offset;
          const where = `s ${sample.s}, offset ${offset}`;
          if (sample.s > tail + 100 && sample.s < frontS - 100) assert.ok(isDestroyed(road, x, y, frontS), `void at ${where}`);
          // Deleted road owns its ground for a while (further back, the nearest road around does)
          if (sample.s < tail - 100 && sample.s > ownerWindowStart(road, frontS) + 600) {
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
      // Once the road's start is deleted (out of ROAD_RADIUS of the camera)
      let frontS = 0;
      while (roadTail(road, frontS) === 0) frontS += 100;
      assert.ok(!isDestroyed(road, 0, 500, frontS), `restored once the start is deleted (front at ${frontS})`);
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

    it("gives cars a running start during the countdown: straight north at top speed, ignoring input", () => {
      const world = createCarWorld();
      const a = addCar(world, "a", 0);
      const b = addCar(world, "b", 5);
      assert.deepStrictEqual([a.velocity.x, a.velocity.y], [0, -CAR_MAX_SPEED], "already driving when spawned");
      const inputs = new Map([["a", direction(0)], ["b", direction(180)]]);
      for (let tick = 0; tick < COUNTDOWN_TICKS; tick++) {
        const eliminated = stepCarRound(world, inputs, tick, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
        assert.deepStrictEqual(eliminated, [], "nobody is out during the countdown");
        const frontS = destructionFrontS(tick + 1);
        assert.ok(!isOutOfView(world.road, b.position.x, b.position.y, frontS), "the camera keeps up");
        assert.ok(!isDestroyed(world.road, a.position.x, a.position.y, frontS), "the back row stays clear of the void");
      }
      const seed = world.road.seed;
      const gapStart = -spawnPoint(0, seed).y;
      const gapEnd = -a.position.y - destructionFrontS(COUNTDOWN_TICKS);
      // Seat 0 may start in either row (the grid is shuffled per round); the rows are 100 apart
      assert.ok(gapStart <= CHUNK_JITTER + 150 + 100 + SPAWN_STAGGER_MAX && gapEnd > gapStart + 150, `pulls away from the front (${gapStart} → ${gapEnd})`);
      for (const [car, seat] of [[a, 0], [b, 5]] as const) {
        const spawn = spawnPoint(seat, seed);
        assert.strictEqual(car.position.x, spawn.x, "straight");
        assert.ok(Math.abs(car.position.y - (spawn.y - RUNNING_START_DISTANCE)) < 1e-6, `up by the running start (${car.position.y})`);
        assert.strictEqual(car.angle, -Math.PI / 2);
        assert.deepStrictEqual([car.velocity.x, car.velocity.y], [0, -CAR_MAX_SPEED], "at top speed");
        assert.ok(isOnRoad(world.road, car.position.x, car.position.y, destructionFrontS(COUNTDOWN_TICKS)), "on the road");
      }

      // Then the players take over, at full speed
      stepCarRound(world, inputs, COUNTDOWN_TICKS, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
      assert.ok(a.velocity.x > 0, "a steers east");
      assert.ok(a.position.y < spawnPoint(0, seed).y - RUNNING_START_DISTANCE - CAR_MAX_SPEED, "still rolling north");
    });

    it("eliminates (removes) a car once it's over destroyed ground", () => {
      const world = createCarWorld();
      // Parked where the running start ends
      const spawned = addCar(world, "a", 0, { ...runningStartPose(0, world.road.seed, COUNTDOWN_TICKS), vx: 0, vy: 0 });
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

    it("eliminates (removes) a car whose center leaves the camera's view", () => {
      const world = createCarWorld();
      const frontS = destructionFrontS(COUNTDOWN_TICKS + 1);
      const center = cameraCenter(world.road, frontS);
      // Beside the first straight, on intact dirt: just inside the view's left edge, and just outside
      const inside = addCar(world, "in", 0);
      writeCar(inside, { x: center.x - VIEW_HALF_WIDTH + 50, y: center.y, angle: 0, vx: 0, vy: 0, av: 0 });
      const outside = addCar(world, "out", 1);
      writeCar(outside, { x: center.x - VIEW_HALF_WIDTH - 50, y: center.y, angle: 0, vx: 0, vy: 0, av: 0 });
      assert.ok(!isDestroyed(world.road, outside.position.x, outside.position.y, frontS), "not in the void");

      const eliminated = stepCarRound(world, new Map(), COUNTDOWN_TICKS, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
      assert.deepStrictEqual(eliminated, ["out"]);
      assert.ok(world.cars.has("in") && !world.cars.has("out"));
      assert.ok(isOutOfView(world.road, center.x, center.y - VIEW_HALF_HEIGHT - 1, frontS), "above the view too");
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
      for (let seat = 0; seat < SPAWN_POINTS.length; seat++) {
        const spawn = spawnPoint(seat, road.seed);
        assert.ok(isOnRoad(road, spawn.x, spawn.y, 0), `spawn (${spawn.x}, ${spawn.y}) is on the road`);
        assert.ok(-spawn.y < START_STRAIGHT_LENGTH - CAR_LENGTH, "on the first piece");
        assert.strictEqual(spawn.angle, -Math.PI / 2);
      }
    });

    it("shuffles the seats over the spawn slots per round", () => {
      const orders = new Set<string>();
      for (let seed = 1; seed <= 20; seed++) {
        const slots = SPAWN_POINTS.map((_, seat) => spawnSlot(seat, seed));
        assert.deepStrictEqual([...slots].sort(), SPAWN_POINTS.map((_, i) => i), "every seat gets its own slot");
        orders.add(slots.join());
      }
      assert.ok(orders.size > 15, `the grid order changes between rounds (${orders.size} of 20 differ)`);
    });

    it("staggers the spawns by 1..2 car lengths per round, without overlapping", () => {
      for (const seed of [1, 2, 3, 12345, 0xdeadbeef]) {
        const spawns = SPAWN_POINTS.map((_, seat) => spawnPoint(seat, seed));
        spawns.forEach((spawn, seat) => {
          const stagger = SPAWN_POINTS[spawnSlot(seat, seed)].y - spawn.y;
          assert.ok(stagger >= SPAWN_STAGGER_MIN && stagger <= SPAWN_STAGGER_MAX, `seat ${seat} staggered ${stagger}`);
          assert.deepStrictEqual(spawnPoint(seat, seed), spawn, "the same for every side");
          for (const other of spawns.slice(seat + 1)) {
            const apart = Math.abs(other.x - spawn.x) >= CAR_WIDTH || Math.abs(other.y - spawn.y) >= CAR_LENGTH;
            assert.ok(apart, `seat ${seat} clear of the others`);
          }
        });
        const frontRow = spawns.filter((_, seat) => spawnSlot(seat, seed) < 4);
        assert.ok(new Set(frontRow.map((s) => s.y)).size > 1, "the front row isn't lined up");
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

  describe("obstacle cars", () => {
    /**
     * A round with no players, from the end of the countdown: the server's order each tick (road,
     * spawn, step). `onTick` sees the world after each tick.
     */
    const runObstacles = (seed: number, ticks: number, onTick: (world: CarWorld, tick: number) => void) => {
      const world = createCarWorld(buildRoad(seed));
      for (let tick = COUNTDOWN_TICKS; tick < COUNTDOWN_TICKS + ticks; tick++) {
        const frontS = destructionFrontS(tick);
        maintainRoad(world, frontS);
        spawnObstacles(world, frontS);
        stepCarRound(world, new Map(), tick, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
        onTick(world, tick + 1);
      }
      return world;
    };

    it("are rolled per 100 of road, 30% of the time per 1 of weight, each kind by its weight and in its speed range", () => {
      let spawns = 0;
      // Expected spawns: the chance scales with the total weight (at the segment's middle: close enough)
      let expectedSpawns = 0;
      const byKind = new Map<string, number>();
      // Each spawn's chance of each kind, by the weights where it spawned (they may vary with distance)
      const names = Object.keys(OBSTACLE_KINDS) as ObstacleKind[];
      const expected = new Map<string, number>();
      const segments = 40_000;
      for (let segment = 0; segment < segments; segment++) {
        const middle = (segment + 0.5) * OBSTACLE_SEGMENT;
        expectedSpawns += Math.min(1, OBSTACLE_CHANCE * names.reduce((sum, name) => sum + obstacleWeight(name, middle), 0));
        const roll = rollObstacle(1234, segment);
        if (!roll) continue;
        spawns++;
        byKind.set(roll.kind, (byKind.get(roll.kind) ?? 0) + 1);
        const total = names.reduce((sum, name) => sum + obstacleWeight(name, roll.s), 0);
        for (const name of names) expected.set(name, (expected.get(name) ?? 0) + obstacleWeight(name, roll.s) / total);
        const { minSpeed, maxSpeed } = OBSTACLE_KINDS[roll.kind];
        assert.ok(roll.speed >= Math.fround(minSpeed) && roll.speed <= Math.fround(maxSpeed), `${roll.kind} speed ${roll.speed}`);
        assert.ok(roll.s >= segment * OBSTACLE_SEGMENT && roll.s < (segment + 1) * OBSTACLE_SEGMENT, "in its segment");
        assert.ok(Math.abs(roll.lane) < ROAD_WIDTH / 2 - CAR_WIDTH, "in a lane on the road");
        assert.deepStrictEqual(rollObstacle(1234, segment), roll, "deterministic");
      }
      assert.ok(Math.abs(spawns - expectedSpawns) / segments < 0.02, `${spawns} of ${segments}, expected ${expectedSpawns.toFixed(0)}`);
      for (const name of names) {
        const share = (byKind.get(name) ?? 0) / spawns;
        assert.ok(Math.abs(share - expected.get(name) / spawns) < 0.02, `${name}: ${(share * 100).toFixed(1)}% of spawns`);
      }
    });

    it("include red ones: driving the wrong way at their speed, keeping to their lane", () => {
      let reds = 0;
      let wrongWay = 0;
      let inLane = 0;
      let checked = 0;
      runObstacles(42, 40 * TICK_RATE, (world, tick) => {
        const frontS = destructionFrontS(tick);
        for (const obstacle of world.obstacles.values()) {
          if (obstacle.kind !== "red") continue;
          const { x, y } = obstacle.body.position;
          const s = roadDistanceAt(world.road, x, y, frontS);
          const at = lanePoint(world.road, s, obstacle.lane);
          const along = obstacle.body.velocity.x * Math.cos(at.heading) + obstacle.body.velocity.y * Math.sin(at.heading);
          checked++;
          if (Math.abs(along + obstacle.speed * CAR_MAX_SPEED) < 0.2) wrongWay++;
          if (Math.hypot(x - at.x, y - at.y) < CAR_WIDTH) inLane++;
        }
        reds = Math.max(reds, [...world.obstacles.values()].filter(o => o.kind === "red").length);
      });
      assert.ok(reds > 0, "some red ones");
      // (A brown one that swerves too late may knock one about now and then)
      assert.ok(wrongWay > checked * 0.95, `the wrong way at its speed: ${wrongWay} of ${checked}`);
      assert.ok(inLane > checked * 0.95, `in its lane: ${inLane} of ${checked}`);
    });

    it("spawn on new road, past the first straight, heading their way along it at their own speed", () => {
      const world = createCarWorld(buildRoad(7));
      const frontS = destructionFrontS(COUNTDOWN_TICKS);
      assert.ok(spawnObstacles(world, 0).length < 5, "few at the start: the first straight has none");
      maintainRoad(world, frontS);
      const spawned = spawnObstacles(world, frontS);
      assert.ok(spawned.length > 5, `${spawned.length} spawned on the new road`);
      const center = cameraCenter(world.road, frontS);
      for (const id of spawned) {
        const { body, speed, kind } = world.obstacles.get(id);
        const { x, y } = body.position;
        const { heading } = roadPointAt(world.road, roadDistanceAt(world.road, x, y, frontS));
        const facing = Math.cos(body.angle - heading);
        assert.ok(OBSTACLE_KINDS[kind].direction > 0 ? facing > 0.99 : facing < -0.99, `${kind} faces its way`);
        assert.ok(isOnRoad(world.road, x, y, frontS), "on the road");
        assert.ok(roadDistanceAt(world.road, x, y, frontS) > START_STRAIGHT_LENGTH, "past the first straight");
        assert.ok(Math.hypot(x - center.x, y - center.y) <= ROAD_RADIUS + OBSTACLE_SEGMENT, "within ROAD_RADIUS of the camera");
        assert.ok(Math.abs(Math.hypot(body.velocity.x, body.velocity.y) - speed * CAR_MAX_SPEED) < 1e-6, "at its speed");
      }
      assert.deepStrictEqual(spawnObstacles(world, frontS), [], "each piece of road is rolled once");
      assert.strictEqual(new Set([...world.obstacles.values()].map(o => o.slot)).size, world.obstacles.size, "distinct slots");
    });

    it("follow the road at their own speed, a car length apart, until the front gets them", () => {
      for (const seed of [42, 2]) {
        const seen = new Map<string, { ticks: number, speedSum: number, target: number }>();
        let gone = 0;
        let ticks = 0;
        let offRoad = 0;
        let hits = -1;
        /** Pairs of obstacles near each other (gap < 200), and those closer than 3/4 of the gap kept. */
        let nearPairs = 0;
        let closePairs = 0;
        runObstacles(seed, 40 * TICK_RATE, (world, tick) => {
          if (hits < 0) {
            hits = 0;
            Matter.Events.on(world.engine, "collisionStart", e => { hits += e.pairs.length; });
          }
          const frontS = destructionFrontS(tick);
          for (const id of seen.keys()) if (!world.obstacles.has(id)) gone++, seen.delete(id);
          const bodies = [...world.obstacles.values()].map(o => o.body);
          for (const [id, obstacle] of world.obstacles) {
            const { x, y } = obstacle.body.position;
            ticks++;
            if (!isOnRoad(world.road, x, y, frontS)) offRoad++;
            const stats = seen.get(id) ?? { ticks: 0, speedSum: 0, target: obstacle.speed * CAR_MAX_SPEED };
            stats.ticks++;
            stats.speedSum += Math.hypot(obstacle.body.velocity.x, obstacle.body.velocity.y);
            seen.set(id, stats);
            // Bumper to bumper / side to side, in the road's frame
            const { heading } = roadPointAt(world.road, roadDistanceAt(world.road, x, y, frontS));
            for (const other of bodies) {
              if (other === obstacle.body) continue;
              const rx = other.position.x - x;
              const ry = other.position.y - y;
              const gap = Math.max(
                Math.abs(rx * Math.cos(heading) + ry * Math.sin(heading)) - CAR_LENGTH,
                Math.abs(-rx * Math.sin(heading) + ry * Math.cos(heading)) - CAR_WIDTH,
              );
              if (gap < 200) nearPairs++;
              if (gap < 0.75 * OBSTACLE_KEEP_GAP) closePairs++;
            }
          }
          assert.ok(world.obstacles.size <= MAX_OBSTACLES);
        });
        assert.ok(gone > 10, `${gone} obstacles fell into the void`);
        // (In heavy traffic, cars swerving into the same gap from both sides graze now and then.
        // TODO: grazes went from ~5 to ~40 per run with the road rework (ROAD_AHEAD), red or not)
        assert.ok(closePairs < nearPairs * 0.03, `keep their distance: closer ${closePairs} of ${nearPairs} times`);
        assert.ok(hits <= 60, `hardly ever touch: ${hits} collisions`);
        // (Swerving on the outside of a tight corner, or wide around a red one, one may run wide now and then)
        assert.ok(offRoad < ticks * 0.015, `on the road: off ${offRoad} of ${ticks} car-ticks`);
        // They only steer to keep their distance: always at their own speed (bar a bump now and then)
        let onPace = 0;
        for (const { ticks, speedSum, target } of seen.values()) {
          if (Math.abs(speedSum / ticks / target - 1) < 0.02) onPace++;
        }
        assert.ok(onPace >= seen.size * 0.75, `${onPace} of ${seen.size} at their own speed`);
      }
    });

    /** A world with the road and its obstacles as they are a while into a round. */
    const worldWithObstacles = (seed: number) => {
      const world = createCarWorld(buildRoad(seed));
      const frontS = destructionFrontS(COUNTDOWN_TICKS);
      maintainRoad(world, frontS);
      spawnObstacles(world, frontS);
      return { world, frontS };
    };

    it("are removed once over destroyed ground", () => {
      const { world, frontS } = worldWithObstacles(3);
      const [id, obstacle] = [...world.obstacles][0];
      // The front jumps past it
      const s = roadDistanceAt(world.road, obstacle.body.position.x, obstacle.body.position.y, frontS);
      const tick = Math.ceil((s + CHUNK_JITTER) / (PHYSICS_SUBSTEPS * DESTRUCTION_SPEED)) + 1;
      maintainRoad(world, destructionFrontS(tick));
      stepCarRound(world, new Map(), tick, PHYSICS_SUBSTEPS, PHYSICS_STEP_MS);
      assert.ok(!world.obstacles.has(id));
    });

    it("keep a car length from a car in their way, and pass it without touching", () => {
      for (const seed of [5, 9, 11]) {
        const { world, frontS } = worldWithObstacles(seed);
        world.frontS = frontS;
        // One obstacle, alone but for a car parked in its lane up the road
        const [id, obstacle] = [...world.obstacles][0];
        for (const other of [...world.obstacles.keys()]) if (other !== id) removeObstacle(world, other);
        const { body } = obstacle;
        const startS = roadDistanceAt(world.road, body.position.x, body.position.y, frontS);
        const parkedAt = lanePoint(world.road, startS + 300, obstacle.lane);
        const parked = addCar(world, "a", 0, { x: parkedAt.x, y: parkedAt.y, angle: parkedAt.heading, vx: 0, vy: 0, av: 0 });
        let hits = 0;
        Matter.Events.on(world.engine, "collisionStart", e => { hits += e.pairs.length; });

        let closest = Infinity;
        for (let tick = 0; tick < 4 * TICK_RATE; tick++) {
          step(world, new Map([["a", toward(0, 0)]]), 1);
          // Bumper to bumper / side to side, in the road's frame
          const h = parkedAt.heading;
          const rx = body.position.x - parked.position.x;
          const ry = body.position.y - parked.position.y;
          const along = Math.abs(rx * Math.cos(h) + ry * Math.sin(h)) - CAR_LENGTH;
          const side = Math.abs(-rx * Math.sin(h) + ry * Math.cos(h)) - CAR_WIDTH;
          closest = Math.min(closest, Math.max(along, side));
        }
        assert.strictEqual(hits, 0, `seed ${seed}: never touched`);
        assert.ok(closest > 0.6 * OBSTACLE_KEEP_GAP, `seed ${seed}: kept its distance (closest ${closest.toFixed(1)})`);
        const endS = roadDistanceAt(world.road, body.position.x, body.position.y, frontS);
        assert.ok(endS > parkedAt.s + 2 * CAR_LENGTH, `seed ${seed}: passed it (${endS.toFixed(0)} vs ${parkedAt.s.toFixed(0)})`);
        assert.ok(isOnRoad(world.road, body.position.x, body.position.y, frontS), `seed ${seed}: back on the road`);
      }
    });

    it("with a playerAttackDistance ram a player next to them, at their own speed, and not one ahead", () => {
      const kind = OBSTACLE_KINDS.brown;
      const saved = kind.playerAttackDistance;
      kind.playerAttackDistance = 200;
      /** One obstacle alone with a player driving along the road at its speed, `ahead` of it and `aside`. */
      const scene = (seed: number, ahead: number, aside: number) => {
        const { world, frontS } = worldWithObstacles(seed);
        world.frontS = frontS;
        const [id, obstacle] = [...world.obstacles][0];
        for (const other of [...world.obstacles.keys()]) if (other !== id) removeObstacle(world, other);
        obstacle.kind = "brown";
        const { body } = obstacle;
        const startS = roadDistanceAt(world.road, body.position.x, body.position.y, frontS);
        const lane = obstacle.lane + (obstacle.lane > 0 ? -aside : aside);
        const at = lanePoint(world.road, startS + ahead, lane);
        const v = obstacle.speed * CAR_MAX_SPEED;
        const player = addCar(world, "a", 0, {
          x: at.x, y: at.y, angle: at.heading, vx: Math.cos(at.heading) * v, vy: Math.sin(at.heading) * v, av: 0,
        });
        let hit = false;
        Matter.Events.on(world.engine, "collisionStart", e => {
          for (const pair of e.pairs) {
            if ((pair.bodyA === body || pair.bodyB === body) && (pair.bodyA === player || pair.bodyB === player)) hit = true;
          }
        });
        let fastest = 0;
        const drive = (ticks: number) => {
          for (let tick = 0; tick < ticks && !hit; tick++) {
            const ps = roadDistanceAt(world.road, player.position.x, player.position.y, frontS);
            const heading = roadPointAt(world.road, ps).heading;
            step(world, new Map([["a", toward(Math.cos(heading) * obstacle.speed, Math.sin(heading) * obstacle.speed)]]), 1);
            fastest = Math.max(fastest, Math.hypot(body.velocity.x, body.velocity.y));
          }
        };
        return { obstacle, drive, hit: () => hit, fastest: () => fastest };
      };
      try {
        for (const seed of [5, 9, 11]) {
          const alongside = scene(seed, 0, 120);
          alongside.drive(2 * TICK_RATE);
          assert.ok(alongside.hit(), `seed ${seed}: rammed the player next to it`);
          const target = alongside.obstacle.speed * CAR_MAX_SPEED;
          assert.ok(alongside.fastest() < target * 1.05, `seed ${seed}: at its own speed (${alongside.fastest().toFixed(2)} vs ${target.toFixed(2)})`);

          const ahead = scene(seed, 150, 0);
          ahead.drive(2 * TICK_RATE);
          assert.ok(!ahead.hit(), `seed ${seed}: left the player ahead alone`);
        }
      } finally {
        kind.playerAttackDistance = saved;
      }
    });
  });
});
