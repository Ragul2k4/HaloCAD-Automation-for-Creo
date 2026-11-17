/**
 * Microsoft-sign.js   (Creo version of Microsoft-login.js)
 *
 * In Creo the login is NOT done at the start. It happens while the protected file is being opened:
 *   1. Start Creo, find the main window, close the Creo start popups
 *   2. Open the file from CONFIG.file.path (Ctrl+O, path, Enter)
 *   3. While the file opens, the HaloCAD popup comes BEHIND the Open window -> OK is pressed without the focus
 *      (UI Automation Invoke), the popup watcher is started before the file is opened
 *   4. Then the Microsoft sign-in window comes -> type the user name and the password
 *      (a popup watcher, a separate process, presses OK on every later HaloCAD popup)
 *   5. The file opens (its name is in a Creo window title)
 *   6. Read the label shown in the HaloCAD "Sensitivity" bar
 *   7. Rights check, depending on the role of the user (CONFIG.rights.users):
 *        - viewer (QC1)    : open the File menu and check that Save, Save As and Print are DISABLED
 *        - can edit / save : Ctrl+S must open the "Save Object" window
 *        - unauthorised    : the file must NOT open
 *   8. Close Creo (also after a failed test) and write the result to the log
 *
 * If the user is already signed in, no popup and no login window come, and the file simply opens.
 * The log goes only to the log file (CONFIG.log.file). The password is never written to the log.
 *
 * Password: set the environment variable HALO_PASSWORD (and HALO_USER if you want another user),
 *           or type it in CONFIG.login.password.
 *
 * Run:  node Microsoft-sign.js
 * (No Appium is needed: Creo is controlled with Windows APIs, UI Automation and OCR.)
 */
const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- settings (change here, not in the code below) ----------
const CONFIG = {
    log: {
        file: 'Microsoft-sign-log.txt',
        showInTerminal: false         // false = log only in the file
    },

    creo: {
        exePath: 'C:\\Program Files\\PTC\\Creo 13.4.0.0\\Parametric\\bin\\parametric.exe', // <-- check this path
        processNames: ['parametric.exe', 'xtop.exe'],
        startFolder: 'C:\\Users\\TESTUSER\\Documents',      // Creo is started in this folder
        minWidth: 800,                // the main window is big, the splash window is small
        minHeight: 500,
        waitForWindow: 120000,        // ms to wait for the main window
        loadWait: 10000,              // ms to wait after the main window is found
        popupTitles: ['Administrator Mapkeys Update', 'Resource Center'],   // Creo start popups to close
        closeAtEnd: true              // true = close Creo when the test is finished
    },

    login: {
        // The role (viewer / edit / unauthorised) is taken from this user name, see CONFIG.rights.users
        username: process.env.HALO_USER || 'QC1@halosecude.onmicrosoft.com',    // <-- QC1, QC2, QC3, QC4 or QC5
        password: process.env.HALO_PASSWORD || 'Secude#321',           // <-- password of that user

        popupTitle: 'HaloCAD',                               // exact title of the HaloCAD popups
        loginTitles: ['Sign in to your account', 'Sign in'], // title of the Microsoft login window
        okButtonName: 'OK',           // button of the popups
        waitForPopup: 60000,          // ms to wait for the HaloCAD popup after Enter in the Open window
        waitForLoginWindow: 30000,    // ms to wait for the Microsoft login window after OK
        pageTimeout: 40000,           // ms to wait until the next Microsoft page (password page) is really shown
        signInFallback: { x: 0.75, y: 0.55 },   // where the Sign in button is inside the window (0..1), used only if its text is not found
        pageSettle: 2500,             // ms to let the password page finish its slide-in before the password is typed
        pageWait: 8000,               // ms fixed wait, only used if the page text cannot be read
        stepPause: 6000               // ms after the user name / password, so the next page is ready
    },

    file: {
        // protected file created by QC4. The path is typed in the Open window exactly as written here.
        path: 'C:\\Users\\TESTUSER\\Documents\\Part_0002.prt',   // <-- check this path
        stripVersion: false,          // true = remove the version number at the end (.1) before typing the path
        expectedLabel: 'QC_Confidential',
        openShortcut: '^o',           // Ctrl+O
        openDialogTitle: 'File Open',
        // Creo does not take the keys until you click inside it: a point on an EMPTY part of the ribbon (0..1)
        focusClick: { x: 0.57, y: 0.095 },
        waitForOpen: 60000            // ms to wait until the file name is in a Creo window title (after the login)
    },

    // Rights of every user for a file protected with QC_Confidential. Keys must be written in lower case.
    //   menu: { 'Save': false, ... }  = open the File menu: false = the item must be DISABLED, true = it must be ENABLED
    //   save: true / false            = Ctrl+S must (true) or must NOT (false) open the Save window
    // Use "menu", "save" or both. A check that is not written here is not done.
    rights: {
        enabled: true,
        users: {
            // QC1 = viewer: after the file is open, Save, Save As and Print in the File menu must be disabled
            'qc1@halosecude.onmicrosoft.com': { role: 'Viewer',                 canOpen: true,  expect: { menu: { 'Save': false, 'Save As': false, 'Print': false } } },
            'qc2@halosecude.onmicrosoft.com': { role: 'View, edit, copy, print', canOpen: true,  expect: { save: true } },
            'qc3@halosecude.onmicrosoft.com': { role: 'Unauthorised',           canOpen: false, expect: {} },
            'qc4@halosecude.onmicrosoft.com': { role: 'Owner',                  canOpen: true,  expect: { save: true } },
            'qc5@halosecude.onmicrosoft.com': { role: 'View, edit',             canOpen: true,  expect: { save: true } }
        },
        saveShortcut: '^s',           // Ctrl+S
        saveDialogTitle: 'Save Object',
        waitForSaveDialog: 10000,     // ms to wait for the Save window
        blockedOpenWait: 25000,       // ms to wait for an unauthorised user (the file must not open)

        // the File menu of Creo (the big menu with New, Open, Save, Save As, Print, Close ... and "Recent Files")
        fileMenu: {
            tabName: 'File',          // the tab that opens the menu (top left of the Creo window)
            // The word "File" is WHITE on a GREEN tab, so OCR often cannot read it. Then this point is clicked instead.
            // Pixels from the top-left corner of the Creo window to the middle of the green File tab (Creo maximised: dx 37, dy 46).
            tabPoint: { dx: 37, dy: 46 },
            waitAfterClick: 2500,     // ms to wait until the menu is shown
            area: { width: 230, height: 520 },   // the left part of the Creo window that OCR reads (the column with the items)
            // A disabled item has grey text, an enabled item has black text. The script looks for the DARKEST pixel of the text
            // (0 = black, 255 = white). Darkest pixel at or above this number = grey = DISABLED. The numbers are written to the log.
            disabledMinLuminance: 110,
            // only used if OCR cannot read a grey word: the position is taken from the word "Open" and the row distance below it
            rowsBelowOpen: { 'Save': 1, 'Save As': 2, 'Print': 3 },
            closeRowsBelowOpen: 4     // the item "Close" is 4 rows below "Open" (used to find the row height)
        }
    },

    halo: {
        waitAfterOpen: 6000,          // ms to let HaloCAD show its bar
        waitForBar: 40000             // ms to wait until the Sensitivity bar is visible
    },

    ocrScale: 3,
    screenshotFolder: 'screenshots'
};

// ---------- logging (file only) ----------
const LOG_FILE = path.join(__dirname, CONFIG.log.file);
const SHOT_DIR = path.join(__dirname, CONFIG.screenshotFolder);
const original = { log: console.log.bind(console) };

try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch { /* ignore */ }

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function writeLog(level, args) {
    const text = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try {
        fs.appendFileSync(LOG_FILE, `${stamp()} | ${level.padEnd(5)} | ${text}\n`, 'utf8');
    } catch {
        // never stop the automation because of the log file
    }
}

console.log = (...args) => { if (CONFIG.log.showInTerminal) original.log(...args); writeLog('INFO', args); };
console.warn = (...args) => { if (CONFIG.log.showInTerminal) original.log(...args); writeLog('WARN', args); };
console.error = (...args) => { if (CONFIG.log.showInTerminal) original.log(...args); writeLog('ERROR', args); };

function action(name, details = '') {
    console.log(`${name.padEnd(8)} | ${details}`);
}

const summary = {
    file: path.basename(CONFIG.file.path),
    user: CONFIG.login.username,
    role: 'not defined',
    login: 'not done',
    opened: 'no',
    labelOnBar: 'not checked',
    fileMenu: 'not checked',
    rights: 'not tested'
};

