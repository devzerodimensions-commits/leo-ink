/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Leo Ink API, e.g. https://leo-ink-api.onrender.com/api */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
