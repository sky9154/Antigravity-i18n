import electron from "electron";
import type {
  BrowserWindow,
  Menu as ElectronMenu,
  MenuItem as ElectronMenuItem,
  MenuItemConstructorOptions,
  MessageBoxOptions,
  NotificationConstructorOptions,
  Tray as ElectronTray
} from "electron";

import { ensurePrefsLoaded, getAvailableLocales, translateNativeText } from "./locale-store";
import type { UiLocale } from "../../shared/types";


interface RawMenuTexts {
  label: string;
  sublabel: string;
  toolTip: string;
}

let rawApplicationMenu: ElectronMenu | null = null;
let applyMenuFn: ((menu: ElectronMenu) => void) | null = null;
let buildFromTemplateFn: typeof electron.Menu.buildFromTemplate | null = null;
let origSetTrayMenuFn: ((tray: ElectronTray, menu: ElectronMenu) => void) | null = null;
let selectLocaleHandler: (locale: UiLocale) => void = () => {};
let buildingDisplayMenuDepth = 0;
let menuRefreshScheduled = false;

const rawTrayMenus = new WeakMap<ElectronTray, ElectronMenu>();
const trackedTrays = new Set<WeakRef<ElectronTray>>();
const rawItemTexts = new WeakMap<ElectronMenuItem, RawMenuTexts>();
const rawMenuSet = new WeakSet<ElectronMenu>();
const sourceToDisplayItems = new WeakMap<
  ElectronMenuItem,
  Array<{ displayItem: ElectronMenuItem; menu: ElectronMenu }>
>();


function getRawItemTexts(item: ElectronMenuItem): RawMenuTexts {
  const existing = rawItemTexts.get(item);
  if (existing) {
    return existing;
  }

  const snapshot: RawMenuTexts = {
    label: item.label ?? "",
    sublabel: item.sublabel ?? "",
    toolTip: item.toolTip ?? ""
  };
  rawItemTexts.set(item, snapshot);
  return snapshot;
}


function syncRadioGroupChecked(
  source: ElectronMenu,
  targetIndex: number,
  targetItem: ElectronMenuItem
): void {
  const items = source.items;
  for (let i = targetIndex; i >= 0 && items[i].type === "radio"; i -= 1) {
    items[i].checked = items[i] === targetItem;
  }
  for (let i = targetIndex + 1; i < items.length && items[i].type === "radio"; i += 1) {
    items[i].checked = items[i] === targetItem;
  }
}


function syncDisplayStateFromSource(sourceItem: ElectronMenuItem): void {
  const mapped = sourceToDisplayItems.get(sourceItem);
  if (!mapped) {
    return;
  }

  for (const entry of mapped) {
    entry.displayItem.checked = sourceItem.checked;
    entry.displayItem.enabled = sourceItem.enabled;
    entry.displayItem.visible = sourceItem.visible;
  }
}


function markRawMenusRecursive(menu: ElectronMenu): void {
  rawMenuSet.add(menu);
  if (!Array.isArray(menu.items)) {
    return;
  }

  for (const item of menu.items) {
    getRawItemTexts(item);
    if (item.submenu) {
      markRawMenusRecursive(item.submenu);
    }
  }
}


function bindDisplayItemsToSource(source: ElectronMenu, display: ElectronMenu): void {
  const count = Math.min(source.items.length, display.items.length);
  for (let i = 0; i < count; i += 1) {
    const srcItem = source.items[i];
    const dispItem = display.items[i];

    const list = sourceToDisplayItems.get(srcItem) ?? [];
    list.push({ displayItem: dispItem, menu: display });
    sourceToDisplayItems.set(srcItem, list);

    if (srcItem.submenu && dispItem.submenu) {
      bindDisplayItemsToSource(srcItem.submenu, dispItem.submenu);
    }
  }
}


function cloneMenuItems(source: ElectronMenu): MenuItemConstructorOptions[] {
  return source.items.map((item, idx) => {
    const raw = getRawItemTexts(item);
    const option: MenuItemConstructorOptions = {
      id: item.id || undefined,
      label: translateNativeText(raw.label),
      sublabel: raw.sublabel ? translateNativeText(raw.sublabel) : undefined,
      toolTip: raw.toolTip ? translateNativeText(raw.toolTip) : undefined,
      type: item.type,
      enabled: item.enabled,
      visible: item.visible,
      checked: item.checked
    };

    if (item.role) {
      option.role = item.role as MenuItemConstructorOptions["role"];
    }

    if (item.accelerator) {
      option.accelerator = item.accelerator;
    }

    if (item.icon) {
      option.icon = item.icon;
    }

    if (item.submenu) {
      option.submenu = cloneMenuItems(item.submenu);
    } else if ((item.click || item.type === "checkbox" || item.type === "radio") && !item.role) {
      option.click = (displayItem, browserWindow, event) => {
        if (item.type === "checkbox") {
          item.checked = displayItem.checked;
        } else if (item.type === "radio") {
          syncRadioGroupChecked(source, idx, item);
        }

        item.click?.(item, browserWindow, event);
        syncDisplayStateFromSource(item);
      };
    }

    return option;
  });
}