function printSummary() {
    console.log('----------------------------------------------------');
    console.log(`File name      : ${summary.file}`);
    console.log(`Logged in as   : ${summary.user}`);
    console.log(`Role           : ${summary.role}`);
    console.log(`Login          : ${summary.login}`);
    console.log(`File opened    : ${summary.opened}`);
    console.log(`Label on bar   : ${summary.labelOnBar}`);
    console.log(`File menu      : ${summary.fileMenu}`);
    console.log(`Rights check   : ${summary.rights}`);
    console.log('----------------------------------------------------');
}

// ---------- helpers ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = text => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
const firstLine = error => String(error.message || error).split('\n')[0];

function runPowerShell(script, timeout = 120000, extraEnv = {}) {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout,
        env: { ...process.env, ...extraEnv }
    }).trim();
}

/** Fixes the letters that OCR often mixes up, so "Confldential" and "Confidential" look the same. */
const ocrNormalize = text => normalize(text).replace(/[l1|!]/g, 'i').replace(/0/g, 'o');

/** Small difference allowed: true if the two texts are almost the same (about 1 wrong letter in 8). */
function looksLike(read, expected) {
    const a = ocrNormalize(read);
    const b = ocrNormalize(expected);
    if (a.includes(b)) return true;

    const allowed = Math.max(1, Math.floor(b.length / 8));
    for (let i = 0; i + b.length <= a.length; i++) {
        let wrong = 0;
        for (let k = 0; k < b.length && wrong <= allowed; k++) {
            if (a[i + k] !== b[k]) wrong++;
        }
        if (wrong <= allowed) return true;
    }
    return false;
}

// ---------- Creo process ----------
function killCreo() {
    CONFIG.creo.processNames.forEach(name => {
        try {
            execSync(`taskkill /IM ${name} /F`, { stdio: 'ignore' });
            console.log(`Closed: ${name}`);
        } catch {
            // not running, this is fine
        }
    });
}

function creoRunning() {
    return CONFIG.creo.processNames.some(name => {
        try {
            const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: 'utf8' });
            return out.toLowerCase().includes(name.toLowerCase());
        } catch {
            return false;
        }
    });
}

async function startCreo() {
    const creo = CONFIG.creo;

    if (!fs.existsSync(creo.exePath)) {
        throw new Error(`Creo not found: ${creo.exePath}. Set CONFIG.creo.exePath.`);
    }

    killCreo();

    const end = Date.now() + 15000;
    while (Date.now() < end && creoRunning()) await sleep(1000);
    await sleep(3000);

    fs.mkdirSync(creo.startFolder, { recursive: true });
    spawn(creo.exePath, [], { cwd: creo.startFolder, detached: true, stdio: 'ignore' }).unref();
    action('LAUNCH', `Creo started: ${creo.exePath}`);
}

// ---------- windows ----------
// C# helper: lists all visible windows with handle, process id, position, size and title
const WIN_CS = `
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class CreoWin {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    public static List<string> All() {
        List<string> res = new List<string>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (IsWindowVisible(h)) {
                uint pid; GetWindowThreadProcessId(h, out pid);
                RECT r; GetWindowRect(h, out r);
                StringBuilder sb = new StringBuilder(512);
                GetWindowText(h, sb, 512);
                res.Add(h.ToInt64() + "|" + pid + "|" + r.L + "|" + r.T + "|" + (r.R - r.L) + "|" + (r.B - r.T) + "|" + sb.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return res;
    }
}`;

// focus without the Alt key (a tapped Alt switches on the ribbon key tips in Creo), close, mouse click
const CTL_CS = `
using System;
using System.Runtime.InteropServices;
public class WinCtl {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    public static void Focus(IntPtr h) {
        uint pid;
        uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        AttachThreadInput(me, fg, true);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        AttachThreadInput(me, fg, false);
    }
}`;

/** All visible windows that belong to Creo programs: [{ handle, pid, x, y, width, height, title }] */
function listCreoWindows() {
    const procs = CONFIG.creo.processNames.map(n => n.replace(/\.exe$/i, '')).join(',');

    const out = runPowerShell(`
        Add-Type -TypeDefinition $env:WIN_CS
        $ids = @(Get-Process ($env:CREO_PROCS -split ',') -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
        foreach ($line in [CreoWin]::All()) {
            $parts = $line -split '\\|'
            if ($ids -contains [int]$parts[1]) { $line }
        }
    `, 40000, { WIN_CS, CREO_PROCS: procs });

    return out.split(/\r?\n/).filter(l => l.includes('|')).map(l => {
        const [handle, pid, x, y, width, height, ...rest] = l.split('|');
        return {
            handle, pid,
            x: Number(x), y: Number(y), width: Number(width), height: Number(height),
            title: rest.join('|').trim()
        };
    });
}

/** Titles of all visible top-level windows of ALL programs (the Microsoft sign-in window is not a Creo window). */
function listWindowTitles() {
    const out = runPowerShell(`
        Add-Type -TypeDefinition $env:WIN_CS
        foreach ($line in [CreoWin]::All()) {
            $parts = $line -split '\\|', 7
            if ($parts[6].Length -gt 0) { $parts[6] }
        }
    `, 30000, { WIN_CS });

    return out.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

function getWindowByHandle(handle) {
    return listCreoWindows().find(w => w.handle === String(handle)) || null;
}

async function waitForCreoHandle(ms) {
    const end = Date.now() + ms;
    const seen = new Set();

    while (Date.now() < end) {
        let windows = [];

        try {
            windows = listCreoWindows();
        } catch (error) {
            console.warn(`Could not list the windows: ${firstLine(error)}`);
        }

        windows.forEach(w => {
            const key = `${w.handle}|${w.width}x${w.height}|${w.title}`;

            if (!seen.has(key)) {
                seen.add(key);
                console.log(`  window: handle=${w.handle} pid=${w.pid} size=${w.width}x${w.height} title="${w.title}"`);
            }
        });

        const big = windows
            .filter(w => w.width >= CONFIG.creo.minWidth && w.height >= CONFIG.creo.minHeight)
            .sort((a, b) => b.width * b.height - a.width * a.height);

        if (big.length) {
            console.log(`Main window chosen: title="${big[0].title}" size=${big[0].width}x${big[0].height}`);
            return big[0].handle;
        }

        await sleep(3000);
    }

    throw new Error('No big Creo window found. Look at the "window:" lines in the log.');
}

async function waitForTitle(title, ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        try {
            const w = listCreoWindows().find(x => x.title.toLowerCase() === title.toLowerCase());
            if (w) return w;
        } catch {
            // try again
        }

        await sleep(1000);
    }

    return null;
}

async function waitUntilTitleGone(title, ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        try {
            if (!listCreoWindows().some(x => x.title.toLowerCase() === title.toLowerCase())) return true;
        } catch {
            // try again
        }

        await sleep(1000);
    }

    return false;
}

// Windows that must never be taken for the popup / login window
const IGNORE_WINDOWS = /Visual Studio Code|Creo Parametric|PTC Creo|PowerShell|Command Prompt|Windows Terminal|node\.exe|Edge|Chrome|Firefox|Notepad|File Explorer|Snipping/i;

/** Waits for a window whose title is (or contains) one of the given words. An exact title wins. */
async function waitForWindow(titles, ms, exactOnly = false) {
    const wanted = titles.map(t => t.toLowerCase());
    const end = Date.now() + ms;

    while (Date.now() < end) {
        let names = [];

        try {
            names = listWindowTitles();
        } catch (error) {
            console.warn(`Could not list the windows: ${firstLine(error)}`);
        }

        const exact = names.find(n => wanted.includes(n.toLowerCase()));
        if (exact) return { name: exact };

        if (!exactOnly) {
            const part = names.find(n => !IGNORE_WINDOWS.test(n) && wanted.some(t => n.toLowerCase().includes(t)));
            if (part) return { name: part };
        }

        await sleep(1000);
    }

    return null;
}

function windowStillOpen(name) {
    try {
        return listWindowTitles().includes(name);
    } catch {
        return false;
    }
}

async function waitUntilGone(name, ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        if (!windowStillOpen(name)) return true;
        await sleep(700);
    }

    return !windowStillOpen(name);
}

// ---------- keyboard, mouse, focus ----------
function focusWindow(handle) {
    runPowerShell(`
        Add-Type -TypeDefinition $env:CTL_CS
        $h = [IntPtr][long]$env:WIN_HANDLE
        if ([WinCtl]::IsIconic($h)) { [void][WinCtl]::ShowWindow($h, 9) }
        [WinCtl]::Focus($h)
    `, 20000, { CTL_CS, WIN_HANDLE: String(handle) });
}

function closeWindow(handle) {
    runPowerShell(`
        Add-Type -TypeDefinition $env:CTL_CS
        [void][WinCtl]::PostMessage([IntPtr][long]$env:WIN_HANDLE, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    `, 20000, { CTL_CS, WIN_HANDLE: String(handle) });
}

