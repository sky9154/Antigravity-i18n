import { ipcRenderer, webFrame } from "electron";

import type { ClientBundlePayload, UiLocale } from "../../shared/types";
import { isAllowedLocation } from "./dom-rules";
import { createLanguageDropdown } from "./language-dropdown";
import { showToast } from "./toast";
import { createTranslatorEngine } from "./translator";


const PRELOAD_RUNTIME_KEY = Symbol.for("agy.i18n.preloadRuntime");
const SHADOW_ATTACHED_EVENT = "agy-i18n:shadow-attached";
const MAIN_SHADOW_HOOK_SCRIPT = `(() => {
  const k = Symbol.for("agy.i18n.mainShadowHook");
  if (window[k]) return;
  window[k] = true;
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init) {
    const shadow = orig.call(this, init);
    if (init && init.mode === "open") {
      queueMicrotask(() => {
        if (this && this.isConnected) {
          this.dispatchEvent(new CustomEvent(${JSON.stringify(SHADOW_ATTACHED_EVENT)}, {
            bubbles: true,
            composed: true
          }));
        }
      });
    }
    return shadow;
  };
})();`;

type ShadowCallback = (shadow: ShadowRoot) => void;

interface GlobalPreloadRegistry {
  disposePrevious?: () => void;
  shadowHandler?: ShadowCallback | null;
  preloadShadowHooked?: boolean;
}


function getGlobalRegistry(): GlobalPreloadRegistry {
  const root = globalThis as Record<symbol, unknown>;
  const existing = root[PRELOAD_RUNTIME_KEY] as GlobalPreloadRegistry | undefined;
  if (existing) {
    return existing;
  }

  const created: GlobalPreloadRegistry = {};
  root[PRELOAD_RUNTIME_KEY] = created;
  return created;
}


function installPreloadShadowInterceptor(registry: GlobalPreloadRegistry): void {
  if (registry.preloadShadowHooked || typeof Element === "undefined") {
    return;
  }
  registry.preloadShadowHooked = true;

  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function patchedAttachShadow(
    this: Element,
    init: ShadowRootInit
  ): ShadowRoot {
    const shadow = origAttachShadow.call(this, init);
    if (init.mode === "open") {
      registry.shadowHandler?.(shadow);
    }
    return shadow;
  };
}


export async function bootstrap(): Promise<() => void> {
  if (!isAllowedLocation()) {
    return () => {};
  }

  const registry = getGlobalRegistry();
  registry.disposePrevious?.();
  registry.disposePrevious = undefined;

  let bundle: ClientBundlePayload;
  try {
    bundle = (await ipcRenderer.invoke("agy-i18n:get-bundle")) as ClientBundlePayload;
  } catch {
    return () => {};
  }

  let disposed = false;
  let lastAppliedSeq = bundle.bundleSeq ?? 0;
  let engineRef: ReturnType<typeof createTranslatorEngine>;

  const applyBundleIfNewer = (nextBundle: ClientBundlePayload): void => {
    if (disposed) {
      return;
    }
    const nextSeq = typeof nextBundle.bundleSeq === "number" ? nextBundle.bundleSeq : 0;
    if (nextSeq > 0 && nextSeq <= lastAppliedSeq) {
      return;
    }
    if (nextSeq > 0) {
      lastAppliedSeq = nextSeq;
    }
    engineRef.applyBundle(nextBundle);
  };

  const handleSelectLocale = async (nextLocale: UiLocale) => {
    try {
      const nextBundle = (await ipcRenderer.invoke(
        "agy-i18n:set-locale",
        nextLocale
      )) as ClientBundlePayload;
      applyBundleIfNewer(nextBundle);
    } catch (error) {
      showToast(`Language switch error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const languageDropdown = createLanguageDropdown(
    () => engineRef.getLocaleState(),
    (nextLocale) => {
      void handleSelectLocale(nextLocale);
    },
    (text) => engineRef.translateText(text)
  );

  engineRef = createTranslatorEngine(bundle, () => {
    languageDropdown.ensureMounted();
  });

  const handleLocaleChanged = (_event: unknown, payload: unknown) => {
    if (payload && typeof payload === "object" && "locale" in payload) {
      applyBundleIfNewer(payload as ClientBundlePayload);
    }
  };

  const handleShadowEvent = (event: Event) => {
    if (disposed) {
      return;
    }
    const target = event.target as Element | null;
    if (target?.shadowRoot && target.shadowRoot.isConnected) {
      engineRef.attachShadowRoot(target.shadowRoot);
    }
  };

  const handleKeyDown = async (event: KeyboardEvent) => {
    if (disposed) {
      return;
    }
    if (event.ctrlKey && event.altKey && event.shiftKey && event.key.toUpperCase() === "L") {
      event.preventDefault();
      const missing = engineRef.collectMissingStrings();
      const result = (await ipcRenderer.invoke("agy-i18n:save-missing", missing)) as {
        saved: number;
      };
      showToast(
        engineRef.translateText(
          `Scanned ${missing.length} unmapped strings; saved ${result.saved} new entries to missing-ui.json`
        )
      );
    }
  };

  const handleDomReady = () => {
    if (!disposed) {
      engineRef.start();
    }
  };

  ipcRenderer.on("agy-i18n:locale-changed", handleLocaleChanged);
  document.addEventListener(SHADOW_ATTACHED_EVENT, handleShadowEvent, true);
  window.addEventListener("keydown", handleKeyDown);

  registry.shadowHandler = (shadow) => {
    setTimeout(() => {
      if (!disposed && shadow.isConnected) {
        engineRef.attachShadowRoot(shadow);
      }
    }, 0);
  };
  installPreloadShadowInterceptor(registry);

  if (typeof webFrame?.executeJavaScript === "function") {
    webFrame.executeJavaScript(MAIN_SHADOW_HOOK_SCRIPT).catch(() => undefined);
  }

  if (document.body) {
    engineRef.start();
  }
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", handleDomReady, { once: true });
  }

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    ipcRenderer.removeListener("agy-i18n:locale-changed", handleLocaleChanged);
    document.removeEventListener(SHADOW_ATTACHED_EVENT, handleShadowEvent, true);
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("DOMContentLoaded", handleDomReady);
    registry.shadowHandler = null;
    languageDropdown.destroy();
    engineRef.destroy();
    if (registry.disposePrevious === dispose) {
      registry.disposePrevious = undefined;
    }
  };

  registry.disposePrevious = dispose;
  return dispose;
}


void bootstrap();
