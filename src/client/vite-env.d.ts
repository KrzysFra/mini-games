/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sandbox mode: the mini-game id every client starts in (see `core/sandbox.ts`). */
  readonly VITE_SANDBOX?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
