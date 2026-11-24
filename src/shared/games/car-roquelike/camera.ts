import { roadPointAt, type Road, type RoadSample } from "./road.js";

/**
 * The camera, the same for every player: north-up, fixed zoom, centered on the road
 * `CAMERA_AHEAD_OF_FRONT` ahead of the destruction front. Shared so the server can eliminate cars
 * that leave it (`isOutOfView`) and the client draws exactly that view.
 */

/** The game's logical screen size (`main.ts`; `Scale.FIT` keeps it whatever the window). */
export const SCREEN_WIDTH = 1920;
export const SCREEN_HEIGHT = 1080;
/**
 * Fixed zoom. At 0.45 the view reaches 1200 above its center, so the spawn grid (500..600 up the
 * road from the camera during the countdown) is on screen at the start.
 */
export const CAMERA_ZOOM = 0.45;
/** The camera is on the road this far ahead of the destruction front. */
export const CAMERA_AHEAD_OF_FRONT = 1000;
/** Half the world area the camera shows. */
export const VIEW_HALF_WIDTH = SCREEN_WIDTH / 2 / CAMERA_ZOOM;
export const VIEW_HALF_HEIGHT = SCREEN_HEIGHT / 2 / CAMERA_ZOOM;

/** The camera's center with the front at `frontS` (the road must be generated that far). */
export function cameraCenter(road: Road, frontS: number, out?: RoadSample): RoadSample {
  return roadPointAt(road, frontS + CAMERA_AHEAD_OF_FRONT, out);
}

const scratch: RoadSample = { x: 0, y: 0, heading: 0, s: 0 };

/** Whether (x, y) is off the camera's view with the front at `frontS`. */
export function isOutOfView(road: Road, x: number, y: number, frontS: number): boolean {
  const center = cameraCenter(road, frontS, scratch);
  return Math.abs(x - center.x) > VIEW_HALF_WIDTH || Math.abs(y - center.y) > VIEW_HALF_HEIGHT;
}
