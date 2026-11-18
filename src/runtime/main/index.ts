import electron from "electron";

import {
  installDialogAndNotificationHooks,
  installMenuHooks,
  refreshAllMenus
} from "./electron-hooks";
import { broadcastLocaleChanged, installIpcHandlers } from "./ipc";
import {
  buildClientBundle,
  loadDictionaries,
  persistLocale,
  reloadPrefsAfterReady,
  resolveBaseDictDir
} from "./locale-store";
import type { ClientBundlePayload, UiLocale } from "../../shared/types";


let installed = false;


function setLocaleAndBroadcast(nextLocale: UiLocale): ClientBundlePayload {
  persistLocale(nextLocale);
  const payload = buildClientBundle(true);
  refreshAllMenus();
  broadcastLocaleChanged(payload);
  return payload;
}


export function installMainHooks(): void {
  if (installed) {
    return;
  }
  installed = true;

  loadDictionaries(true);
  installMenuHooks((nextLocale) => {
    setLocaleAndBroadcast(nextLocale);
  });
  installDialogAndNotificationHooks();
  installIpcHandlers(setLocaleAndBroadcast);

  electron.app.whenReady().then(() => {
    if (reloadPrefsAfterReady()) {
      refreshAllMenus();
    }
  });

  console.log(`[agy-i18n] Main hooks installed (dict dir: ${resolveBaseDictDir()})`);
}


installMainHooks();