/** Real mouse click at a screen position. */
function clickAt(x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    console.log(`  mouse click at x=${px} y=${py}`);

    runPowerShell(`
        Add-Type -TypeDefinition $env:CTL_CS
        [void][WinCtl]::SetCursorPos([int]$env:CLICK_X, [int]$env:CLICK_Y)
        Start-Sleep -Milliseconds 200
        [WinCtl]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        [WinCtl]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    `, 30000, { CTL_CS, CLICK_X: String(px), CLICK_Y: String(py) });
}

/** Sends keys like a person, for example '^s' = Ctrl+S, '{ENTER}' = Enter. */
function sendKeys(keys) {
    runPowerShell(`
        Add-Type -AssemblyName System.Windows.Forms
        try { [System.Windows.Forms.SendKeys]::SendWait($env:KEYS) } catch { }
    `, 20000, { KEYS: keys });
}

function pressEnter() {
    sendKeys('{ENTER}');
}

/** Pastes text with Ctrl+V (the text goes through an environment variable, so it is not in the command line). */
function pasteText(text, pressEnterKey, selectAll = false) {
    const out = runPowerShell(`
        Add-Type -AssemblyName System.Windows.Forms
        Set-Clipboard -Value $env:TYPE_TEXT
        Start-Sleep -Milliseconds 300
        try {
            ${selectAll ? "[System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 200" : ''}
            [System.Windows.Forms.SendKeys]::SendWait('^v')
            Start-Sleep -Milliseconds 400
            ${pressEnterKey ? "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')" : ''}
            'ok'
        } catch {
            'blocked'
        }
        Start-Sleep -Milliseconds 300
        Set-Clipboard -Value ' '
    `, 30000, { TYPE_TEXT: text });

    if (out.includes('blocked')) {
        console.warn(
            'Keyboard input is blocked ("Access is denied"). The window runs with higher rights than this terminal. ' +
            'Start VS Code / the terminal as Administrator.'
        );
        return false;
    }

    return true;
}

/** Brings a window to the front by its title (used for the Microsoft login window and the popups). */
function activateWindow(title) {
    const safe = title.replace(/'/g, "''");

    return runPowerShell(`
        $shell = New-Object -ComObject WScript.Shell
        if ($shell.AppActivate('${safe}')) { 'yes' } else { 'no' }
    `, 20000) === 'yes';
}

/**
 * Clicks an element (any control type) with the given name inside a window found by its title.
 * First UI Automation Invoke, then a real mouse click in the middle of the element.
 * Returns 'clicked', 'no-element' or 'no-window'.
 */
function clickByName(windowTitle, elementName) {
    const out = runPowerShell(`
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $A = [System.Windows.Automation.AutomationElement]
        $T = [System.Windows.Automation.TreeScope]
        $winCond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:WIN_TITLE)
        $win = $A::RootElement.FindFirst($T::Children, $winCond)

        if (-not $win) {
            'no-window'
        } else {
            $elCond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:EL_NAME)
            $el = $win.FindFirst($T::Descendants, $elCond)

            if (-not $el) {
                'no-element'
            } else {
                $done = $false
                try {
                    $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                    $done = $true
                } catch { }

                if ($done) {
                    'clicked'
                } else {
                    $r = $el.Current.BoundingRectangle
                    if ($r.Width -gt 0 -and $r.Height -gt 0) {
                        'rect:{0}|{1}' -f [int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)
                    } else {
                        'no-element'
                    }
                }
            }
        }
    `, 30000, { WIN_TITLE: windowTitle, EL_NAME: elementName });

    const last = out.split(/\r?\n/).pop();

    if (last.startsWith('rect:')) {
        const [x, y] = last.slice(5).split('|').map(Number);
        clickAt(x, y);
        return 'clicked';
    }

    return last;
}

/** Position and size of a window found by its title. Returns { x, y, width, height } or null. */
function getWindowRect(title) {
    const out = runPowerShell(`
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        $A = [System.Windows.Automation.AutomationElement]
        $cond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:WIN_TITLE)
        $win = $A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

        if ($win) {
            $r = $win.Current.BoundingRectangle
            '{0}|{1}|{2}|{3}' -f [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height
        } else {
            'none'
        }
    `, 20000, { WIN_TITLE: title });

    const last = out.split(/\r?\n/).pop();

    if (last === 'none') return null;

    const [x, y, width, height] = last.split('|').map(Number);
    return width > 0 && height > 0 ? { x, y, width, height } : null;
}

// ---------- screenshot and OCR ----------
function saveScreenshot(rect, fileName) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, fileName);

    runPowerShell(`
        Add-Type -AssemblyName System.Drawing
        $w = [int]$env:AREA_W; $h = [int]$env:AREA_H
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$env:AREA_X, [int]$env:AREA_Y, 0, 0, $bmp.Size)
        $g.Dispose()
        $bmp.Save($env:SHOT_FILE)
        $bmp.Dispose()
    `, 30000, {
        AREA_X: String(Math.round(rect.x)), AREA_Y: String(Math.round(rect.y)),
        AREA_W: String(Math.round(rect.width)), AREA_H: String(Math.round(rect.height)),
        SHOT_FILE: file
    });

    return file;
}

function shot(rect, name) {
    try {
        console.log(`Screenshot saved: ${saveScreenshot(rect, `${name}-${Date.now()}.png`)}`);
    } catch (error) {
        console.warn(`Could not save the screenshot: ${firstLine(error)}`);
    }
}

/** Reads the text of a screen area with OCR. Returns every WORD with its centre on the screen: [{ x, y, text }] */
function ocrWords(rect) {
    const temp = path.join(os.tmpdir(), 'creo-ocr.png');

    try {
        const out = runPowerShell(`
            Add-Type -AssemblyName System.Drawing
            Add-Type -AssemblyName System.Runtime.WindowsRuntime

            $x = [int]$env:AREA_X; $y = [int]$env:AREA_Y
            $w = [int]$env:AREA_W; $h = [int]$env:AREA_H; $s = [int]$env:OCR_SCALE
            $src = New-Object System.Drawing.Bitmap $w, $h
            $g = [System.Drawing.Graphics]::FromImage($src)
            $g.CopyFromScreen($x, $y, 0, 0, $src.Size)
            $g.Dispose()
            $dst = New-Object System.Drawing.Bitmap ($w * $s), ($h * $s)
            $g2 = [System.Drawing.Graphics]::FromImage($dst)
            $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g2.DrawImage($src, 0, 0, ($w * $s), ($h * $s))
            $g2.Dispose()
            $dst.Save($env:OCR_PNG)
            $src.Dispose(); $dst.Dispose()

            $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
            $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
            $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType=WindowsRuntime]

            $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
                $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
            })[0]

            function Await($op, $type) {
                $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
                [void]$t.Wait(-1)
                $t.Result
            }

            $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:OCR_PNG)) ([Windows.Storage.StorageFile])
            $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $engine  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
            $result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

            foreach ($line in $result.Lines) {
                foreach ($word in $line.Words) {
                    $r = $word.BoundingRect
                    '{0}|{1}|{2}' -f ([int]($x + ($r.X + $r.Width / 2) / $s)), ([int]($y + ($r.Y + $r.Height / 2) / $s)), $word.Text
                }
            }
            $stream.Dispose()
        `, 120000, {
            AREA_X: String(Math.round(rect.x)), AREA_Y: String(Math.round(rect.y)),
            AREA_W: String(Math.round(rect.width)), AREA_H: String(Math.round(rect.height)),
            OCR_SCALE: String(CONFIG.ocrScale), OCR_PNG: temp
        });

        return out.split(/\r?\n/).filter(Boolean).map(line => {
            const [wx, wy, ...rest] = line.split('|');
            return { x: Number(wx), y: Number(wy), text: rest.join('|') };
        });
    } finally {
        try { fs.unlinkSync(temp); } catch { /* ignore */ }
    }
}

/** Finds a word with OCR inside an area. Returns { x, y, text } (the left one if there are several) or null. */
function findWord(area, word) {
    const hits = ocrWords(area).filter(w => normalize(w.text) === normalize(word)).sort((a, b) => a.x - b.x);
    return hits[0] || null;
}

// ---------- Microsoft login window (text of the page) ----------
/** Reads the text shown in a window with OCR (the window is brought to the front first). */
function readWindowText(title) {
    try {
        activateWindow(title);
        const rect = getWindowRect(title);

        if (!rect) return '';

        return ocrWords(rect).map(w => w.text).join(' ').replace(/\s+/g, ' ').trim();
    } catch {
        return '';
    }
}

