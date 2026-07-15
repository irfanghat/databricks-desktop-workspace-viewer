const { app, BrowserWindow, session, shell, ipcMain, Menu } = require("electron");
const Store = require("electron-store");
const path = require("path");

const store = new Store();
let mainWindow;
let setupWindow;

/**
 * Workspace management.
 */
class WorkspaceManager {
    constructor() {
        this.workspaces = store.get("workspaces", []);
        // ---------------------------------------------------------
        // Always reset active workspace on boot so we 
        // land on the selector screen. Electron keeps previous 
        // session active, which is not desired.
        // ---------------------------------------------------------
        this.activeWorkspace = null;
        store.set("activeWorkspace", null);
    }

    hasWorkspaces() {
        return this.workspaces.length > 0;
    }

    getWorkspaces() {
        return this.workspaces;
    }

    setActive(id) {
        this.activeWorkspace = id;
        store.set("activeWorkspace", id);
    }

    current() {
        return this.workspaces.find(w => w.id === this.activeWorkspace);
    }

    addWorkspace(name, url) {
        const id = `ws_${Date.now()}`;
        const newWorkspace = { id, name, url };

        this.workspaces.push(newWorkspace);
        this.setActive(id);

        store.set("workspaces", this.workspaces);
        return newWorkspace;
    }

    editWorkspace(id, name, url) {
        const index = this.workspaces.findIndex(w => w.id === id);
        if (index !== -1) {
            this.workspaces[index] = { id, name, url };
            store.set("workspaces", this.workspaces);
            return true;
        }
        return false;
    }

    deleteWorkspace(id) {
        this.workspaces = this.workspaces.filter(w => w.id !== id);
        store.set("workspaces", this.workspaces);
    }
}

const workspaceManager = new WorkspaceManager();

const { URL } = require("url");

