import { CAMERA_AHEAD_OF_FRONT, VIEW_HALF_HEIGHT, VIEW_HALF_WIDTH } from "./constants.js";
import { roadPointAt, type Road, type RoadSample } from "./road.js";

/**
 * The camera, the same for every player: north-up, fixed zoom, centered on the road
 * `CAMERA_AHEAD_OF_FRONT` ahead of the destruction front. Shared so the server can eliminate cars
 * that leave it (`isOutOfView`) and the client draws exactly that view.
 */

export { CAMERA_AHEAD_OF_FRONT };
export { CAMERA_ZOOM, SCREEN_HEIGHT, SCREEN_WIDTH, VIEW_HALF_HEIGHT, VIEW_HALF_WIDTH } from "./constants.js";

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