/**
 * Waits until the text of the window matches the pattern.
 * Returns 'found', 'not-found' or 'unreadable' (the text could not be read at all).
 */
async function waitForPageText(title, pattern, ms) {
    const end = Date.now() + ms;
    let anyText = false;

    while (Date.now() < end) {
        const text = readWindowText(title);

        if (text) {
            anyText = true;
            console.log(`  page text: "${text.slice(0, 90)}"`);

            if (pattern.test(text)) return 'found';
        }

        await sleep(1500);
    }

    return anyText ? 'not-found' : 'unreadable';
}

/** Finds the words "Sign in" on the login window (the lowest match). Returns { x, y } or null. */
function findSignInButton(title) {
    activateWindow(title);

    const rect = getWindowRect(title);
    if (!rect) return null;

    const words = ocrWords(rect);
    console.log(`  words read by OCR: ${words.map(w => w.text).join(' ')}`);

    const hits = [];

    words.forEach((w, i) => {
        const t = normalize(w.text);
        const next = words[i + 1];

        if (t === 'signin') {
            hits.push({ x: w.x, y: w.y });
        } else if (t === 'sign' && next && normalize(next.text) === 'in' && Math.abs(next.y - w.y) < 15 && next.x - w.x < 80) {
            hits.push({ x: Math.round((w.x + next.x) / 2), y: w.y });
        }
    });

    // the title of the page ("Sign in") is on the top, the button is the lowest one
    return hits.sort((a, b) => b.y - a.y)[0] || null;
}

/**
 * Login with the keyboard. Each page is recognised by its text (OCR), so the password
 * is never typed into the user name box.
 */
async function keyboardLogin(windowTitle) {
    const login = CONFIG.login;

    console.log(`Password check: length=${login.password.length}, has #=${login.password.includes('#')}, has @=${login.password.includes('@')}`);

    // 1. user name page
    console.log('Waiting for the user name page...');
    const page1 = await waitForPageText(windowTitle, /next|skype|phone/i, login.pageTimeout);

    if (page1 === 'unreadable') {
        console.warn(`Page text cannot be read, waiting ${login.pageWait} ms instead.`);
        await sleep(login.pageWait);
    } else if (page1 === 'not-found') {
        console.warn('User name page not recognised, typing the user name anyway.');
    }

    activateWindow(windowTitle);
    await sleep(800);

    action('LOGIN', `Typing user name: ${login.username}`);
    pasteText(login.username, true);

    // 2. wait until the password page is really shown
    console.log('Waiting for the password page...');
    let page2 = await waitForPageText(windowTitle, /password/i, 15000);

    if (page2 === 'not-found') {
        console.warn('Password page not shown yet, pressing Enter once more.');
        activateWindow(windowTitle);
        await sleep(500);
        pressEnter();
        page2 = await waitForPageText(windowTitle, /password/i, login.pageTimeout);
    }

    if (page2 === 'not-found') {
        throw new Error('The password page did not appear after the user name. Password was NOT typed.');
    }

    if (page2 === 'unreadable') {
        console.warn(`Page text cannot be read, waiting ${login.stepPause} ms instead.`);
        await sleep(login.stepPause);
    }

    // The page is still sliding in when the word "password" first appears: let it finish
    await sleep(login.pageSettle);

    activateWindow(windowTitle);
    await sleep(800);

    action('LOGIN', 'Typing password');
    pasteText(login.password, true);

    // Make sure "Sign in" was really pressed. If the password page is still shown, try other ways.
    const ways = ['click Sign in (found by its text)', 'Enter', 'click Sign in (fixed position)', 'click Sign in (found by its text)'];

    for (let i = 0; i < ways.length; i++) {
        await sleep(6000);

        if (!windowStillOpen(windowTitle)) return;

        const text = readWindowText(windowTitle);
        console.log(`  page text after password: "${text.slice(0, 90)}"`);

        if (/incorrect|doesn.t match|isn.t valid/i.test(text)) {
            console.warn('Microsoft says the password is not correct.');
            return;
        }

        if (!/enter password/i.test(text)) return;

        console.warn(`Still on the password page, trying: ${ways[i]}`);
        activateWindow(windowTitle);
        await sleep(500);

        if (ways[i] === 'Enter') {
            pressEnter();
        } else if (ways[i].includes('fixed position')) {
            const rect = getWindowRect(windowTitle);

            if (rect) {
                clickAt(rect.x + rect.width * login.signInFallback.x, rect.y + rect.height * login.signInFallback.y);
            }
        } else {
            const button = findSignInButton(windowTitle);

            if (button) {
                clickAt(button.x, button.y);
            } else {
                console.warn('The text "Sign in" was not found on the window.');
            }
        }
    }
}

// ---------- popup watcher ----------
// A separate PowerShell process that presses OK on every HaloCAD popup (for example
// "You do not have permission to save due to view only access.").
// It must be a separate process: execFileSync blocks Node, so Node itself cannot click while it waits
// for Creo, and Creo waits for the click on the popup.
// The popup is found with Win32 EnumWindows (sees every top-level window, also owned ones)
// and then the UI Automation element is taken from the window handle.
const POPUP_LOG = path.join(os.tmpdir(), 'halocad-creo-popups.txt');
let popupWatcher = null;

const POPUP_CS = `
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class PopupWin {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    public static List<long> Find(string title) {
        List<long> r = new List<long>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (IsWindowVisible(h)) {
                StringBuilder sb = new StringBuilder(512);
                GetWindowText(h, sb, 512);
                if (sb.ToString().Trim().Equals(title, StringComparison.OrdinalIgnoreCase)) r.Add(h.ToInt64());
            }
            return true;
        }, IntPtr.Zero);
        return r;
    }
    public static long Foreground() { return GetForegroundWindow().ToInt64(); }
    // brings a window to the front, also over a window that does not respond (no Alt key is used)
    public static void Focus(long hv) {
        IntPtr h = new IntPtr(hv);
        uint pid;
        uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint me = GetCurrentThreadId();
        if (IsIconic(h)) ShowWindow(h, 9);
        AttachThreadInput(me, fg, true);
        BringWindowToTop(h);
        SetForegroundWindow(h);
        AttachThreadInput(me, fg, false);
    }
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(200);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(80);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
    }
}`;

function startPopupWatcher() {
    if (popupWatcher) return;   // already running

    try { fs.unlinkSync(POPUP_LOG); } catch { /* ignore */ }

    const script = `
        Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -TypeDefinition $env:POPUP_CS
        $A = [System.Windows.Automation.AutomationElement]
        $T = [System.Windows.Automation.TreeScope]
        $seen = @{}
        while ($true) {
            try {
                $handles = @([PopupWin]::Find($env:POPUP_TITLE))
                if ($handles.Count -eq 0) { $seen.Clear() }
                foreach ($h in $handles) {
                    $w = $A::FromHandle([IntPtr]$h)
                    $btnCond = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:OK_NAME)
                    $btn = $w.FindFirst($T::Descendants, $btnCond)
                    if ($btn) {
                        if (-not $seen.ContainsKey($h)) {
                            $textCond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
                            $texts = @()
                            foreach ($t in $w.FindAll($T::Descendants, $textCond)) { $texts += $t.Current.Name }
                            Add-Content -Path $env:POPUP_LOG -Value ($texts -join ' ')
                            $seen[$h] = $true
                        }
                        try {
                            # UI Automation Invoke does not need the focus: it also works when the popup is behind another window
                            $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                        } catch {
                            # bring the popup to the front. Keys / clicks only if it is really in front (never into another window)
                            [PopupWin]::Focus([long]$h)
                            Start-Sleep -Milliseconds 400
                            if ([PopupWin]::Foreground() -eq [long]$h) {
                                $r = $btn.Current.BoundingRectangle
                                if ($r.Width -gt 0 -and $r.Height -gt 0) {
                                    [PopupWin]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
                                } else {
                                    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
                                }
                            }
                        }
                    }
                }
            } catch { }
            Start-Sleep -Milliseconds 500
        }
    `;

    popupWatcher = spawn('powershell.exe', ['-NoProfile', '-Command', script], {
        env: {
            ...process.env,
            POPUP_TITLE: CONFIG.login.popupTitle,
            OK_NAME: CONFIG.login.okButtonName,
            POPUP_CS,
            POPUP_LOG
        },
        stdio: 'ignore'
    });

    console.log('Popup watcher started (presses OK on HaloCAD popups).');
}

