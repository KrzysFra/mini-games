import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/server/app.config.js";

let server: Promise<ColyseusTestServer<typeof appConfig>>;

/**
 * One test server for the whole run: booting a second one in the same process (one per test
 * file) breaks matchmaking. Mocha's `--exit` tears it down at the end.
 */
export const testServer = () => server ??= boot(appConfig);
