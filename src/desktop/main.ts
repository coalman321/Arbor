// Electron entry point: runs the Arbor server inside the app and shows the UI in a window. Closing
// the window quits the app, and the server with it. Projects are opened from the UI's own screen.
// Bundled to build/desktop/main.cjs by scripts/bundle.mjs and packaged by electron-builder.

import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { configDir, distLoader, startServer, Workspace, type RunningServer } from "../server/index.ts";
import { isNewer, latestRelease } from "./update.ts";

// The UI keeps its settings in localStorage, which belongs to the page's origin; a fixed port keeps
// that origin (and the settings) the same from one launch to the next.
const PREFERRED_PORT = 47821;

let server: RunningServer | null = null;
let win: BrowserWindow | null = null;

async function listen(): Promise<RunningServer> {
  const workspace = new Workspace(null, configDir());
  const opts = { workspace, host: "127.0.0.1", loadStatic: distLoader(join(app.getAppPath(), "dist")) };
  try {
    return await startServer({ ...opts, port: PREFERRED_PORT });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    return startServer({ ...opts, port: 0 }); // works, but settings won't carry over this time
  }
}

// Electron's default menu closes the window on Ctrl/Cmd+W, before the page sees the key. The UI
// uses that shortcut to close the open tree's tab, so closing the window moves to Ctrl/Cmd+Shift+W.
function setMenu() {
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: "appMenu" } as const] : []),
    { label: "File", submenu: [{ role: "close", accelerator: "CmdOrCtrl+Shift+W" }, ...(mac ? [] : [{ role: "quit" } as const])] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { label: "Window", submenu: mac ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "minimize" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function start() {
  setMenu();
  server = await listen();
  const origin = `http://127.0.0.1:${server.port}`;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Arbor",
    autoHideMenuBar: true,
    // Linux takes the taskbar icon from the window; macOS and Windows use the packaged app's.
    icon: join(app.getAppPath(), "resources", "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links to other sites open in the system browser. Dropping a file the UI doesn't handle would
  // otherwise navigate the window to it and away from the editor.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (new URL(url).origin === origin) return;
    e.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  // The UI asks before closing with unsaved edits (beforeunload); a browser shows that prompt
  // itself, Electron leaves it to the app.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win!, {
      type: "warning",
      message: "You have unsaved changes.",
      detail: "Close Arbor anyway and lose them?",
      buttons: ["Close Anyway", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) e.preventDefault(); // preventing the prevention lets the window close
  });
  win.on("closed", () => (win = null));
  await win.loadURL(`${origin}/`);
  if (app.isPackaged) void checkForUpdate();
}

async function checkForUpdate() {
  const release = await latestRelease();
  if (!release || !win || !isNewer(release.version, app.getVersion())) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    message: `Arbor ${release.version} is available.`,
    detail: `You have ${app.getVersion()}. Open the release page to download it?`,
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) void shell.openExternal(release.url);
}

// One server per machine: a second launch brings the existing window forward instead.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => server?.close());
  app
    .whenReady()
    .then(start)
    .catch((e) => {
      dialog.showErrorBox("Arbor couldn't start", (e as Error).message ?? String(e));
      app.quit();
    });
}