function popupTextsSoFar() {
    try {
        return fs.readFileSync(POPUP_LOG, 'utf8').split(/\r?\n/).map(t => t.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

/** Stops the watcher and writes the text of every popup it answered to the log. */
function stopPopupWatcher() {
    if (!popupWatcher) return;

    try { popupWatcher.kill(); } catch { /* ignore */ }
    popupWatcher = null;

    popupTextsSoFar().forEach(t => console.log(`Popup answered: "${t.slice(0, 200)}"`));
}

// the watcher must never stay alive after this script ends
process.on('exit', () => {
    if (popupWatcher) {
        try { popupWatcher.kill(); } catch { /* ignore */ }
    }
});

// ---------- popup and login ----------
/** All visible windows of ALL programs: [{ handle, x, y, width, height, title }] */
function listAllWindows() {
    const out = runPowerShell(`
        Add-Type -TypeDefinition $env:WIN_CS
        [CreoWin]::All()
    `, 30000, { WIN_CS });

    return out.split(/\r?\n/).filter(l => l.includes('|')).map(l => {
        const [handle, pid, x, y, width, height, ...rest] = l.split('|');
        return { handle, pid, x: Number(x), y: Number(y), width: Number(width), height: Number(height), title: rest.join('|').trim() };
    });
}

function windowsByTitle(title) {
    try {
        return listAllWindows().filter(w => w.title.toLowerCase() === title.toLowerCase());
    } catch {
        return [];
    }
}

/** UI Automation Invoke on a button of a window (by handle). It needs no focus, so it works on a popup that is behind another window. */
function uiaInvokeByHandle(handle, name) {
    try {
        return runPowerShell(`
            Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
            $A = [System.Windows.Automation.AutomationElement]
            $T = [System.Windows.Automation.TreeScope]
            try { $win = $A::FromHandle([IntPtr][long]$env:WIN_HANDLE) } catch { $win = $null }
            if (-not $win) { 'no-window' } else {
                $c = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:EL_NAME)
                $e = $win.FindFirst($T::Descendants, $c)
                if (-not $e) { 'no-element' } else {
                    try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); 'clicked' } catch { 'no-pattern' }
                }
            }
        `, 30000, { WIN_HANDLE: String(handle), EL_NAME: name }).split(/\r?\n/).pop();
    } catch (error) {
        return `error: ${firstLine(error)}`;
    }
}

function isOkWord(w) {
    return ['ok', '0k'].includes(normalize(w.text));
}

/**
 * Confirms the HaloCAD popup. In Creo it comes BEHIND the "File Open" window, so:
 *   1. UI Automation Invoke on OK (works without focus, the popup can stay in the background)
 *   2. bring the popup to the front (Win32, no Alt key) and click the word OK that OCR finds in it
 *   3. bring it to the front and press Enter (only after step 2, so Enter never goes into the Open window)
 * Returns how it closed, or null.
 */
async function confirmPopup(popup) {
    const title = popup.name;
    const okName = CONFIG.login.okButtonName;

    for (let attempt = 1; attempt <= 3; attempt++) {
        const w = windowsByTitle(title)[0];

        if (!w) return 'closed by itself or by the watcher';

        console.log(`  popup "${title}" handle=${w.handle} position=${w.x},${w.y} size=${w.width}x${w.height}`);

        // 1. no focus needed
        const inv = uiaInvokeByHandle(w.handle, okName);
        console.log(`  "${okName}" (UI Automation, try ${attempt}): ${inv}`);
        if (inv === 'clicked' && await waitUntilGone(title, 3000)) return 'UI Automation (popup stayed in the background)';

        // 2. to the front, then click the OK that OCR sees
        focusWindow(w.handle);
        await sleep(1000);

        const now = windowsByTitle(title)[0];
        if (!now) return 'closed';

        const hit = ocrWords(now).filter(isOkWord).sort((a, b) => b.y - a.y)[0];

        if (hit) {
            clickAt(hit.x, hit.y);
            if (await waitUntilGone(title, 3000)) return 'OCR click (popup brought to the front)';
        } else {
            console.warn('  the word OK was not found in the popup by OCR.');
        }

        // 3. Enter, popup is in front now
        focusWindow(w.handle);
        await sleep(500);
        pressEnter();
        if (await waitUntilGone(title, 3000)) return 'Enter key (popup brought to the front)';
    }

    return null;
}

async function loginToMicrosoft() {
    const login = CONFIG.login;

    if (login.password === 'ENTER_PASSWORD_HERE') {
        throw new Error('No password set. Set the environment variable HALO_PASSWORD or type it in CONFIG.login.password.');
    }

    console.log(`Waiting for the "${login.popupTitle}" popup (the file is opening)...`);

    let popup = null;
    const endPopup = Date.now() + login.waitForPopup;

    let loginSeen = false;

    while (Date.now() < endPopup && !popup && !loginSeen) {
        if (modelIsOpen()) break;   // the file is already open: no login is needed

        let names = [];
        try { names = listWindowTitles(); } catch { /* try again */ }

        if (names.some(n => n.toLowerCase() === login.popupTitle.toLowerCase())) {
            popup = { name: login.popupTitle };
        } else if (names.some(n => !IGNORE_WINDOWS.test(n) && login.loginTitles.some(t => n.toLowerCase().includes(t.toLowerCase())))) {
            loginSeen = true;   // the watcher already pressed OK on the popup
        } else {
            await sleep(1500);
        }
    }

    if (!popup && !loginSeen && modelIsOpen()) {
        summary.login = 'not needed (the file opened without a login, the user was already signed in)';
        console.log('The file opened without a HaloCAD popup, so no login is needed.');
        startPopupWatcher();
        return;
    }

    if (popup) {
        action('POPUP', `Window found: "${popup.name}"`);

        const how = await confirmPopup(popup);

        if (how) {
            action('POPUP', `"${login.okButtonName}" pressed (${how})`);
        } else {
            console.warn(`The popup "${popup.name}" is still open after Enter and a mouse click.`);
        }
    } else if (loginSeen) {
        console.log('The HaloCAD popup was already answered (by the watcher). The login window is open.');
    } else {
        console.warn(`The popup "${login.popupTitle}" did not appear. Looking for the login window anyway.`);
    }

    // From here on every HaloCAD popup is answered by the watcher (also during the login)
    startPopupWatcher();

    if (popup) {
        const gone = Date.now() + 10000;
        while (Date.now() < gone && windowStillOpen(popup.name)) await sleep(1000);
    }

    const win = await waitForWindow(login.loginTitles, login.waitForLoginWindow);

    if (!win) {
        summary.login = 'no login window was shown (user was probably already signed in)';
        console.warn(
            'No Microsoft login window appeared. The user is probably already signed in, ' +
            'so the script goes on and opens the file. (To test a fresh login, run Reset-user.js first.)'
        );
        return;
    }

    action('LOGIN', `Login window found: "${win.name}"`);

    await keyboardLogin(win.name);

    // Wait until the login window is gone. If a "Stay signed in?" page is shown, answer Yes (Enter).
    const end = Date.now() + login.waitForLoginWindow;

    while (Date.now() < end) {
        if (!windowStillOpen(win.name)) {
            summary.login = 'successful (login window closed)';
            action('LOGIN', `User: ${login.username} | Login window closed`);
            return;
        }

        const text = readWindowText(win.name);

        if (text) console.log(`  page text: "${text.slice(0, 90)}"`);

        if (/stay signed in/i.test(text)) {
            pressEnter();
            console.log('"Stay signed in?" answered with Yes.');
        } else if (/incorrect|doesn.t match|isn.t valid|try again/i.test(text)) {
            console.warn(`Microsoft reports a problem: "${text.slice(0, 120)}"`);
        }

        await sleep(2000);
    }

    summary.login = 'not confirmed (login window still open)';
    console.warn('The login window is still open. The password or an extra step (MFA) may be the problem.');
}

// ---------- Creo start popups ----------
async function closeCreoStartPopups() {
    const titles = CONFIG.creo.popupTitles.map(t => t.toLowerCase());

    for (let i = 0; i < 3; i++) {
        try {
            listCreoWindows().forEach(w => {
                if (titles.includes(w.title.toLowerCase())) {
                    closeWindow(w.handle);
                    console.log(`Creo popup closed: "${w.title}"`);
                }
            });
        } catch (error) {
            console.warn(`Could not check the Creo popups: ${firstLine(error)}`);
        }

        await sleep(2000);
    }
}

// ---------- open the file ----------
// what is typed in the Open window, and the model name that must appear in a Creo window title.
// Both are set by resolveFile() at the start of the run.
let FILE_PATH = CONFIG.file.path;
let MODEL = '';

const modelOf = p => path.basename(p).replace(/\.\d+$/, '').replace(/\.[^.]+$/, '');   // RTX_Creo.1 -> RTX_Creo, Part_0001.prt.1 -> Part_0001

/**
 * Finds the real file on the disk. Creo says "Cannot find ..." when the name is not exact.
 *   1. CONFIG.file.path as written (double backslashes are made single)
 *   2. the same without the version number at the end (.1)
 *   3. a file in the same folder with the same name and a Creo extension (.prt, .asm ...)
 */
function resolveFile() {
    const given = CONFIG.file.path.replace(/\\{2,}/g, '\\');
    const dir = path.dirname(given);
    const stem = modelOf(given).toLowerCase();
    const noVersion = given.replace(/\.\d+$/, '');

    let chosen = [given, noVersion].find(c => fs.existsSync(c));

    if (!chosen) {
        try {
            const files = fs.readdirSync(dir)
                .filter(n => n.toLowerCase().startsWith(`${stem}.`) && /\.(prt|asm|drw|frm|lay|sec|mfg|ntb)(\.\d+)?$/i.test(n))
                .sort();

            if (files.length) {
                chosen = path.join(dir, files[files.length - 1]).replace(/\.\d+$/, '');
                console.warn(`"${given}" does not exist. Found in the same folder: ${files.join(', ')}. Using: ${chosen}`);
            }
        } catch (error) {
            console.warn(`Could not read the folder ${dir}: ${firstLine(error)}`);
        }
    }

    if (!chosen) {
        console.warn(`The file was NOT found on the disk: ${given}. Creo will say "Cannot find". Check CONFIG.file.path (the real name can be for example ${stem}.prt).`);
        chosen = CONFIG.file.stripVersion ? noVersion : given;
    }

    FILE_PATH = chosen;
    MODEL = modelOf(chosen);
    summary.file = path.basename(chosen);
    console.log(`File to open: ${FILE_PATH} | model name: ${MODEL}`);
}

function modelIsOpen() {
    try {
        return listCreoWindows().some(w => normalize(w.title).includes(normalize(MODEL)));
    } catch {
        return false;
    }
}

/** Click on an empty part of the ribbon: Creo then takes the keyboard. */
function clickEmptyRibbon(main) {
    const f = CONFIG.file.focusClick;
    clickAt(main.x + main.width * f.x, main.y + main.height * f.y);
}

/** Clicks the "Model" tab (OCR finds the word), so the ribbon is on a safe tab. */
function clickModelTab(main) {
    const hit = findWord({ x: main.x, y: main.y, width: Math.min(900, main.width), height: 140 }, 'Model');

    if (!hit) {
        console.warn('  the word "Model" was not found on the ribbon.');
        return false;
    }

    clickAt(hit.x, hit.y);
    return true;
}

/** Ctrl+O, the full path, Enter. 3 tries to open the window. It does NOT wait for the file (the login comes first). */
async function startOpen(handle) {
    const f = CONFIG.file;
    let dialog = null;

    for (let attempt = 1; attempt <= 3 && !dialog; attempt++) {
        focusWindow(handle);
        await sleep(1000);

        const main = getWindowByHandle(handle);
        if (!main) throw new Error('The main Creo window was not found (open file).');

        action(`TRY ${attempt}`, 'click on the empty ribbon, then Ctrl+O');
        clickEmptyRibbon(main);
        await sleep(800);
        sendKeys(f.openShortcut);
        dialog = await waitForTitle(f.openDialogTitle, 8000);
    }

    if (!dialog) throw new Error(`The "${f.openDialogTitle}" window did not open.`);

    await sleep(1000);
    console.log(`  opening: ${FILE_PATH}`);
    pasteText(FILE_PATH, false, true);
    await sleep(500);
    sendKeys('{ENTER}');
}

/** Waits until the file name is in a Creo window title. */
async function waitForModel(ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        if (modelIsOpen()) return true;
        await sleep(1500);
    }

    return false;
}

/** Open the file. The HaloCAD popup and the Microsoft login come while it opens. */
async function openFile(handle) {
    action('OPEN', `File: ${path.basename(FILE_PATH)} | Path: ${FILE_PATH}`);

    // The HaloCAD popup comes behind the Open window. The watcher answers it without needing the focus.
    startPopupWatcher();

    await startOpen(handle);
    await loginToMicrosoft();   // HaloCAD popup -> OK -> Microsoft login (only if Creo asks for it)

    if (!(await waitForModel(CONFIG.file.waitForOpen))) {
        const main = getWindowByHandle(handle);
        if (main) shot(main, 'creo-open-fail');
        throw new Error(`"${path.basename(FILE_PATH)}" did not open (its name is not in a Creo window title).`);
    }

    summary.opened = 'yes';
    console.log('File opened.');
}

// ---------- read the label from the HaloCAD bar ----------
/**
 * Reads the text that the Sensitivity dropdown shows. Returns { text } or null if the Sensitivity bar is not found.
 * 1st: the small window of the HaloCAD bar itself (no title, about 400x44). 2nd: the upper half of the Creo window.
 */
function readSensitivity(handle) {
    const main = getWindowByHandle(handle);
    if (!main) return null;

    const areas = [];

    try {
        listCreoWindows()
            .filter(w => !w.title && w.height <= 70 && w.width >= 250 && w.width <= 700)
            .forEach(w => areas.push({ x: w.x, y: w.y, width: w.width, height: w.height, why: `bar window ${w.width}x${w.height}` }));
    } catch { /* ignore */ }

    areas.push({ x: main.x, y: main.y + 60, width: main.width, height: Math.round(main.height * 0.5), why: 'upper half of the Creo window' });

    for (const area of areas) {
        let words = [];

        try {
            words = ocrWords(area);
        } catch (error) {
            console.warn(`  OCR failed (${area.why}): ${firstLine(error)}`);
            continue;
        }

        console.log(`  OCR (${area.why}): ${words.map(w => w.text).join(' ')}`);

        const sens = words.find(w => normalize(w.text).includes('sensitiv'));
        if (!sens) continue;

        // the words on the same row, to the right of "Sensitivity" (the dropdown)
        const text = words
            .filter(w => w !== sens && w.x > sens.x + 5 && w.x < sens.x + 300 && Math.abs(w.y - sens.y) < 20)
            .sort((a, b) => a.x - b.x)
            .map(w => w.text)
            .join(' ');

        shot(area, 'creo-label-bar');
        return { text };
    }

    return null;
}

async function checkLabelOnBar(handle) {
    const expected = CONFIG.file.expectedLabel;

    action('VERIFY', 'read the Sensitivity label');
    await sleep(CONFIG.halo.waitAfterOpen);

    let read = null;
    const end = Date.now() + CONFIG.halo.waitForBar;

    while (Date.now() < end && !read) {
        try {
            read = readSensitivity(handle);
        } catch (error) {
            console.warn(`Could not read the bar: ${firstLine(error)}`);
        }

        if (!read) await sleep(2000);
    }

    if (read) {
        await sleep(3000);   // the bar can still be loading: read again
        try { read = readSensitivity(handle) || read; } catch { /* keep the first reading */ }
    }

    if (!read) {
        summary.labelOnBar = 'not readable (the Sensitivity bar was not found)';
        const m = getWindowByHandle(handle);
        if (m) shot(m, 'creo-bar-not-found');
        return;
    }

    console.log(`Text read from the Sensitivity bar: "${read.text}"`);

    if (looksLike(read.text, expected)) {
        summary.labelOnBar = `${expected} (same as expected)`;
    } else if (looksLike(read.text, 'Not set') || looksLike(read.text, 'No Protection')) {
        summary.labelOnBar = `DIFFERENT - the file is UNPROTECTED (bar shows: ${read.text})`;
    } else {
        summary.labelOnBar = `DIFFERENT - bar text: ${(read.text || '(nothing read)').slice(0, 60)}`;
    }

    action('VERIFY', `File: ${path.basename(FILE_PATH)} | Expected: ${expected} | Bar: ${read.text || '-'}`);
}

// ---------- File menu check (Save, Save As, Print) ----------
/**
 * UI Automation: is the element with this name, inside this screen area, enabled?
 * The area makes sure that the item of the File menu is taken, and not a button with the same name somewhere else
 * (for example the Save icon of the quick access toolbar).
 * Returns 'enabled', 'disabled', 'no-element' or 'error: ...'.
 */
function uiaEnabledInArea(handle, name, area) {
    try {
        return runPowerShell(`
            Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
            $A = [System.Windows.Automation.AutomationElement]
            $T = [System.Windows.Automation.TreeScope]
            try { $win = $A::FromHandle([IntPtr][long]$env:WIN_HANDLE) } catch { $win = $null }

            if (-not $win) {
                'no-element'
            } else {
                $c = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:EL_NAME)
                $ax = [int]$env:AREA_X; $ay = [int]$env:AREA_Y
                $aw = [int]$env:AREA_W; $ah = [int]$env:AREA_H
                $result = 'no-element'

                foreach ($e in $win.FindAll($T::Descendants, $c)) {
                    $r = $e.Current.BoundingRectangle
                    $cx = $r.X + $r.Width / 2
                    $cy = $r.Y + $r.Height / 2

                    if ($cx -ge $ax -and $cx -le ($ax + $aw) -and $cy -ge $ay -and $cy -le ($ay + $ah)) {
                        if ($e.Current.IsEnabled) { $result = 'enabled' } else { $result = 'disabled' }
                        break
                    }
                }

                $result
            }
        `, 60000, {
            WIN_HANDLE: String(handle), EL_NAME: name,
            AREA_X: String(Math.round(area.x)), AREA_Y: String(Math.round(area.y)),
            AREA_W: String(Math.round(area.width)), AREA_H: String(Math.round(area.height))
        }).split(/\r?\n/).pop();
    } catch (error) {
        return `error: ${firstLine(error)}`;
    }
}

/** The darkest pixel of a screen area: 0 = black, 255 = white. Black text = enabled item, grey text = disabled item. */
function darkestLuminance(rect) {
    const out = runPowerShell(`
        Add-Type -AssemblyName System.Drawing
        $w = [int]$env:AREA_W; $h = [int]$env:AREA_H
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$env:AREA_X, [int]$env:AREA_Y, 0, 0, $bmp.Size)
        $g.Dispose()
        $min = 255
        for ($j = 0; $j -lt $h; $j++) {
            for ($i = 0; $i -lt $w; $i++) {
                $c = $bmp.GetPixel($i, $j)
                $l = ($c.R + $c.G + $c.B) / 3
                if ($l -lt $min) { $min = $l }
            }
        }
        $bmp.Dispose()
        [int]$min
    `, 30000, {
        AREA_X: String(Math.round(rect.x)), AREA_Y: String(Math.round(rect.y)),
        AREA_W: String(Math.max(1, Math.round(rect.width))), AREA_H: String(Math.max(1, Math.round(rect.height)))
    });

    return Number(out.split(/\r?\n/).pop());
}

/**
 * Finds a menu item (one word or more, for example "Save As") in the OCR words of the File menu column.
 * Returns { x1, x2, y } (the text of the item: left edge, right edge, row) or null.
 * OCR gives only the centre of a word, so the edges are estimated from the number of letters.
 */
function findMenuItem(words, label) {
    const tokens = label.split(/\s+/).map(normalize).filter(Boolean);
    const half = t => Math.round(3.4 * t.length + 2);

    for (let i = 0; i + tokens.length <= words.length; i++) {
        if (!tokens.every((t, k) => normalize(words[i + k].text) === t)) continue;

        const part = words.slice(i, i + tokens.length);

        // the row must be the same for all the words
        if (part.some(w => Math.abs(w.y - part[0].y) > 10)) continue;

        // "Save" must not be taken from "Save As"
        const next = words[i + tokens.length];
        if (tokens.length === 1 && tokens[0] === 'save' && next && normalize(next.text) === 'as' && Math.abs(next.y - part[0].y) < 10) continue;

        return {
            x1: part[0].x - half(normalize(part[0].text)),
            x2: part[part.length - 1].x + half(normalize(part[part.length - 1].text)),
            y: Math.round(part.reduce((s, w) => s + w.y, 0) / part.length)
        };
    }

    return null;
}

/** The File menu is open when the words "Recent", "Prepare" or "Manage" are shown in the menu column. */
function fileMenuIsOpen(area) {
    try {
        const words = ocrWords({ x: area.x, y: area.y, width: area.width, height: area.height });
        // words that exist only in the File menu (not in the ribbon)
        return words.some(w => ['recent', 'prepare', 'manage'].includes(normalize(w.text)));
    } catch {
        return false;
    }
}

/**
 * Opens the File menu: 1st UI Automation on the "File" tab, 2nd a click on the word "File" (OCR).
 * Returns { main, area } when the menu is open, or null.
 */
async function openFileMenu(handle) {
    const fm = CONFIG.rights.fileMenu;

    focusWindow(handle);
    await sleep(800);

    const main = getWindowByHandle(handle);
    if (!main) throw new Error('The main Creo window was not found (File menu).');

    const area = {
        x: main.x,
        y: main.y + 30,
        width: Math.min(fm.area.width, main.width),
        height: Math.min(fm.area.height, main.height - 30)
    };

    action('MENU', `open the "${fm.tabName}" menu`);

    // 1st: UI Automation
    const inv = uiaInvokeByHandle(main.handle, fm.tabName);
    console.log(`  "${fm.tabName}" (UI Automation): ${inv}`);

    if (inv === 'clicked') {
        await sleep(fm.waitAfterClick);
        if (fileMenuIsOpen(area)) return { main, area };
        console.warn('  the File menu is not open after the UI Automation click.');
    }

    // 2nd: OCR, click on the word "File" (white text on a green tab, OCR often cannot read it)
    // 3rd: a fixed point on the green File tab (top left of the Creo window)
    for (let attempt = 1; attempt <= 2; attempt++) {
        const now = getWindowByHandle(handle) || main;
        const words = ocrWords({ x: now.x, y: now.y, width: Math.min(450, now.width), height: 140 });
        const hit = words
            .filter(w => normalize(w.text) === normalize(fm.tabName) && w.y > now.y + 25)
            .sort((a, b) => a.x - b.x)[0];

        if (hit) {
            console.log(`  the word "${fm.tabName}" was found by OCR (try ${attempt}).`);
            clickAt(hit.x, hit.y);
        } else {
            console.warn(`  the word "${fm.tabName}" was not found by OCR (try ${attempt}). Clicking the fixed point of the green File tab.`);
            clickAt(now.x + fm.tabPoint.dx, now.y + fm.tabPoint.dy);
        }

        await sleep(fm.waitAfterClick);

        if (fileMenuIsOpen(area)) return { main: getWindowByHandle(handle) || main, area };
        console.warn(`  the File menu is not open after the click (try ${attempt}).`);
    }

    return null;
}

/** Closes the File menu again (Esc). Returns true when it is closed. */
async function closeFileMenu(area) {
    for (let i = 0; i < 2; i++) {
        sendKeys('{ESC}');
        await sleep(1200);
        if (!fileMenuIsOpen(area)) return true;
    }

    console.warn('  the File menu is still open after Esc.');
    return false;
}

/**
 * Opens the File menu and checks every item of "expected" (for example { 'Save': false, 'Save As': false, 'Print': false }).
 * false = the item must be disabled, true = the item must be enabled.
 * Every item is checked with 1st UI Automation (IsEnabled), 2nd the colour of its text (grey = disabled).
 * Returns { ok, text }.
 */
async function checkFileMenu(handle, expected) {
    const fm = CONFIG.rights.fileMenu;
    const labels = Object.keys(expected);

    const opened = await openFileMenu(handle);

    if (!opened) {
        const m = getWindowByHandle(handle);
        if (m) shot(m, 'creo-file-menu-not-open');
        summary.fileMenu = 'FAIL (the File menu did not open)';
        return { ok: false, text: 'the File menu did not open' };
    }

    const { main, area } = opened;
    shot(area, 'creo-file-menu');

    const words = ocrWords(area);
    console.log(`  words read in the File menu: ${words.map(w => w.text).join(' ')}`);

    // reference items that are always enabled: their text colour is written to the log, to see the difference
    const open = findMenuItem(words, 'Open');
    const close = findMenuItem(words, 'Close');
    const rowGap = open && close ? (close.y - open.y) / fm.closeRowsBelowOpen : null;

    ['New', 'Open', 'Close'].forEach(ref => {
        const item = findMenuItem(words, ref);

        if (item) {
            try {
                console.log(`  reference "${ref}" (always enabled): darkest pixel = ${darkestLuminance({ x: item.x1 - 2, y: item.y - 8, width: item.x2 - item.x1 + 4, height: 16 })}`);
            } catch { /* only for the log */ }
        }
    });

    const lines = [];
    let allOk = true;

    for (const label of labels) {
        const shouldBeEnabled = expected[label] === true;
        let state = 'not-found';
        let how = '';
        let lum = null;

        // 1st: UI Automation
        const uia = uiaEnabledInArea(main.handle, label, area);
        console.log(`  "${label}" (UI Automation): ${uia}`);

        if (uia === 'enabled' || uia === 'disabled') {
            state = uia;
            how = 'UI Automation';
        } else {
            // 2nd: OCR finds the word, the colour of the text tells enabled / disabled
            let item = findMenuItem(words, label);
            how = 'text colour';

            // grey text is sometimes not read by OCR: take the position from "Open" and the row distance
            if (!item && open && rowGap && fm.rowsBelowOpen[label] !== undefined) {
                item = {
                    x1: open.x1,
                    x2: open.x1 + 7 * label.length,
                    y: Math.round(open.y + rowGap * fm.rowsBelowOpen[label])
                };
                how = 'text colour (position taken from "Open")';
                console.log(`  "${label}" was not read by OCR. Position taken from "Open": y=${item.y}`);
            }

            if (item) {
                try {
                    lum = darkestLuminance({ x: item.x1 - 2, y: item.y - 8, width: item.x2 - item.x1 + 4, height: 16 });
                    state = lum >= fm.disabledMinLuminance ? 'disabled' : 'enabled';
                    console.log(`  "${label}" darkest pixel = ${lum} (limit ${fm.disabledMinLuminance}) -> ${state}`);
                } catch (error) {
                    console.warn(`  could not measure the colour of "${label}": ${firstLine(error)}`);
                }
            }
        }

        const want = shouldBeEnabled ? 'enabled' : 'disabled';
        const ok = state === want;

        if (!ok) allOk = false;

        const detail = state === 'not-found'
            ? `${label}: NOT FOUND (expected ${want})`
            : `${label}: ${state}${lum !== null ? ` (pixel ${lum})` : ''}${ok ? '' : ` (expected ${want})`}`;

        lines.push({ label, state, ok, detail });
        action('MENU', `${label}: ${state} | expected ${want} | ${ok ? 'OK' : 'WRONG'} | by ${how || 'nothing'}`);
    }

    await closeFileMenu(area);

    const text = lines.map(l => l.detail).join(', ');

    summary.fileMenu = allOk
        ? `PASS (${text})`
        : `FAIL (${text})`;

    if (!allOk) {
        const m = getWindowByHandle(handle);
        if (m) shot(m, 'creo-file-menu-fail');
    }

    return { ok: allOk, text: `File menu: ${text}` };
}

// ---------- rights check ----------
/** The role of the configured user (from CONFIG.rights.users), or null when the user is not in the list. */
function getRole() {
    if (!CONFIG.rights.enabled) return null;

    const key = CONFIG.login.username.trim().toLowerCase();
    const role = CONFIG.rights.users[key];

    return role ? { user: key, ...role } : null;
}

/** Unauthorised user: the file must NOT open (the login is done like for every user). */
async function checkBlockedOpen(handle, role) {
    action('RIGHTS', `User: ${role.user} | Role: ${role.role} | Expected: the file does not open`);

    let opened = false;

    try {
        startPopupWatcher();
        await startOpen(handle);
        await loginToMicrosoft();
        opened = await waitForModel(CONFIG.rights.blockedOpenWait);
    } catch (error) {
        console.warn(`Open attempt stopped: ${firstLine(error)}`);
    }

    await sleep(2000);

    const main = getWindowByHandle(handle);
    if (main) shot(main, 'creo-blocked-open');

    summary.opened = opened ? 'yes' : 'no';

    const popups = popupTextsSoFar();
    console.log(`File open in Creo: ${opened} | popups answered: ${popups.length}`);

    summary.rights = opened
        ? `FAIL - ${role.role}: the file opened, but the user should have no access`
        : `PASS - ${role.role}: the file did not open (popups answered: ${popups.length})`;
}

/**
 * Users who can open the file. The checks that are written in "expect" of the user are done:
 *   menu -> open the File menu: Save, Save As, Print ... must be disabled (false) or enabled (true)
 *   save -> press Ctrl+S: the "Save Object" window must open (true) or must NOT open (false).
 *           (If the Save window opens, it is closed again with Esc, nothing is saved.)
 */
async function checkRights(handle, role) {
    const rt = CONFIG.rights;
    const expect = role.expect || {};
    const results = [];   // [{ ok, text }]

    const wanted = [];
    if (expect.menu) wanted.push(`File menu ${Object.entries(expect.menu).map(([k, v]) => `${k} ${v ? 'enabled' : 'disabled'}`).join(', ')}`);
    if (typeof expect.save === 'boolean') wanted.push(`Ctrl+S Save ${expect.save ? 'allowed' : 'blocked'}`);

    action('RIGHTS', `User: ${role.user} | Role: ${role.role} | Expected: ${wanted.join(' | ') || 'nothing defined'}`);

    // A. File menu: Save, Save As, Print ...
    if (expect.menu) {
        results.push(await checkFileMenu(handle, expect.menu));
    }

    // B. Ctrl+S
    if (typeof expect.save === 'boolean') {
        focusWindow(handle);
        await sleep(1000);

        const main = getWindowByHandle(handle);
        if (!main) throw new Error('The main Creo window was not found (rights check).');

        clickModelTab(main);
        await sleep(500);
        clickAt(main.x + main.width * 0.5, main.y + main.height * 0.6);   // click in the drawing area, so Creo takes the keys
        await sleep(800);

        const popupsBefore = popupTextsSoFar().length;
        sendKeys(rt.saveShortcut);

        const dialog = await waitForTitle(rt.saveDialogTitle, rt.waitForSaveDialog);
        const saveAllowed = !!dialog;

        if (dialog) {
            shot(dialog, 'creo-save-window');
            focusWindow(dialog.handle);
            await sleep(500);
            sendKeys('{ESC}');   // nothing is saved

            if (!(await waitUntilTitleGone(rt.saveDialogTitle, 5000))) {
                console.warn('The Save window is still open after Esc, closing it.');
                closeWindow(dialog.handle);
                await waitUntilTitleGone(rt.saveDialogTitle, 5000);
            }
        } else {
            await sleep(2000);   // give the popup watcher time to answer the HaloCAD popup
            shot(getWindowByHandle(handle) || main, 'creo-save-blocked');
        }

        const popups = popupTextsSoFar().slice(popupsBefore);
        popups.forEach(t => console.log(`Popup after Ctrl+S: "${t.slice(0, 200)}"`));

        const info = `Save window opened: ${saveAllowed} | HaloCAD popups after Ctrl+S: ${popups.length}`;
        console.log(`Rights result: ${info}`);

        const ok = saveAllowed === expect.save;

        results.push({
            ok,
            text: expect.save
                ? (ok ? `Ctrl+S: Save is allowed as expected (${info})` : `Ctrl+S: Save should be allowed, but the Save window did not open (${info})`)
                : (ok ? `Ctrl+S: Save is blocked as expected (${info})` : `Ctrl+S: Save should be blocked, but the Save window opened (${info})`)
        });
    }

    if (!results.length) {
        summary.rights = 'not decided - no expected values for this user (CONFIG.rights.users)';
        return;
    }

    const pass = results.every(r => r.ok);
    summary.rights = `${pass ? 'PASS' : 'FAIL'} - ${role.role}: ${results.map(r => r.text).join(' | ')}`;
}

// ---------- main ----------
async function run() {
    original.log(`Microsoft-sign.js started. Log file: ${LOG_FILE}`);

    console.log('==================== RUN START (Creo login and rights) ====================');
    console.log(`Log file: ${LOG_FILE}`);

    try {
        const role = getRole();

        if (role) {
            summary.role = role.role;
        } else {
            console.warn(`The user ${CONFIG.login.username} is not in CONFIG.rights.users, the rights check is skipped.`);
        }

        if (CONFIG.login.password === 'ENTER_PASSWORD_HERE') {
            throw new Error('No password set. Set the environment variable HALO_PASSWORD or type it in CONFIG.login.password.');
        }

        resolveFile();

        // 1. start Creo and find the main window
        await startCreo();

        console.log('Waiting for the main Creo window...');
        const handle = await waitForCreoHandle(CONFIG.creo.waitForWindow);
        console.log(`Waiting ${CONFIG.creo.loadWait / 1000} seconds for Creo to finish loading...`);
        await sleep(CONFIG.creo.loadWait);
        await closeCreoStartPopups();

        // 2. open the file: the HaloCAD popup and the Microsoft login come while it opens
        if (role && !role.canOpen) {
            await checkBlockedOpen(handle, role);   // unauthorised user: the file must not open
        } else {
            await openFile(handle);

            // from here on every HaloCAD popup is answered, in every step
            startPopupWatcher();

            // 3. label and rights
            await checkLabelOnBar(handle);

            if (role) await checkRights(handle, role);
        }
    } catch (error) {
        console.error('Test failed:', error.message);
        process.exitCode = 1;

        if (summary.rights === 'not tested') {
            summary.rights = `FAIL - the test stopped: ${firstLine(error)}`;
        }

        try {
            console.log(`Open windows: ${listWindowTitles().join(' | ')}`);
        } catch {
            // ignore
        }
    } finally {
        await sleep(1000);

        if (CONFIG.creo.closeAtEnd) {
            killCreo();      // the watcher is still on here, so a popup on close is answered too
            await sleep(2000);
            console.log(`CLOSEAPP | Creo running: ${creoRunning()}`);
        }

        stopPopupWatcher();

        printSummary();
        console.log('==================== RUN END ====================');
    }
}

run();