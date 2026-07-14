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
        // land on the selector screen. Electron kept the previous 
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

/**
 * Creates the primary app window running Databricks.
 */
function createWindow() {
    const workspace = workspaceManager.current();
    if (!workspace) return;

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        title: `Databricks Desktop Workspace Viewer - ${workspace.name}`,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: `persist:${workspace.id}`,
        },
    });

    mainWindow.loadURL(workspace.url);

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        const isWorkspace = url.includes("databricks.com") || url.includes("login");
        if (!isWorkspace) {
            shell.openExternal(url);
            return { action: "deny" };
        }
        return { action: "allow" };
    });

    // --------------------------------------------------- 
    // Open selector back up after the main window is closed, 
    // so the user can select a different workspace.
    // ---------------------------------------------------
    mainWindow.on("closed", () => {
        mainWindow = null;
        workspaceManager.setActive(null); // Reset state

        // --------------------------------------------
        // Bring the workspace selector back up
        // --------------------------------------------
        if (!setupWindow) {
            createSetupWindow();
        }
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