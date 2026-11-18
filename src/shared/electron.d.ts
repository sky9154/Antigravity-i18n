declare module "electron" {
  export interface BrowserWindow {
    id: number;
  }

  export interface MenuItemConstructorOptions {
    id?: string;
    label?: string;
    sublabel?: string;
    toolTip?: string;
    type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
    role?: string;
    accelerator?: string;
    icon?: unknown;
    enabled?: boolean;
    visible?: boolean;
    checked?: boolean;
    submenu?: MenuItemConstructorOptions[] | Menu;
    click?: (menuItem: MenuItem, browserWindow: BrowserWindow | undefined, event: unknown) => void;
  }

  export interface MenuItem {
    id: string;
    label: string;
    sublabel: string;
    toolTip: string;
    type: "normal" | "separator" | "submenu" | "checkbox" | "radio";
    role?: string;
    accelerator?: string;
    icon?: unknown;
    enabled: boolean;
    visible: boolean;
    checked: boolean;
    submenu?: Menu;
    click: (menuItem: MenuItem, browserWindow: BrowserWindow | undefined, event: unknown) => void;
  }

  export class Menu {
    items: MenuItem[];
    insert(pos: number, menuItem: MenuItem): void;
    popup(options?: unknown): void;
    closePopup(browserWindow?: BrowserWindow): void;
    static setApplicationMenu(menu: Menu | null): void;
    static getApplicationMenu(): Menu | null;
    static buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
  }

  export class Tray {
    setContextMenu(menu: Menu | null): void;
    setToolTip(toolTip: string): void;
    isDestroyed(): boolean;
  }

  export interface MessageBoxOptions {
    title?: string;
    message?: string;
    detail?: string;
    buttons?: string[];
    checkboxLabel?: string;
  }

  export const dialog: {
    showMessageBox: (...args: unknown[]) => Promise<unknown>;
    showMessageBoxSync: (...args: unknown[]) => number;
    showOpenDialog: (...args: unknown[]) => Promise<unknown>;
    showOpenDialogSync: (...args: unknown[]) => string[] | undefined;
    showSaveDialog: (...args: unknown[]) => Promise<unknown>;
    showSaveDialogSync: (...args: unknown[]) => string | undefined;
  };

  export interface NotificationConstructorOptions {
    title?: string;
    subtitle?: string;
    body?: string;
  }

  export class Notification {
    constructor(options?: NotificationConstructorOptions);
  }

  export interface WebFrameMain {
    url?: string;
    parent?: WebFrameMain | null;
  }

  export interface WebContents {
    isDestroyed(): boolean;
    getType?(): string;
    getURL?(): string;
    mainFrame?: WebFrameMain;
    send(channel: string, ...args: unknown[]): void;
  }

  export interface IpcMainInvokeEvent {
    sender: WebContents;
    senderFrame?: WebFrameMain | null;
  }

  export const app: {
    getPath(name: string): string;
    whenReady(): Promise<void>;
  };

  export const webContents: {
    getAllWebContents(): WebContents[];
  };

  export const ipcMain: {
    handle: (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
    ) => void;
  };

  export const ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => void;
    removeListener: (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => void
    ) => void;
  };

  export const webFrame: {
    executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  };

  const electronExport: {
    app: typeof app;
    webContents: typeof webContents;
    Menu: typeof Menu;
    Tray: typeof Tray;
    dialog: typeof dialog;
    Notification: typeof Notification;
    ipcMain: typeof ipcMain;
    ipcRenderer: typeof ipcRenderer;
    webFrame: typeof webFrame;
  };

  export default electronExport;
}