function isAllowedHost(hostname, allowedHosts) {
    return allowedHosts.some(
        (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`)
    );
}

function getAllowedHosts(workspace) {
    const workspaceHost = new URL(workspace.url).hostname;

    return [
        workspaceHost,
        "databricks.com",
        "azuredatabricks.net",
        "gcp.databricks.com",
        "cloud.databricks.com",
        // Common SSO/IdP providers
        "login.microsoftonline.com",
        "accounts.google.com",
        "okta.com",
        "oktapreview.com",
        "pingone.com",
        "auth0.com",
    ];
}

function isHttpUrl(urlString) {
    try {
        const { protocol } = new URL(urlString);
        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
}

/**
 * Creates the primary app window.
 */
function createWindow() {
    const workspace = workspaceManager.current();
    if (!workspace) return;

    const allowedHosts = getAllowedHosts(workspace);
    const partition = `persist:${workspace.id}`;

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        title: `Databricks Desktop Workspace Viewer - ${workspace.name}`,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            partition,
        },
    });

    mainWindow.loadURL(workspace.url);
    attachNavigationGuards(mainWindow, allowedHosts, partition);
    setupDeviceAuthHandlers(session.fromPartition(partition), allowedHosts);

    mainWindow.on("closed", () => {
        mainWindow = null;
        workspaceManager.setActive(null);
        if (!setupWindow) createSetupWindow();
    });
}

/**
 * Handle MFA/SSO popups.
 */
function attachNavigationGuards(win, allowedHosts, partition) {
    const wc = win.webContents;

    wc.setWindowOpenHandler(({ url }) => {
        let hostname;
        try {
            hostname = new URL(url).hostname;
        } catch {
            return { action: "deny" };
        }

        if (!isAllowedHost(hostname, allowedHosts)) {
            handleExternal(url);
            return { action: "deny" };
        }

        // --------------------------------------------------
        // SSO popups are allowed to open, but we want to 
        // control their size and features.
        // --------------------------------------------------
        return {
            action: "allow",
            overrideBrowserWindowOptions: {
                width: 500,
                height: 700,
                autoHideMenuBar: true,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    sandbox: true,
                    webSecurity: true,
                    partition,
                },
            },
        };
    });

    wc.on("will-navigate", (event, url) => {
        let hostname;
        try {
            hostname = new URL(url).hostname;
        } catch {
            event.preventDefault();
            return;
        }
        if (!isAllowedHost(hostname, allowedHosts)) {
            event.preventDefault();
            handleExternal(url);
        }
    });

    wc.on("will-attach-webview", (event) => event.preventDefault());

    wc.on("did-create-window", (childWindow) => {
        attachNavigationGuards(childWindow, allowedHosts, partition);
    });
}

/**
 * WebAuthn security keys (USB HID) and Bluetooth MFA require explicit 
 * device permissions.
 */
function setupDeviceAuthHandlers(ses, allowedHosts) {
    const originAllowed = (details) => {
        try {
            return isAllowedHost(new URL(details.securityOrigin ?? details.requestingUrl).hostname, allowedHosts);
        } catch {
            return false;
        }
    };

    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
        if (["hid", "usb", "bluetooth", "serial"].includes(permission) && originAllowed(details)) {
            return callback(true);
        }
        callback(false);
    });

    ses.setDevicePermissionHandler((details) => {
        return ["hid", "usb", "bluetooth"].includes(details.deviceType) && originAllowed(details);
    });

    // --------------------------------------------------------------------
    // Auto-select if exactly one matching device shows up, for a
    // single plugged-in security key, otherwise let the user pick.
    // --------------------------------------------------------------------
    ses.on("select-hid-device", (event, details, callback) => {
        event.preventDefault();
        callback(details.deviceList.length === 1 ? details.deviceList[0].deviceId : undefined);
    });

    ses.on("select-bluetooth-device", (event, deviceList, callback) => {
        event.preventDefault();
        callback(deviceList.length === 1 ? deviceList[0].deviceId : "");
    });
}

/**
 * Opens the Workspace Selector / Setup window.
 */
function createSetupWindow() {
    setupWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        resizable: true,
        title: "Select Workspace",
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    setupWindow.loadFile(path.join(__dirname, "setup.html"));

    // -------------------------------------------------------------
    // Quit app if no active workspace is open i.e. 
    // main window is closed and the setup window is closed.
    // -------------------------------------------------------------
    setupWindow.on("closed", () => {
        setupWindow = null;
        if (!mainWindow) {
            app.quit();
        }
    });
}

ipcMain.handle("get-workspaces", () => {
    return workspaceManager.getWorkspaces();
});

ipcMain.on("select-workspace", (event, workspaceId) => {
    workspaceManager.setActive(workspaceId);
    if (setupWindow) setupWindow.close();
    createWindow();
});

ipcMain.on("save-initial-workspace", (event, data) => {
    workspaceManager.addWorkspace(data.name, data.url);
    if (setupWindow) setupWindow.close();
    createWindow();
});

ipcMain.on("edit-workspace", (event, data) => {
    workspaceManager.editWorkspace(data.id, data.name, data.url);
    // ---------------------------------------------------------------
    // Notify the UI to refresh the list without launching the app
    // ---------------------------------------------------------------
    event.reply("workspaces-updated", workspaceManager.getWorkspaces());
});

ipcMain.on("delete-workspace", (event, workspaceId) => {
    workspaceManager.deleteWorkspace(workspaceId);
    event.reply("workspaces-updated", workspaceManager.getWorkspaces());
});

/**
 * App initialization & lifecycle checks
 */
app.whenReady().then(() => {
    Menu.setApplicationMenu(null);

    session.defaultSession.webRequest.onBeforeSendHeaders(
        (details, callback) => {
            details.requestHeaders["User-Agent"] =
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

            callback({
                cancel: false,
                requestHeaders: details.requestHeaders,
            });
        }
    );

    // --------------------------------------------
    // Startup setup/selector window
    // --------------------------------------------
    createSetupWindow();
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createSetupWindow();
    }
});