function buildDisplayMenu(
  source: ElectronMenu,
  origBuildFromTemplate: typeof electron.Menu.buildFromTemplate,
  includeLocaleSubmenu: boolean
): ElectronMenu {
  const template = cloneMenuItems(source);

  if (includeLocaleSubmenu && template.length > 0) {
    const locale = ensurePrefsLoaded();
    const locales = getAvailableLocales();
    const languageSubmenu: MenuItemConstructorOptions = {
      id: "agy-i18n-language-menu",
      label: translateNativeText("Display Language"),
      submenu: locales.map((opt) => ({
        id: `agy-i18n-locale-${opt.id}`,
        label: opt.label,
        type: "radio",
        checked: opt.id === locale,
        click: () => {
          selectLocaleHandler(opt.id);
        }
      }))
    };

    const lastTop = template[template.length - 1];
    if (Array.isArray(lastTop.submenu)) {
      lastTop.submenu.push({ type: "separator" }, languageSubmenu);
    }
  }

  let displayMenu: ElectronMenu;
  buildingDisplayMenuDepth += 1;
  try {
    displayMenu = origBuildFromTemplate(template);
  } finally {
    buildingDisplayMenuDepth -= 1;
  }

  bindDisplayItemsToSource(source, displayMenu);
  return displayMenu;
}


export function refreshAllMenus(): void {
  if (buildingDisplayMenuDepth > 0) {
    return;
  }

  if (rawApplicationMenu && applyMenuFn && buildFromTemplateFn) {
    applyMenuFn(buildDisplayMenu(rawApplicationMenu, buildFromTemplateFn, true));
  }

  if (origSetTrayMenuFn && buildFromTemplateFn) {
    for (const ref of Array.from(trackedTrays)) {
      const tray = ref.deref();
      if (!tray || tray.isDestroyed()) {
        trackedTrays.delete(ref);
        continue;
      }
      const rawMenu = rawTrayMenus.get(tray);
      if (rawMenu) {
        origSetTrayMenuFn(tray, buildDisplayMenu(rawMenu, buildFromTemplateFn, false));
      }
    }
  }
}


function scheduleMenuRefresh(): void {
  if (menuRefreshScheduled) {
    return;
  }

  menuRefreshScheduled = true;
  queueMicrotask(() => {
    menuRefreshScheduled = false;
    refreshAllMenus();
  });
}


function translateDialogOptions<T extends object>(options: T): T {
  const next = { ...options } as Record<string, unknown>;

  for (const key of ["title", "message", "detail", "buttonLabel", "checkboxLabel"]) {
    const val = next[key];
    if (typeof val === "string") {
      next[key] = translateNativeText(val);
    }
  }

  if (Array.isArray(next.buttons)) {
    next.buttons = next.buttons.map((btn) =>
      typeof btn === "string" ? translateNativeText(btn) : btn
    );
  }

  return next as T;
}


function patchDialogMethod<T extends (...args: unknown[]) => unknown>(origFn: T): T {
  return function patchedDialog(this: unknown, ...args: unknown[]): unknown {
    if (args.length >= 2 && args[1] && typeof args[1] === "object") {
      return origFn.call(
        this,
        args[0] as BrowserWindow,
        translateDialogOptions(args[1] as MessageBoxOptions)
      );
    }

    if (args.length >= 1 && args[0] && typeof args[0] === "object") {
      return origFn.call(this, translateDialogOptions(args[0] as MessageBoxOptions));
    }

    return origFn.apply(this, args);
  } as T;
}


