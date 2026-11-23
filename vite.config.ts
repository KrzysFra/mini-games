import { defineConfig, PluginOption } from "vite"
import { colyseus } from "colyseus/vite"

const clientReload: PluginOption = {
  name: 'client-full-reload',
  hotUpdate({ file }) {
    if (this.environment.name === 'client' && file.includes('/src/client/')) {
      this.environment.hot.send({ type: 'full-reload' })
      return []
    }
  },
}

export default defineConfig(({ mode }) => ({
  build: { outDir: "dist/client" },
  server: {
    watch: { usePolling: true, interval: 100 }
  },
  plugins: [
    // The plugin declares a second build environment (dist/server), so every
    // `vite build` builds both halves. `--mode client` drops it when you only
    // want the static client — e.g. deploying it separately from the server.
    // That mode also swaps which .env.* file Vite loads: .env.client, not
    // .env.production. Only matters once you add a VITE_-prefixed var.
    ...(mode === "client" ? [] : [colyseus({ serverEntry: "/src/server/app.config.ts", serveClient: true })]),
    clientReload
  ],
}))
