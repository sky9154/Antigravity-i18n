import electron from "electron";
import type { IpcMainInvokeEvent } from "electron";
import * as fs from "fs";
import * as path from "path";

import {
  buildClientBundle,
  normalizeLocale,
  readJsonSafe,
  resolveBaseDictDir
} from "./locale-store";
import type { ClientBundlePayload, UiLocale } from "../../shared/types";


const MAX_MISSING_BATCH = 500;
const MAX_MISSING_ITEM_LENGTH = 200;
const MAX_MISSING_TOTAL = 4000;


function isAllowedSenderUrl(rawUrl: string): boolean {
  if (!rawUrl) {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol === "data:" ||
      parsed.protocol === "file:" ||
      parsed.protocol === "plugin:"
    ) {
      return true;
    }

    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    }

    return false;
  } catch {
    return false;
  }
}


export function isTrustedIpcSender(event: IpcMainInvokeEvent | null | undefined): boolean {
  const sender = event?.sender;
  if (!sender || sender.isDestroyed()) {
    return false;
  }

  if (sender.getType?.() === "webview") {
    return false;
  }

  const frame = event.senderFrame;
  if (frame) {
    if (frame.parent) {
      return false;
    }
    if (sender.mainFrame && frame !== sender.mainFrame) {
      return false;
    }
  }

  const url = frame?.url ?? sender.getURL?.() ?? "";
  return isAllowedSenderUrl(url);
}


function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  if (!isTrustedIpcSender(event)) {
    throw new Error(`Unauthorized ${channel} sender`);
  }
}


export function broadcastLocaleChanged(payload: ClientBundlePayload): void {
  for (const wc of electron.webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) {
      wc.send("agy-i18n:locale-changed", payload);
    }
  }
}


export function installIpcHandlers(
  onSetLocale: (nextLocale: UiLocale) => ClientBundlePayload
): void {
  const { ipcMain } = electron;
  let loggedFirstBundle = false;

  ipcMain.handle("agy-i18n:get-bundle", (event) => {
    assertTrustedSender(event, "agy-i18n:get-bundle");

    const payload = buildClientBundle(true);
    if (!loggedFirstBundle) {
      loggedFirstBundle = true;
      console.log(
        `[agy-i18n] Served bundle to renderer: locale=${payload.locale}, exact=${Object.keys(payload.exact).length}, patterns=${Object.keys(payload.patterns).length}`
      );
    }
    return payload;
  });

  ipcMain.handle("agy-i18n:set-locale", (event, nextLocale: unknown) => {
    assertTrustedSender(event, "agy-i18n:set-locale");
    if (typeof nextLocale !== "string" || nextLocale.length > 32) {
      throw new Error("Invalid locale parameter");
    }
    return onSetLocale(normalizeLocale(nextLocale));
  });

  ipcMain.handle("agy-i18n:save-missing", (event, items: unknown) => {
    assertTrustedSender(event, "agy-i18n:save-missing");
    if (!Array.isArray(items)) {
      return { saved: 0, path: "" };
    }

    const dir = resolveBaseDictDir();
    const outPath = path.join(dir, "missing-ui.json");
    const existing = readJsonSafe<Record<string, string>>(outPath, {});

    let added = 0;
    const bounded = items.slice(0, MAX_MISSING_BATCH);
    for (const raw of bounded) {
      if (Object.keys(existing).length >= MAX_MISSING_TOTAL) {
        break;
      }
      if (typeof raw !== "string") {
        continue;
      }
      const key = raw.trim();
      if (key && key.length <= MAX_MISSING_ITEM_LENGTH && !(key in existing)) {
        existing[key] = "";
        added += 1;
      }
    }

    try {
      fs.writeFileSync(outPath, JSON.stringify(existing, null, 2), "utf8");
    } catch (error) {
      console.error("[agy-i18n] Failed to save missing UI strings:", error);
      return { saved: 0, path: "" };
    }

    return { saved: added, path: outPath };
  });
}