export function installMenuHooks(onSelectLocale: (locale: UiLocale) => void): void {
  selectLocaleHandler = onSelectLocale;

  const { Menu, Tray } = electron;
  const origSetAppMenu = Menu.setApplicationMenu.bind(Menu);
  const origGetAppMenu = Menu.getApplicationMenu.bind(Menu);
  const origBuildFromTemplate = Menu.buildFromTemplate.bind(Menu);

  applyMenuFn = origSetAppMenu;
  buildFromTemplateFn = origBuildFromTemplate;

  Menu.getApplicationMenu = () => {
    return rawApplicationMenu ?? origGetAppMenu();
  };

  Menu.setApplicationMenu = (menu: ElectronMenu | null) => {
    rawApplicationMenu = menu;
    if (!menu) {
      origSetAppMenu(null);
      return;
    }

    markRawMenusRecursive(menu);
    const display = buildDisplayMenu(menu, origBuildFromTemplate, true);
    origSetAppMenu(display);
  };

  const origSetContextMenu = Tray.prototype.setContextMenu;
  origSetTrayMenuFn = (tray, menu) => {
    origSetContextMenu.call(tray, menu);
  };

  Tray.prototype.setContextMenu = function patchedSetContextMenu(
    this: ElectronTray,
    menu: ElectronMenu | null
  ): void {
    if (!menu) {
      rawTrayMenus.delete(this);
      origSetContextMenu.call(this, null);
      return;
    }

    markRawMenusRecursive(menu);
    rawTrayMenus.set(this, menu);
    trackedTrays.add(new WeakRef(this));
    const display = buildDisplayMenu(menu, origBuildFromTemplate, false);
    origSetContextMenu.call(this, display);
  };

  const origSetToolTip = Tray.prototype.setToolTip;
  Tray.prototype.setToolTip = function patchedSetToolTip(
    this: ElectronTray,
    toolTip: string
  ): void {
    origSetToolTip.call(this, translateNativeText(toolTip));
  };

  const origMenuInsert = Menu.prototype.insert;
  Menu.prototype.insert = function patchedInsert(
    this: ElectronMenu,
    ...args: [number, ElectronMenuItem]
  ): void {
    const [pos, menuItem] = args;
    if (buildingDisplayMenuDepth > 0 || !menuItem) {
      origMenuInsert.apply(this, args);
      return;
    }

    getRawItemTexts(menuItem);
    if (rawMenuSet.has(this)) {
      if (menuItem.submenu) {
        markRawMenusRecursive(menuItem.submenu);
      }
      origMenuInsert.call(this, pos, menuItem);
      scheduleMenuRefresh();
      return;
    }

    origMenuInsert.call(this, pos, menuItem);
  };

  const activePopupMap = new WeakMap<ElectronMenu, ElectronMenu>();
  const origMenuPopup = Menu.prototype.popup;
  if (typeof origMenuPopup === "function") {
    Menu.prototype.popup = function patchedPopup(
      this: ElectronMenu,
      ...args: [options?: unknown]
    ): void {
      if (buildingDisplayMenuDepth > 0 || !Array.isArray(this.items)) {
        origMenuPopup.apply(this, args);
        return;
      }

      const displayPopup = buildDisplayMenu(this, origBuildFromTemplate, false);
      activePopupMap.set(this, displayPopup);
      origMenuPopup.apply(displayPopup, args);
    };
  }

  const origMenuClosePopup = Menu.prototype.closePopup;
  if (typeof origMenuClosePopup === "function") {
    Menu.prototype.closePopup = function patchedClosePopup(
      this: ElectronMenu,
      ...args: [browserWindow?: BrowserWindow]
    ): void {
      const activeDisplay = activePopupMap.get(this);
      if (activeDisplay) {
        activePopupMap.delete(this);
        origMenuClosePopup.apply(activeDisplay, args);
      }
      origMenuClosePopup.apply(this, args);
    };
  }
}


export function installDialogAndNotificationHooks(): void {
  const { dialog, Notification } = electron;

  dialog.showMessageBox = patchDialogMethod(
    dialog.showMessageBox.bind(dialog) as (...args: unknown[]) => unknown
  ) as typeof dialog.showMessageBox;
  dialog.showMessageBoxSync = patchDialogMethod(
    dialog.showMessageBoxSync.bind(dialog) as (...args: unknown[]) => unknown
  ) as typeof dialog.showMessageBoxSync;
  dialog.showOpenDialog = patchDialogMethod(
    dialog.showOpenDialog.bind(dialog) as (...args: unknown[]) => unknown
  ) as typeof dialog.showOpenDialog;
  dialog.showOpenDialogSync = patchDialogMethod(
    dialog.showOpenDialogSync.bind(dialog) as (...args: unknown[]) => unknown
  ) as typeof dialog.showOpenDialogSync;
  dialog.showSaveDialog = patchDialogMethod(
    dialog.showSaveDialog.bind(dialog) as (...args: unknown[]) => unknown
  ) as typeof dialog.showSaveDialog;
  dialog.showSaveDialogSync = patchDialogMethod(
    dialog.showSaveDialogSync.bind(dialog) as (...args: unknown[]) => unknown
  ) as typeof dialog.showSaveDialogSync;

  class TranslatedNotification extends Notification {
    constructor(options?: NotificationConstructorOptions) {
      if (!options) {
        super();
        return;
      }

      super({
        ...options,
        title: options.title ? translateNativeText(options.title) : options.title,
        subtitle: options.subtitle ? translateNativeText(options.subtitle) : options.subtitle,
        body: options.body ? translateNativeText(options.body) : options.body
      });
    }
  }

  try {
    Object.defineProperty(electron, "Notification", {
      value: TranslatedNotification,
      configurable: true,
      enumerable: true
    });
  } catch (error) {
    console.warn("[agy-i18n] Unable to wrap electron.Notification:", error);
  }
}
