/// <reference types="vite/client" />

import type { InstallerApi } from "../../shared/contracts.js";

declare global {
  interface Window {
    installer: InstallerApi;
  }
}

export {};
