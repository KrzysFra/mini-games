import { Client } from "@colyseus/sdk"

/**
 * Single shared Colyseus client. Client and server are served from the same
 * origin (Vite dev server locally, one app on Colyseus Cloud), so the endpoint
 * is simply the page's own origin.
 */
export const client = new Client(`${location.protocol}//${location.host}`)
