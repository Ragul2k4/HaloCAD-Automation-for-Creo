/**
 * Creo-test.js
 *
 * What this script does:
 *   1. Closes any old Creo, writes config.pro (working folder + mapkeys), starts Creo ONE time, finds the main window
 *   2. Appium attaches to the main window (title check + UI tree dump)
 *   3. Closes the start popups (Administrator Mapkeys Update, Resource Center)
 *   4. Creates a new file:
 *        - opens the "New" window (3 tries)
 *        - checks the type (and sub-type), types the file name, clicks OK
 *        - checks that the "New" window is closed
 *        - goes back to the "Model" tab
 *   5. Runs the design (mapkey), if configured
 *   6. Applies the HaloCAD sensitivity label (pencil -> label by name / index -> green button)
 *   7. Saves the file (Ctrl+S) in the save folder and checks that it is on the disk
 *   8. Closes the file, opens the same file again and reads the Sensitivity label
 *        QC_Confidential shown  -> FILE SECURITY : PROTECTED
 *        "Not set" shown        -> FILE SECURITY : UNPROTECTED
 *   9. Closes the file and Creo and writes the result to the log
 *
 * How the elements are found (the order is always the same):
 *   1st  UI Automation (by name)       -> best, if Creo shows the element
 *   2nd  OCR (read the screen text)    -> finds the word and clicks it
 *   3rd  Keyboard (Enter)              -> last help
 *
 * Run:   node Creo-test.js
 * Needs: Appium server on 127.0.0.1:4723 with the NovaWindows driver
 */
const { remote } = require('webdriverio');
const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- settings (change only here) ----------
const CONFIG = {
    appium: { hostname: '127.0.0.1', port: 4723, path: '/' },

    creo: {
        exePath: 'C:\\Program Files\\PTC\\Creo 13.4.0.0\\Parametric\\bin\\parametric.exe', // <-- check this path
        processNames: ['parametric.exe', 'xtop.exe'],  // programs to close (see Task Manager)
        minWidth: 800,                                 // the main window is big, the splash window is small
        minHeight: 500,
        waitForWindow: 120000,                         // ms to wait for the main window
        loadWait: 15000,                               // ms to wait after the window is found
        popupTitles: ['Administrator Mapkeys Update', 'Resource Center']   // windows to close at the start
    },

    newFile: {
        shortcut: '^n',                // Ctrl+N
        // Creo does not take the keys until you click inside it. So the script clicks first.
        // This is a point on an EMPTY part of the ribbon (0..1 of the window width and height).
        focusClick: { x: 0.57, y: 0.095 },
        dialogTitle: 'New',            // title of the window that opens
        // The type and sub-type are selected automatically. Write the name as you see it in the New window.
        // Types    : Layout, Sketch, Part, Assembly, Manufacturing, Drawing, Format, Notebook
        // Sub-types: Part -> Solid, Sheetmetal, Bulk, Harness  (leave '' to keep the default one)
        // You can also give them when you run:  node Creo-test.js Assembly
        //                                       node Creo-test.js Part Sheetmetal
        type: 'Part',
        subType: 'Solid',
        // Automatic name: Type + number, for example Part_0001, Part_0002, Assembly_0001 ...
        // The number goes up on every run (every type has its own number), so a name is never used twice.
        autoName: true,
        counterFile: 'creo-counter.json',   // the script remembers the last number here (delete it to start again from 0001)
        digits: 4,                          // 4 = 0001
        fileName: 'QC_test_file',           // used only when autoName is false ('' = keep the name that Creo gives)
        okButton: 'OK',
        waitForDialog: 20000,          // ms to wait for the New window
        afterOkWait: 5000              // ms to wait after OK
    },

    // The design (the content of the file). Creo runs a "mapkey" (a recorded macro).
    //   1. Record one in Creo (File > Options > Environment > Mapkeys Settings), give it a short key, for example  xx
    //   2. Open the config.pro that Creo saved, copy the full "mapkey xx ..." lines (with the continuation lines
    //      "mapkey(continued) ...") and paste them into mapkeyLines below, one line per string.
    //   3. Write the key in "keys".
    // The script writes these lines into config.pro before Creo starts, then sends the keys.
    // keys empty = the script makes no design and saves the empty file.
    // IMPORTANT: the mapkey must end with the feature finished (the green check). Otherwise Creo stays in Sketch mode.
    design: {
        keys: '',                      // keys of your mapkey, written like SendKeys, for example 'xx'
        mapkeyLines: [
            // 'mapkey xx @MAPKEY_LABELBox;~ Command `ProCmdModelNew` ;\\',
            // 'mapkey(continued) ...;'
        ],
        wait: 8000,                    // ms to wait until the design is finished (mapkey only)

        // AUTOMATIC DESIGN (used when "keys" is empty): the script builds a box with the Extrude tool, no recording needed.
        //   Extrude -> pick the plane in the model tree -> Rectangle -> 2 clicks -> OK (sketch) -> finish the extrude.
        // The depth is the default depth that Creo proposes. Set auto to false to save an empty part.
        auto: true,
        extrude: false,                          // false = 2D sketch only (Sketch tool). true = also make an Extrude (box)
        plane: 'FRONT',                          // the sketch plane, as written in the model tree
        graphicsCenter: { x: 0.55, y: 0.55 },    // centre of the drawing area (0..1 of the Creo window)
        boxSize: 0.06,                           // half size of the rectangle (0..1 of the window width)
        ribbonHeight: 190,                       // height (px) of the ribbon area that OCR reads
        sketchOkPoint: { x: 0.877, y: 0.078 },   // the green OK of the Sketch tab (used only if OCR cannot read "OK")
        stepWait: 2500                           // ms to wait after every step
    },

    save: {
        folder: 'C:\\Users\\TESTUSER\\Documents',   // the file is saved here
        shortcut: '^s',                // Ctrl+S
        dialogTitle: 'Save Object',    // title of the Save window
        waitForDialog: 15000,
        // Creo starts with this folder as working_directory (config.pro), so the Save window should open here.
        // If the folder name is NOT seen in the Save window, the script also tries the path line (address bar).
        useAddressBarFallback: true,
        // points inside the Save window (0..1 of its width and height), taken from your screenshot
        addressBar: { x: 0.45, y: 0.098 },   // the path line on the top
        okButton: { x: 0.26, y: 0.947 },     // the OK button (used only if UI Automation and OCR cannot find it)
        checkDiskWait: 15000           // ms to wait until the file is seen in the folder
    },

    // HaloCAD sensitivity label: pencil next to "Sensitivity" -> pick the label -> green button
    label: {
        enabled: true,
        name: 'QC_Confidential',   // label name as it is written in the list
        index: 1,                  // used only if the name is not found by OCR: how many items BELOW "--No Protection--" (1 = the first label)
        pencilDx: 275,             // pixels from the word "Sensitivity" to the pencil icon (same row)
        comboArrowDx: 241,         // pixels from the word "Sensitivity" to the arrow of the dropdown (same row)
        comboClickDx: 120,         // pixels from the word "Sensitivity" to a point in the MIDDLE of the dropdown (this is what the script clicks)
        area: { dx: -150, dy: -10, width: 650, height: 450 },  // area (relative to the word "Sensitivity") that OCR reads
        waitAfterClick: 2500
    },

    // check after saving: close the file, open the same file again, read the Sensitivity label
    verify: {
        enabled: true,
        closeShortcut: '^w',           // Ctrl+W closes the file (window) in Creo
        openShortcut: '^o',            // Ctrl+O
        openDialogTitle: 'File Open',
        // Creo keeps a closed file in its memory. Restarting Creo makes sure the file is really read from the DISK.
        restartCreo: true,
        waitForOpen: 40000,            // ms to wait until the file name is in a Creo window title
        waitForBar: 40000              // ms to wait until the Sensitivity bar is visible
    },

    ocrScale: 3,
    screenshotFolder: 'screenshots',
    log: { file: 'Creo-run-log.txt' },
    dumpFile: 'creo-ui-dump.xml',
    dialogDumpFile: 'creo-new-dialog-dump.txt'
};

// the types of the New window
const KNOWN_TYPES = ['Layout', 'Sketch', 'Part', 'Assembly', 'Manufacturing', 'Drawing', 'Format', 'Notebook'];

// the file ending that Creo gives to every type. Creo saves the files as  name.prt.1  (the number is the version)
const EXTENSIONS = { Layout: 'lay', Sketch: 'sec', Part: 'prt', Assembly: 'asm', Manufacturing: 'mfg', Drawing: 'drw', Format: 'frm', Notebook: 'ntb' };

// values from the command line win over CONFIG:  node Creo-test.js Assembly
if (process.argv[2]) CONFIG.newFile.type = process.argv[2];
if (process.argv[3] !== undefined) CONFIG.newFile.subType = process.argv[3];

/** Gives the correct name of the type (upper / lower case does not matter). Stops if the type does not exist. */
function resolveType(name) {
    const found = KNOWN_TYPES.find(t => t.toLowerCase() === String(name).trim().toLowerCase());

    if (!found) {
        throw new Error(`Unknown type "${name}". Use one of: ${KNOWN_TYPES.join(', ')}`);
    }

    return found;
}

const COUNTER_FILE = path.join(__dirname, CONFIG.newFile.counterFile);

/** Makes the next name for this type: Part_0001, Part_0002 ... The last number of every type is kept in a file. */
function nextFileName(type) {
    let counters = {};

    try {
        counters = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    } catch {
        counters = {};   // first run, or the file was deleted
    }

    const number = (Number(counters[type]) || 0) + 1;
    counters[type] = number;

    try {
        fs.writeFileSync(COUNTER_FILE, JSON.stringify(counters, null, 2), 'utf8');
    } catch (error) {
        writeLog(`WARNING: could not save the counter file, the next name can be the same: ${firstLine(error)}`);
    }

    return `${type}_${String(number).padStart(CONFIG.newFile.digits, '0')}`;
}

// ---------- log ----------
const LOG_FILE = path.join(__dirname, CONFIG.log.file);
const DUMP_FILE = path.join(__dirname, CONFIG.dumpFile);
const DIALOG_DUMP_FILE = path.join(__dirname, CONFIG.dialogDumpFile);
const SHOT_DIR = path.join(__dirname, CONFIG.screenshotFolder);

// start with a fresh log on every run
try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch { /* ignore */ }

function writeLog(message) {
    const line = `[${new Date().toLocaleString()}] ${message}\n`;
    console.log(line.trim());
    try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* ignore */ }
}

// values that one step gives to the next step
const state = { savedName: '' };

// short result of every step, printed at the end
const summary = {
    config: 'not done',
    popups: 'not done',
    newWindow: 'not done',
    type: 'not done',
    subType: 'not done',
    fileName: 'not done',
    ok: 'not done',
    created: 'not done',
    design: 'not done',
    label: 'not done',
    saveWindow: 'not done',
    saveFolder: 'not done',
    saved: 'not done',
    security: 'not done'
};

function printSummary() {
    writeLog('----------------------------------------------------');
    writeLog(`config.pro       : ${summary.config}`);
    writeLog(`Popups closed    : ${summary.popups}`);
    writeLog(`New window       : ${summary.newWindow}`);
    writeLog(`Type (${CONFIG.newFile.type})`.padEnd(17) + `: ${summary.type}`);
    writeLog(`Sub-type (${CONFIG.newFile.subType || 'default'})`.padEnd(17) + `: ${summary.subType}`);
    writeLog(`File name        : ${summary.fileName}`);
    writeLog(`OK pressed       : ${summary.ok}`);
    writeLog(`File created     : ${summary.created}`);
    writeLog(`Design           : ${summary.design}`);
    writeLog(`Label            : ${summary.label}`);
    writeLog(`Save window      : ${summary.saveWindow}`);
    writeLog(`Save folder      : ${summary.saveFolder}`);
    writeLog(`File saved       : ${summary.saved}`);
    writeLog(`File security    : ${summary.security}`);
    writeLog('----------------------------------------------------');
}

// ---------- helpers ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = text => String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
const firstLine = error => String(error.message || error).split('\n')[0];

function action(name, details = '') {
    writeLog(`${name.padEnd(8)} | ${details}`);
}

function runPowerShell(script, timeout = 30000, extraEnv = {}) {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout,
        env: { ...process.env, ...extraEnv }
    }).trim();
}

/** Fixes the letters that OCR often mixes up, so "Confldential" and "Confidential" look the same. */
const ocrNormalize = text => normalize(text)
    .replace(/[l1|!]/g, 'i')   // l, 1, | and ! are all read as i
    .replace(/0/g, 'o');       // 0 and o

/** Small difference allowed: true if the two texts are almost the same (about 1 wrong letter in 8). */
function looksLike(read, expected) {
    const a = ocrNormalize(read);
    const b = ocrNormalize(expected);
    if (a.includes(b)) return true;

    // slide the expected text over the read text and allow a few wrong letters
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

/** Closes Creo with force. It closes parametric.exe and xtop.exe. */
function killCreo() {
    CONFIG.creo.processNames.forEach(name => {
        try {
            execSync(`taskkill /IM ${name} /F`, { stdio: 'ignore' });
            writeLog(`Closed: ${name}`);
        } catch {
            // not running, this is fine
        }
    });
}

/** Is any Creo program still running? */
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

/** Counts how many times a tag name is in the XML, for example <Button */
function countTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[\\s>]`, 'g'));
    return match ? match.length : 0;
}

// ---------- config.pro (working folder + mapkeys) ----------
/**
 * Writes config.pro in the save folder. Creo reads it from the folder where it is started.
 * It sets working_directory (so the Save window opens in the right folder) and adds the mapkeys of the design.
 * Our block is marked with BEGIN / END lines, so an existing config.pro is kept and our block is replaced on every run.
 */
function writeCreoConfig() {
    const dir = CONFIG.save.folder;
    const file = path.join(dir, 'config.pro');
    const BEGIN = '! QC-AUTOMATION BEGIN';
    const END = '! QC-AUTOMATION END';

    const block = [
        BEGIN,
        `working_directory ${dir.replace(/\\/g, '/')}`,
        ...(CONFIG.design.mapkeyLines || []),
        END
    ].join('\n');

    let old = '';
    try { old = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }

    const cleaned = old.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\r?\\n?`, 'g'), '');
    const sep = cleaned && !cleaned.endsWith('\n') ? '\n' : '';

    fs.writeFileSync(file, cleaned + sep + block + '\n', 'utf8');
    writeLog(`config.pro written: ${file}`);
    summary.config = `written (${file})`;
}

// ---------- windows of Creo ----------
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

// C# helper: focus (without the Alt key), close, mouse click
// NOTE: the old version tapped the Alt key to get the focus. In the Creo ribbon a tapped Alt switches on the key tips,
// so the next Ctrl+S went to the ribbon and opened the Annotate tab. Focus() below does not use any key.
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
    [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
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

/** Waits for the main Creo window (the big one) and returns its handle. Every new window is written to the log. */
async function waitForCreoHandle(ms) {
    const end = Date.now() + ms;
    const seen = new Set();

    while (Date.now() < end) {
        let windows = [];

        try {
            windows = listCreoWindows();
        } catch (error) {
            writeLog(`Could not list the windows: ${firstLine(error)}`);
        }

        windows.forEach(w => {
            const key = `${w.handle}|${w.width}x${w.height}|${w.title}`;

            if (!seen.has(key)) {
                seen.add(key);
                writeLog(`  window: handle=${w.handle} pid=${w.pid} size=${w.width}x${w.height} title="${w.title}"`);
            }
        });

        const big = windows
            .filter(w => w.width >= CONFIG.creo.minWidth && w.height >= CONFIG.creo.minHeight)
            .sort((a, b) => b.width * b.height - a.width * a.height);

        if (big.length) {
            writeLog(`Main window chosen: title="${big[0].title}" size=${big[0].width}x${big[0].height}`);
            return big[0].handle;
        }

        await sleep(3000);
    }

    throw new Error('No big Creo window found. Look at the "window:" lines in the log to see what was found.');
}

/** Waits for a Creo window with exactly this title. Returns the window or null. */
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

/** Waits until no Creo window has this title. */
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

// ---------- keyboard, mouse, focus ----------
/** Brings a window to the front (no Alt key, so the ribbon key tips are NOT switched on). */
function focusWindow(handle) {
    runPowerShell(`
        Add-Type -TypeDefinition $env:CTL_CS
        $h = [IntPtr][long]$env:WIN_HANDLE
        if ([WinCtl]::IsIconic($h)) { [void][WinCtl]::ShowWindow($h, 9) }
        [WinCtl]::Focus($h)
    `, 20000, { CTL_CS, WIN_HANDLE: String(handle) });
}

/** Asks a window to close (like the X button). */
function closeWindow(handle) {
    runPowerShell(`
        Add-Type -TypeDefinition $env:CTL_CS
        [void][WinCtl]::PostMessage([IntPtr][long]$env:WIN_HANDLE, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    `, 20000, { CTL_CS, WIN_HANDLE: String(handle) });
}

/** Sends keys like a person, for example '^n' = Ctrl+N, '{ENTER}' = Enter. */
function sendKeys(keys) {
    runPowerShell(`
        Add-Type -AssemblyName System.Windows.Forms
        try { [System.Windows.Forms.SendKeys]::SendWait($env:KEYS) } catch { }
    `, 20000, { KEYS: keys });
}

/** Real mouse click at a screen position. */
function clickAt(x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    writeLog(`  mouse click at x=${px} y=${py}`);

    runPowerShell(`
        Add-Type -TypeDefinition $env:CTL_CS
        [void][WinCtl]::SetCursorPos([int]$env:CLICK_X, [int]$env:CLICK_Y)
        Start-Sleep -Milliseconds 200
        [WinCtl]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        [WinCtl]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    `, 30000, { CTL_CS, CLICK_X: String(px), CLICK_Y: String(py) });
}

/** Pastes text with Ctrl+V into the field that has the focus (the old text is selected first). */
function pasteText(text) {
    runPowerShell(`
        Add-Type -AssemblyName System.Windows.Forms
        Set-Clipboard -Value $env:TYPE_TEXT
        Start-Sleep -Milliseconds 300
        try {
            [System.Windows.Forms.SendKeys]::SendWait('^a')
            Start-Sleep -Milliseconds 200
            [System.Windows.Forms.SendKeys]::SendWait('^v')
        } catch { }
        Start-Sleep -Milliseconds 400
        Set-Clipboard -Value ' '
    `, 30000, { TYPE_TEXT: text });
}

// ---------- screenshot and OCR ----------
/** Saves a picture of a screen area. */
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

/**
 * Reads the text of a screen area with OCR. Returns every WORD with its centre on the screen:
 * [{ x, y, text }]. (Words, not lines, because a menu bar is one line: "File Model Analysis ...")
 */
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

// ---------- UI Automation on a window (by name) ----------
/**
 * One PowerShell helper for the actions: dump, radio-state, radio-select, set-text, get-text, click-button.
 * It gives back a short word like 'selected', 'done', 'clicked' or 'no-element'.
 * The names can be written as 'name one|name two' (the first one that exists is used).
 */
function uia(handle, action, name = '', value = '') {
    try {
        return runPowerShell(`
            Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
            $A = [System.Windows.Automation.AutomationElement]
            $T = [System.Windows.Automation.TreeScope]
            $CT = [System.Windows.Automation.ControlType]

            try { $win = $A::FromHandle([IntPtr][long]$env:WIN_HANDLE) } catch { $win = $null }

            function FindEl($type, $names) {
                foreach ($n in ($names -split '\\|')) {
                    $c = New-Object System.Windows.Automation.AndCondition(
                        (New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $type)),
                        (New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $n)))
                    $e = $win.FindFirst($T::Descendants, $c)
                    if ($e) { return $e }
                }
                return $null
            }

            if (-not $win) {
                'no-window'
            } elseif ($env:UIA_ACTION -eq 'dump') {
                foreach ($e in $win.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
                    '{0}|{1}|enabled={2}|id={3}' -f $e.Current.ControlType.ProgrammaticName, $e.Current.Name, $e.Current.IsEnabled, $e.Current.AutomationId
                }
            } elseif ($env:UIA_ACTION -eq 'radio-state' -or $env:UIA_ACTION -eq 'radio-select') {
                $e = FindEl ($CT::RadioButton) $env:UIA_NAME
                if (-not $e) {
                    'no-element'
                } else {
                    try {
                        $p = $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
                        if ($env:UIA_ACTION -eq 'radio-select') { $p.Select(); Start-Sleep -Milliseconds 500 }
                        if ($p.Current.IsSelected) { 'selected' } else { 'not-selected' }
                    } catch { 'no-pattern' }
                }
            } elseif ($env:UIA_ACTION -eq 'set-text' -or $env:UIA_ACTION -eq 'get-text') {
                $e = FindEl ($CT::Edit) $env:UIA_NAME
                if (-not $e) {
                    'no-element'
                } else {
                    try {
                        $p = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                        if ($env:UIA_ACTION -eq 'set-text') { $p.SetValue($env:UIA_VALUE); Start-Sleep -Milliseconds 300 }
                        'text=' + $p.Current.Value
                    } catch { 'no-pattern' }
                }
            } elseif ($env:UIA_ACTION -eq 'click-button') {
                $e = FindEl ($CT::Button) $env:UIA_NAME
                if (-not $e) {
                    'no-element'
                } else {
                    try {
                        $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                        'clicked'
                    } catch { 'no-pattern' }
                }
            }
        `, 60000, { WIN_HANDLE: String(handle), UIA_ACTION: action, UIA_NAME: name, UIA_VALUE: value }).split(/\r?\n/).pop();
    } catch (error) {
        return `error: ${firstLine(error)}`;
    }
}

/** Saves every element that UI Automation can see in the window, to know the real names. */
function dumpDialog(handle) {
    try {
        const out = runPowerShell(`
            Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
            $A = [System.Windows.Automation.AutomationElement]
            $T = [System.Windows.Automation.TreeScope]
            $win = $A::FromHandle([IntPtr][long]$env:WIN_HANDLE)
            foreach ($e in $win.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
                '{0}|{1}|enabled={2}|id={3}' -f $e.Current.ControlType.ProgrammaticName, $e.Current.Name, $e.Current.IsEnabled, $e.Current.AutomationId
            }
        `, 60000, { WIN_HANDLE: String(handle) });

        fs.writeFileSync(DIALOG_DUMP_FILE, out || '(nothing found: UI Automation sees no element in this window)', 'utf8');
        writeLog(`UI Automation list of the New window saved: ${DIALOG_DUMP_FILE}`);
    } catch (error) {
        writeLog(`Could not save the list of the New window: ${firstLine(error)}`);
    }
}

// ---------- steps ----------
/** Closes the start popups. Tries 3 times, because they can come a little later. */
async function closePopups() {
    const titles = CONFIG.creo.popupTitles.map(t => t.toLowerCase());
    const closed = [];

    for (let i = 0; i < 3; i++) {
        try {
            listCreoWindows().forEach(w => {
                if (titles.includes(w.title.toLowerCase())) {
                    closeWindow(w.handle);
                    closed.push(w.title);
                    writeLog(`Popup closed: "${w.title}"`);
                }
            });
        } catch (error) {
            writeLog(`Could not check the popups: ${firstLine(error)}`);
        }

        await sleep(2000);
    }

    summary.popups = closed.length ? closed.join(', ') : 'none was open';
}

/** Finds a word or words (for example "Process Plan") in the OCR list. side: 'left' or 'right' half of the window. */
function findPhrase(words, phrase, dialog, side) {
    const tokens = phrase.split(/\s+/).map(normalize).filter(Boolean);
    const middle = dialog.x + dialog.width / 2;
    const found = [];

    for (let i = 0; i + tokens.length <= words.length; i++) {
        if (tokens.every((t, k) => normalize(words[i + k].text) === t)) {
            const part = words.slice(i, i + tokens.length);
            const x = Math.round(part.reduce((sum, w) => sum + w.x, 0) / part.length);
            const y = Math.round(part.reduce((sum, w) => sum + w.y, 0) / part.length);

            if (side === 'left' ? x < middle : x >= middle) found.push({ x, y });
        }
    }

    return found[0] || null;
}

/**
 * Makes sure one option (a type or a sub-type) is selected in the New window.
 * 1st UI Automation (can check the state), 2nd OCR (clicks the word).
 */
function ensureOption(dialog, label, side, key) {
    // 1st: UI Automation
    let state = uia(dialog.handle, 'radio-state', label);
    writeLog(`"${label}" (UI Automation): ${state}`);

    if (state === 'selected') {
        summary[key] = 'was already selected';
        return;
    }

    if (state === 'not-selected') {
        writeLog(`"${label}" is NOT selected. Selecting it now...`);
        state = uia(dialog.handle, 'radio-select', label);
        writeLog(`"${label}" after the click: ${state}`);

        if (state === 'selected') {
            summary[key] = 'was NOT selected, the script selected it';
            return;
        }

        throw new Error(`Could not select "${label}".`);
    }

    // 2nd: OCR. UI Automation does not show the element, so click on the word.
    writeLog(`UI Automation cannot see "${label}". Using OCR.`);

    if (!fs.existsSync(DIALOG_DUMP_FILE)) dumpDialog(dialog.handle);

    const words = ocrWords(dialog);
    writeLog(`  words read: ${words.map(w => w.text).join(' ')}`);

    const hit = findPhrase(words, label, dialog, side);

    if (!hit) {
        throw new Error(`"${label}" was not found in the New window (${side} side). Check the name in CONFIG.newFile.`);
    }

    clickAt(hit.x, hit.y);
    summary[key] = 'clicked by OCR (cannot be checked, see the screenshot)';
}

/** Types the file name in the New window. */
function enterFileName(dialog) {
    const name = CONFIG.newFile.fileName;

    if (!name) {
        summary.fileName = 'not changed (Creo default name is kept)';
        return;
    }

    const labels = 'File name:|File name|Name';

    // 1st: UI Automation
    const set = uia(dialog.handle, 'set-text', labels, name);
    writeLog(`File name (UI Automation): ${set}`);

    if (set.startsWith('text=')) {
        if (set.slice(5) === name) {
            summary.fileName = `typed: ${name}`;
            return;
        }

        writeLog(`The field shows "${set.slice(5)}" instead of "${name}". Typing it with the keyboard.`);
    }

    // 2nd: click in the field, then paste
    const words = ocrWords(dialog);
    const label = words.find(w => normalize(w.text) === 'file');

    if (!label) {
        throw new Error('The words "File name" were not found in the New window.');
    }

    // the field is on the right side of the label
    clickAt(dialog.x + dialog.width * 0.6, label.y);
    pasteText(name);

    // check by OCR
    const after = ocrWords(dialog).map(w => w.text).join(' ');
    const ok = normalize(after).includes(normalize(name));
    writeLog(`File name typed with the keyboard. Seen on the screen: ${ok}`);
    summary.fileName = ok ? `typed: ${name}` : `typed: ${name} (OCR could not confirm it)`;
}

/** Clicks OK in the New window. */
function clickOk(dialog) {
    const ok = CONFIG.newFile.okButton;

    // 1st: UI Automation
    const result = uia(dialog.handle, 'click-button', ok);
    writeLog(`OK button (UI Automation): ${result}`);

    if (result === 'clicked') {
        summary.ok = 'clicked (UI Automation)';
        return;
    }

    // 2nd: OCR, the lowest "OK" in the window
    const hits = ocrWords(dialog).filter(w => isOkWord(w)).sort((a, b) => b.y - a.y);

    if (hits.length) {
        clickAt(hits[0].x, hits[0].y);
        summary.ok = 'clicked (OCR)';
        return;
    }

    // 3rd: Enter key
    writeLog('The OK button was not found. Pressing Enter.');
    focusWindow(dialog.handle);
    sendKeys('{ENTER}');
    summary.ok = 'Enter key';
}

/** The Creo window with this handle (position and size), or null. */
function getWindowByHandle(handle) {
    return listCreoWindows().find(w => w.handle === String(handle)) || null;
}

/** Click 1: a point on an empty part of the ribbon. Creo then takes the keyboard. */
function clickEmptyRibbon(main) {
    const f = CONFIG.newFile.focusClick;
    clickAt(main.x + main.width * f.x, main.y + main.height * f.y);
}

/** Click 2: the "Home" tab (OCR finds the word). It is already selected, so the click is safe. */
function clickHomeTab(main) {
    const area = { x: main.x, y: main.y, width: Math.min(700, main.width), height: 140 };
    const hit = ocrWords(area).find(w => normalize(w.text) === 'home');

    if (!hit) {
        writeLog('  the word "Home" was not found on the ribbon.');
        return false;
    }

    clickAt(hit.x, hit.y);
    return true;
}

/** Clicks the "Model" tab (OCR finds the word), so the ribbon is on a safe tab and not on Annotate. */
function clickModelTab(main) {
    const area = { x: main.x, y: main.y, width: Math.min(900, main.width), height: 140 };
    const hit = ocrWords(area).find(w => normalize(w.text) === 'model');

    if (!hit) {
        writeLog('  the word "Model" was not found on the ribbon.');
        return false;
    }

    clickAt(hit.x, hit.y);
    return true;
}

/** Click 3: the "New" button of the ribbon (OCR finds the word, the left one). */
function clickNewButton(main) {
    const area = { x: main.x, y: main.y, width: Math.min(500, main.width), height: 170 };
    const hits = ocrWords(area).filter(w => normalize(w.text) === 'new').sort((a, b) => a.x - b.x);

    if (!hits.length) {
        writeLog('  the word "New" was not found on the ribbon.');
        return false;
    }

    clickAt(hits[0].x, hits[0].y);
    return true;
}

/**
 * Opens the New window. 3 tries, one after the other:
 *   1. click on an empty part of the ribbon, then Ctrl+N
 *   2. click on the "Home" tab, then Ctrl+N
 *   3. click on the "New" button of the ribbon (no keys)
 */
async function openNewWindow(mainHandle) {
    const nf = CONFIG.newFile;

    for (let attempt = 1; attempt <= 3; attempt++) {
        focusWindow(mainHandle);
        await sleep(1000);

        const main = getWindowByHandle(mainHandle);

        if (!main) {
            writeLog('The main Creo window was not found.');
            return null;
        }

        if (attempt === 1) {
            action('TRY 1', 'click on the empty ribbon, then Ctrl+N');
            clickEmptyRibbon(main);
            await sleep(800);
            sendKeys(nf.shortcut);
        } else if (attempt === 2) {
            action('TRY 2', 'click on the Home tab, then Ctrl+N');
            clickHomeTab(main);
            await sleep(800);
            sendKeys(nf.shortcut);
        } else {
            action('TRY 3', 'click on the New button of the ribbon');
            clickNewButton(main);
        }

        const dialog = await waitForTitle(nf.dialogTitle, attempt < 3 ? 6000 : nf.waitForDialog);

        if (dialog) {
            writeLog(`The New window opened with try ${attempt}.`);
            return dialog;
        }

        writeLog(`The New window did not open with try ${attempt}.`);
    }

    return null;
}

/** Ctrl+N, check the type, type the name, OK. */
async function createNewFile(mainHandle) {
    const nf = CONFIG.newFile;

    nf.type = resolveType(nf.type);   // stops with a clear message if the type is wrong

    if (nf.autoName) {
        nf.fileName = nextFileName(nf.type);
        writeLog(`Automatic file name: ${nf.fileName}`);
    }

    writeLog(`---- Create a new file | type: ${nf.type} | sub-type: ${nf.subType || 'default'} ----`);
    const dialog = await openNewWindow(mainHandle);

    if (!dialog) {
        summary.newWindow = 'NOT shown';
        throw new Error(`The "${nf.dialogTitle}" window did not open (3 tries).`);
    }

    summary.newWindow = `shown (${dialog.width}x${dialog.height})`;
    writeLog(`New window found: handle=${dialog.handle} position=${dialog.x},${dialog.y} size=${dialog.width}x${dialog.height}`);

    focusWindow(dialog.handle);
    await sleep(1000);

    // the type first, then the sub-type (the sub-type list changes with the type)
    ensureOption(dialog, nf.type, 'left', 'type');
    await sleep(1000);

    if (nf.subType) {
        ensureOption(dialog, nf.subType, 'right', 'subType');
        await sleep(500);
    } else {
        summary.subType = 'not asked (default is kept)';
    }

    enterFileName(dialog);
    await sleep(500);

    // picture of the window before OK, as proof
    try {
        const shot = saveScreenshot(dialog, `creo-new-window-${Date.now()}.png`);
        writeLog(`Screenshot saved: ${shot}`);
    } catch (error) {
        writeLog(`Could not save the screenshot: ${firstLine(error)}`);
    }

    clickOk(dialog);

    // the New window must be gone
    if (!(await waitUntilTitleGone(nf.dialogTitle, 15000))) {
        summary.created = 'FAILED (the New window is still open)';
        throw new Error('The New window is still open after OK.');
    }

    await sleep(nf.afterOkWait);

    // is the new file name seen in a window title?
    const titles = listCreoWindows().map(w => w.title).filter(Boolean);
    writeLog(`Creo windows now: ${titles.join(' | ')}`);

    const seen = nf.fileName ? titles.some(t => normalize(t).includes(normalize(nf.fileName))) : false;

    summary.created = seen
        ? `yes (name "${nf.fileName}" is in a window title)`
        : 'the New window closed, but the name is not in a window title (check the screenshot)';

    // go back to the Model tab (a new file can leave the ribbon on another tab, for example Annotate)
    const mainWin = getWindowByHandle(mainHandle);
    if (mainWin) clickModelTab(mainWin);
}

/** Middle mouse click (in Creo this finishes the running tool or feature). */
function middleClickAt(x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    writeLog(`  middle click at x=${px} y=${py}`);

    runPowerShell(`
        Add-Type -TypeDefinition $env:CTL_CS
        [void][WinCtl]::SetCursorPos([int]$env:CLICK_X, [int]$env:CLICK_Y)
        Start-Sleep -Milliseconds 200
        [WinCtl]::mouse_event(0x0020, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        [WinCtl]::mouse_event(0x0040, 0, 0, 0, [UIntPtr]::Zero)
    `, 30000, { CTL_CS, CLICK_X: String(px), CLICK_Y: String(py) });
}

/** Finds a word with OCR inside an area. Returns { x, y, text } (the left one if there are several) or null. */
// C# helper: finds the green tick (an ICON, so OCR cannot read it) by its colour.
// It takes a picture of a screen area, finds the groups of green pixels and returns the right-most one that has the size of an icon.
const GREEN_CS = `
using System;
using System.Drawing;
using System.Collections.Generic;
public class GreenFind {
    public static string Find(int x, int y, int w, int h, int minCount, int minSize, int gMin, int margin) {
        Bitmap bmp = new Bitmap(w, h);
        Graphics g = Graphics.FromImage(bmp);
        g.CopyFromScreen(x, y, 0, 0, bmp.Size);
        g.Dispose();
        bool[] green = new bool[w * h];
        for (int j = 0; j < h; j++)
            for (int i = 0; i < w; i++) {
                Color c = bmp.GetPixel(i, j);
                green[j * w + i] = c.G > gMin && c.G > c.R + margin && c.G > c.B + margin;
            }
        bmp.Dispose();
        bool[] seen = new bool[w * h];
        string best = "none";
        double bestX = -1;
        Stack<int> st = new Stack<int>();
        for (int j = 0; j < h; j++)
            for (int i = 0; i < w; i++) {
                int idx = j * w + i;
                if (!green[idx] || seen[idx]) continue;
                int count = 0, minx = i, maxx = i, miny = j, maxy = j;
                seen[idx] = true;
                st.Push(idx);
                while (st.Count > 0) {
                    int cur = st.Pop();
                    int cx = cur % w, cy = cur / w;
                    count++;
                    if (cx < minx) minx = cx;
                    if (cx > maxx) maxx = cx;
                    if (cy < miny) miny = cy;
                    if (cy > maxy) maxy = cy;
                    for (int dy = -1; dy <= 1; dy++)
                        for (int dx = -1; dx <= 1; dx++) {
                            int nx = cx + dx, ny = cy + dy;
                            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                            int ni = ny * w + nx;
                            if (green[ni] && !seen[ni]) { seen[ni] = true; st.Push(ni); }
                        }
                }
                int bw = maxx - minx + 1, bh = maxy - miny + 1;
                double mid = (minx + maxx) / 2.0;
                if (count >= minCount && bw >= minSize && bw <= 60 && bh >= minSize && bh <= 60 && mid > bestX) {
                    bestX = mid;
                    best = (x + (int)mid) + "|" + (y + (miny + maxy) / 2) + "|" + count + "|" + bw + "|" + bh;
                }
            }
        return best;
    }
}`;

/** Finds the green tick icon in a screen area. Returns { x, y, count, w, h } (screen centre) or null. */
function findGreenTick(area, opts = {}) {
    const o = { minCount: 40, minSize: 8, gMin: 110, margin: 40, ...opts };   // strict by default; pass looser values for small / dark icons

    try {
        const out = runPowerShell(`
            Add-Type -TypeDefinition $env:GREEN_CS -ReferencedAssemblies System.Drawing
            [GreenFind]::Find([int]$env:AREA_X, [int]$env:AREA_Y, [int]$env:AREA_W, [int]$env:AREA_H, [int]$env:G_COUNT, [int]$env:G_SIZE, [int]$env:G_MIN, [int]$env:G_MARGIN)
        `, 60000, {
            GREEN_CS,
            AREA_X: String(Math.round(area.x)), AREA_Y: String(Math.round(area.y)),
            AREA_W: String(Math.round(area.width)), AREA_H: String(Math.round(area.height)),
            G_COUNT: String(o.minCount), G_SIZE: String(o.minSize), G_MIN: String(o.gMin), G_MARGIN: String(o.margin)
        });

        const last = out.split(/\r?\n/).pop().trim();
        if (!last || last === 'none') return null;

        const [x, y, count, w, h] = last.split('|').map(Number);
        return { x, y, count, w, h };
    } catch (error) {
        writeLog(`Could not search the green tick: ${firstLine(error)}`);
        return null;
    }
}

function isOkWord(w) {
    return ['ok', '0k'].includes(normalize(w.text));
}

function findWord(area, word) {
    const hits = ocrWords(area).filter(w => normalize(w.text) === normalize(word)).sort((a, b) => a.x - b.x);
    return hits[0] || null;
}

/** Is the Extrude tool open? (the contextual tab "Extrude" is shown in the tab bar at the top) */
function extrudeTabActive(main) {
    return !!findWord({ x: main.x, y: main.y, width: main.width, height: 60 }, 'Extrude');
}

/**
 * Clicks the green "OK" of the ribbon (Close group).
 * 1st: OCR reads the word OK (also "0K"). 2nd: a fixed point, if one is given. Returns 'OCR', 'fixed point' or null.
 */
function clickGreenOk(main, fixed) {
    // 1st: the green tick icon, found by its colour (below the tab bar, so the green "File" tab is not seen)
    const tick = findGreenTick({ x: main.x, y: main.y + 52, width: main.width, height: CONFIG.design.ribbonHeight - 52 });

    if (tick) {
        writeLog(`  green tick found at x=${tick.x} y=${tick.y} (size ${tick.w}x${tick.h}, ${tick.count} pixels)`);
        clickAt(tick.x, tick.y);
        return 'green icon';
    }

    writeLog('  no green tick found by colour. Trying OCR.');
    const area = { x: main.x, y: main.y, width: main.width, height: CONFIG.design.ribbonHeight };
    const hits = ocrWords(area).filter(isOkWord).sort((a, b) => b.x - a.x);

    if (hits.length) {
        clickAt(hits[0].x, hits[0].y);
        return 'OCR';
    }

    if (fixed) {
        writeLog('  the word OK was not found. Clicking the fixed OK point.');
        clickAt(main.x + main.width * fixed.x, main.y + main.height * fixed.y);
        return 'fixed point';
    }

    return null;
}

/** Builds a box with the clicks of a person: Extrude, plane, Rectangle, 2 corners, OK, finish. */
async function designByClicks(mainHandle) {
    const d = CONFIG.design;

    focusWindow(mainHandle);
    await sleep(1000);

    let main = getWindowByHandle(mainHandle);
    if (!main) throw new Error('The main Creo window was not found for the design.');

    const ribbon = () => ({ x: main.x, y: main.y, width: main.width, height: d.ribbonHeight });
    const tree = () => ({
        x: main.x, y: main.y + d.ribbonHeight,
        width: Math.round(main.width * 0.25), height: main.height - d.ribbonHeight
    });
    const gx = main.x + main.width * d.graphicsCenter.x;
    const gy = main.y + main.height * d.graphicsCenter.y;
    const half = main.width * d.boxSize;

    const fail = (step, hint) => {
        try { writeLog(`Screenshot saved: ${saveScreenshot(main, `creo-design-fail-${Date.now()}.png`)}`); } catch { /* ignore */ }
        summary.design = `FAILED at: ${step}`;
        throw new Error(`Design failed at "${step}". ${hint}`);
    };

    // 0. Model tab, so the Extrude button is on the ribbon
    clickModelTab(main);
    await sleep(d.stepWait);

    // 1. Extrude
    action('DESIGN', '1/7 click Extrude');
    const extrude = findWord(ribbon(), 'Extrude');
    if (!extrude) fail('Extrude', 'The word "Extrude" was not found on the Model tab ribbon.');
    clickAt(extrude.x, extrude.y);
    await sleep(d.stepWait);

    // 2. the sketch plane (name in the model tree)
    action('DESIGN', `2/7 pick the plane ${d.plane}`);
    const plane = findWord(tree(), d.plane);
    if (!plane) fail('plane', `The word "${d.plane}" was not found in the model tree (left side). Change CONFIG.design.plane.`);
    clickAt(plane.x, plane.y);
    await sleep(d.stepWait + 1500);   // Creo goes to Sketch mode

    // 3. Rectangle tool (Sketch tab)
    action('DESIGN', '3/7 click Rectangle');
    const rect = findWord(ribbon(), 'Rectangle');
    if (!rect) fail('Rectangle', 'The word "Rectangle" was not found on the Sketch tab. Check the screenshot: is Creo in Sketch mode?');
    clickAt(rect.x, rect.y);
    await sleep(1000);

    // 4. two corners, then a middle click to leave the Rectangle tool
    action('DESIGN', '4/7 draw the rectangle');
    clickAt(gx - half, gy - half);
    await sleep(800);
    clickAt(gx + half, gy + half);
    await sleep(800);
    middleClickAt(gx, gy);
    await sleep(1000);

    // 5. green OK of the sketch
    action('DESIGN', '5/7 click the green OK (finish the sketch)');
    main = getWindowByHandle(mainHandle) || main;
    let how = clickGreenOk(main, d.sketchOkPoint);
    writeLog(`  sketch OK clicked by: ${how}`);
    await sleep(d.stepWait + 1500);

    // 6. Extrude tool. Creo may already show it (the sketch was started from Extrude). If not, select the sketch and click Extrude.
    main = getWindowByHandle(mainHandle) || main;

    if (extrudeTabActive(main)) {
        action('DESIGN', '6/7 the Extrude tool is already open');
    } else {
        action('DESIGN', '6/7 select Sketch 1 and click Extrude');
        clickModelTab(main);
        await sleep(d.stepWait);

        const sketch = findWord(tree(), 'Sketch');
        if (sketch) clickAt(sketch.x, sketch.y);
        await sleep(1000);

        const extrude2 = findWord(ribbon(), 'Extrude');
        if (!extrude2) fail('Extrude (after the sketch)', 'The sketch OK did not work or the word "Extrude" is not on the Model tab. See the screenshot.');
        clickAt(extrude2.x, extrude2.y);
        await sleep(d.stepWait + 1500);
    }

    main = getWindowByHandle(mainHandle) || main;
    if (!extrudeTabActive(main)) fail('Extrude tool', 'The Extrude tool is not open. See the screenshot.');

    // 7. green OK of the extrude. 1st OCR, 2nd middle click (also accepts the feature in Creo)
    action('DESIGN', '7/7 click the green OK (finish the extrude)');
    how = clickGreenOk(main, null);
    writeLog(`  extrude OK clicked by: ${how}`);
    await sleep(d.stepWait + 1500);

    main = getWindowByHandle(mainHandle) || main;

    if (extrudeTabActive(main)) {
        writeLog('  the Extrude tool is still open. Trying the middle click.');
        middleClickAt(gx, gy + half * 3);
        await sleep(d.stepWait + 1500);
        main = getWindowByHandle(mainHandle) || main;
    }

    if (extrudeTabActive(main)) fail('extrude OK', 'The Extrude tool is still open after OK. See the screenshot.');

    // check: the model tree must show the Extrude feature
    const made = findWord(tree(), 'Extrude');
    try { writeLog(`Screenshot saved: ${saveScreenshot(main, `creo-design-${Date.now()}.png`)}`); } catch { /* ignore */ }

    if (!made) {
        summary.design = 'steps done, but "Extrude" is NOT in the model tree (check the screenshot)';
        throw new Error('The design was not created: no Extrude feature in the model tree. See the creo-design screenshot.');
    }

    summary.design = 'yes (Extrude feature is in the model tree)';
}

/** Is this contextual tab (for example "Sketch") shown in the tab bar at the top? */
function tabActive(main, name) {
    return !!findWord({ x: main.x, y: main.y, width: main.width, height: 60 }, name);
}

/**
 * 2D design only: Sketch tool -> plane -> Rectangle -> 2 corners -> green OK.
 * The sketch stays in the model tree as "Sketch 1" and Creo is back in normal mode, so Ctrl+S works.
 */
async function designBySketch(mainHandle) {
    const d = CONFIG.design;

    focusWindow(mainHandle);
    await sleep(1000);

    let main = getWindowByHandle(mainHandle);
    if (!main) throw new Error('The main Creo window was not found for the design.');

    const refresh = () => { main = getWindowByHandle(mainHandle) || main; return main; };
    const ribbon = () => ({ x: main.x, y: main.y, width: main.width, height: d.ribbonHeight });
    const tree = () => ({
        x: main.x, y: main.y + d.ribbonHeight,
        width: Math.round(main.width * 0.25), height: main.height - d.ribbonHeight
    });
    const gx = main.x + main.width * d.graphicsCenter.x;
    const gy = main.y + main.height * d.graphicsCenter.y;
    const half = main.width * d.boxSize;

    const fail = (step, hint) => {
        try { writeLog(`Screenshot saved: ${saveScreenshot(refresh(), `creo-design-fail-${Date.now()}.png`)}`); } catch { /* ignore */ }
        summary.design = `FAILED at: ${step}`;
        throw new Error(`Design failed at "${step}". ${hint}`);
    };

    // Creo is in Sketch mode when the "Sketch" tab is shown OR the green tick is on the right side of the ribbon
    const inSketch = () => {
        if (tabActive(main, 'Sketch')) return true;
        return !!findGreenTick({ x: main.x + main.width * 0.5, y: main.y + 52, width: main.width * 0.5, height: d.ribbonHeight - 52 });
    };

    // 0. Model tab, so the Sketch button is on the ribbon
    clickModelTab(main);
    await sleep(d.stepWait);

    // 1. Sketch tool
    action('DESIGN', '1/5 click Sketch');
    const sketchBtn = findWord(ribbon(), 'Sketch');
    if (!sketchBtn) fail('Sketch tool', 'The word "Sketch" was not found on the Model tab ribbon.');
    clickAt(sketchBtn.x, sketchBtn.y);
    await sleep(d.stepWait);

    // 2. the sketch plane. Creo may need one more accept (middle click) to open Sketch mode.
    action('DESIGN', `2/5 pick the plane ${d.plane}`);
    const plane = findWord(tree(), d.plane);
    if (!plane) fail('plane', `The word "${d.plane}" was not found in the model tree (left side). Change CONFIG.design.plane.`);
    clickAt(plane.x, plane.y);
    await sleep(d.stepWait + 1500);

    refresh();
    if (!inSketch()) {
        writeLog('  Sketch mode is not open yet. Accepting the Sketch window with a middle click.');
        middleClickAt(gx, gy);
        await sleep(d.stepWait + 1500);
        refresh();
    }

    if (!inSketch()) fail('Sketch mode', 'The Sketch tab did not open. See the screenshot.');

    // 3. Rectangle tool
    action('DESIGN', '3/5 click Rectangle');
    const rect = findWord(ribbon(), 'Rectangle');
    if (!rect) fail('Rectangle', 'The word "Rectangle" was not found on the Sketch tab.');
    clickAt(rect.x, rect.y);
    await sleep(1000);

    // 4. two corners, then a middle click to leave the Rectangle tool
    action('DESIGN', '4/5 draw the rectangle');
    clickAt(gx - half, gy - half);
    await sleep(800);
    clickAt(gx + half, gy + half);
    await sleep(800);
    middleClickAt(gx, gy);
    await sleep(1000);

    // 5. the green tick. Up to 3 tries. A picture of the ribbon is saved first, as proof of what the script sees.
    action('DESIGN', '5/5 click the green tick (finish the sketch)');
    refresh();
    try { writeLog(`Screenshot saved: ${saveScreenshot(ribbon(), `creo-ribbon-before-ok-${Date.now()}.png`)}`); } catch { /* ignore */ }

    let done = false;

    for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        refresh();
        // the 3rd try may also use the fixed point from CONFIG.design.sketchOkPoint
        const how = clickGreenOk(main, attempt === 3 ? d.sketchOkPoint : null);
        writeLog(`  green tick, try ${attempt}: ${how}`);
        await sleep(d.stepWait);
        refresh();
        done = how !== null && !inSketch();
    }

    if (!done) fail('finish the sketch', 'Creo is still in Sketch mode after the green tick. See the creo-ribbon-before-ok and creo-design-fail screenshots.');

    // check: the sketch is in the model tree
    const made = findWord(tree(), 'Sketch');
    try { writeLog(`Screenshot saved: ${saveScreenshot(main, `creo-design-${Date.now()}.png`)}`); } catch { /* ignore */ }

    summary.design = made
        ? 'yes (2D sketch is in the model tree)'
        : '2D sketch finished, but "Sketch" is not seen in the model tree (check the screenshot)';
}

/** Creates the design: a mapkey if "keys" is set, otherwise the automatic click design, otherwise nothing. */
async function createDesign(mainHandle) {
    const d = CONFIG.design;

    if (d.keys) {
        writeLog(`---- Create the design with the mapkey | keys: ${d.keys} ----`);

        if (!d.mapkeyLines || !d.mapkeyLines.length) {
            writeLog('WARNING: CONFIG.design.mapkeyLines is empty. The keys only work if the mapkey is already in your own config.pro.');
        }

        focusWindow(mainHandle);
        await sleep(1000);

        const main = getWindowByHandle(mainHandle);
        if (main) {
            clickModelTab(main);
            await sleep(500);
            clickAt(main.x + main.width * 0.5, main.y + main.height * 0.6);
            await sleep(800);
        }

        sendKeys(d.keys);
        await sleep(d.wait);
        summary.design = `keys sent: ${d.keys}`;
        return;
    }

    if (d.auto) {
        if (d.extrude) {
            writeLog('---- Create the design with clicks (Extrude box) ----');
            await designByClicks(mainHandle);
        } else {
            writeLog('---- Create the design with clicks (2D sketch only) ----');
            await designBySketch(mainHandle);
        }
        return;
    }

    summary.design = 'skipped (keys empty and auto is false, the empty file is saved)';
    writeLog('---- Design: skipped ----');
}

/** Finds the label in the OCR words. OCR can read "QC_Confidential" as one word or as "QC" "Confidential". */
function findLabelWord(words, name) {
    const whole = normalize(name);
    const one = words.find(w => looksLike(w.text, name));
    
    if (one) return one;

    const tokens = name.split(/[^a-zA-Z0-9]+/).map(normalize).filter(Boolean);
    for (let i = 0; i + tokens.length <= words.length; i++) {
        if (tokens.every((t, k) => normalize(words[i + k].text) === t)) {
            const part = words.slice(i, i + tokens.length);
            return {
                x: Math.round(part.reduce((s, w) => s + w.x, 0) / part.length),
                y: Math.round(part.reduce((s, w) => s + w.y, 0) / part.length),
                text: name
            };
        }
    }
    return null;
}

/** Applies the sensitivity label: pencil -> label in the list -> green button -> check. */
async function applyLabel(mainHandle) {
    const lb = CONFIG.label;

    if (!lb.enabled) {
        summary.label = 'skipped (disabled in CONFIG)';
        return;
    }

    writeLog(`---- Apply the label | name: ${lb.name} | index: ${lb.index} ----`);

    focusWindow(mainHandle);
    await sleep(1000);

    let main = getWindowByHandle(mainHandle);
    if (!main) throw new Error('The main Creo window was not found for the label.');

    const fail = (step, hint) => {
        try { writeLog(`Screenshot saved: ${saveScreenshot(main, `creo-label-fail-${Date.now()}.png`)}`); } catch { /* ignore */ }
        summary.label = `FAILED at: ${step}`;
        throw new Error(`Label failed at "${step}". ${hint}`);
    };

    // 1. find the word "Sensitivity" (the floating HaloCAD bar in the drawing area)
    action('LABEL', '1/5 find the Sensitivity bar');
    const bar = { x: main.x + main.width * 0.4, y: main.y + 100, width: main.width * 0.6, height: 160 };
    const sens = findWord(bar, 'Sensitivity');
    if (!sens) fail('Sensitivity bar', 'The word "Sensitivity" was not found. Is the HaloCAD bar visible in the drawing area?');

    // 2. click the pencil (the bar changes to edit mode: the dropdown shows "--No Protection--", the pencil becomes cancel)
    action('LABEL', '2/5 click the pencil');
    clickAt(sens.x + lb.pencilDx, sens.y);
    await sleep(lb.waitAfterClick);

    // after the pencil click the bar changes (the green and red icons come) and the dropdown moves to the left,
    // so find the word "Sensitivity" AGAIN and take all positions from the new place
    const sensNow = findWord(bar, 'Sensitivity') || sens;
    writeLog(`  the word "Sensitivity" moved from x=${sens.x} to x=${sensNow.x}`);

    // the area right of the dropdown: the green and the red icon are shown here after the pencil click
    const iconsLeft = Math.max(main.x, sensNow.x + lb.comboArrowDx - 40);
    const icons = { x: iconsLeft, y: sensNow.y - 25, width: Math.min(200, main.x + main.width - iconsLeft), height: 50 };
    try { writeLog(`Screenshot saved: ${saveScreenshot({ x: sensNow.x - 150, y: sensNow.y - 25, width: Math.min(500, main.x + main.width - (sensNow.x - 150)), height: 50 }, `creo-label-edit-${Date.now()}.png`)}`); } catch { /* ignore */ }

    const left = sensNow.x + lb.area.dx;
    const top = sensNow.y + lb.area.dy;
    const area = {
        x: left,
        y: top,
        width: Math.min(lb.area.width, main.x + main.width - left),
        height: Math.min(lb.area.height, main.y + main.height - top)
    };

    // 3. open the dropdown (click its arrow) and read the list
    action('LABEL', '3/5 click the dropdown to open the label list');
    clickAt(sensNow.x + lb.comboClickDx, sensNow.y);   // middle of the dropdown, far away from the green and red icons
    await sleep(1500);

    try { writeLog(`Screenshot saved: ${saveScreenshot(area, `creo-label-list-${Date.now()}.png`)}`); } catch { /* ignore */ }
    writeLog(`  Creo windows now: ${listCreoWindows().map(w => `"${w.title}" ${w.width}x${w.height}`).join(' | ')}`);

    const words = ocrWords(area);
    writeLog(`  words read: ${words.map(w => w.text).join(' ')}`);

    // 4. pick the label: by name first (click), then by index (keyboard: Home, Down x index, Enter)
    action('LABEL', `4/5 pick the label ${lb.name}`);
    const hit = findLabelWord(words, lb.name);

    if (hit) {
        writeLog(`  label found by name at x=${hit.x} y=${hit.y}`);
        clickAt(hit.x, hit.y);
    } else {
        writeLog(`  label name not found by OCR. Using the keyboard: Home, Down x ${lb.index}, Enter`);
        sendKeys('{HOME}');
        await sleep(400);
        sendKeys(`{DOWN ${lb.index}}`);
        await sleep(400);
        sendKeys('{ENTER}');
    }

    await sleep(1500);

    const barNow = { x: main.x + main.width * 0.4, y: main.y + 100, width: main.width * 0.6, height: 160 };
    try { writeLog(`Screenshot saved: ${saveScreenshot(area, `creo-label-picked-${Date.now()}.png`)}`); } catch { /* ignore */ }
    writeLog(`  bar after picking: ${ocrWords(barNow).map(w => w.text).join(' ')}`);

    // 5. green button (apply). Searched around the bar, below the tab bar.
    action('LABEL', '5/5 click the green button (apply)');
    const greenArea = {
        x: Math.max(main.x, sensNow.x - 300),
        y: sensNow.y - 30,
        width: Math.min(800, main.x + main.width - Math.max(main.x, sensNow.x - 300)),
        height: 500
    };
    // search: next to the dropdown first (strict colours, then softer colours), then in the wider area
    const LOOSE = { minCount: 12, minSize: 5, gMin: 90, margin: 25 };
    const tick = findGreenTick(icons) || findGreenTick(icons, LOOSE) || findGreenTick(greenArea) || findGreenTick(greenArea, LOOSE);
    if (!tick) fail('green button', 'The green apply button was not found. See the creo-label-edit, creo-label-list and creo-label-picked screenshots.');

    writeLog(`  green button found at x=${tick.x} y=${tick.y} (size ${tick.w}x${tick.h})`);
    clickAt(tick.x, tick.y);
    await sleep(lb.waitAfterClick + 1500);

    // after apply, the bar goes back to the pencil only, so the green icon must be gone
    const stillGreen = findGreenTick(icons) || findGreenTick(icons, LOOSE);
    if (stillGreen) fail('apply', 'The green icon is still shown after the click, so the label was not applied. See the screenshot.');

    // check: the Sensitivity bar must show the label, not "Not set"
    main = getWindowByHandle(mainHandle) || main;
    const after = ocrWords({ x: main.x + main.width * 0.4, y: main.y + 100, width: main.width * 0.6, height: 160 })
        .map(w => w.text).join(' ');
    writeLog(`  Sensitivity bar after apply: ${after}`);
    try { writeLog(`Screenshot saved: ${saveScreenshot(main, `creo-label-done-${Date.now()}.png`)}`); } catch { /* ignore */ }

    const text = normalize(after);

    if (looksLike(after, lb.name)) {
        summary.label = `yes (${lb.name} is shown in the Sensitivity bar)`;
    } else if (looksLike(after, 'Not set')) {
        fail('check', 'The Sensitivity bar still shows "Not set". See the creo-label-done screenshot.');
    } else {
        summary.label = 'clicked, but the label name could not be confirmed by OCR (check the creo-label-done screenshot)';
    }
}

/** Ctrl+S and wait for the Save window. 2 tries. Before every try: Model tab, then a click on the drawing area. */
async function openSaveWindow(mainHandle) {
    const sv = CONFIG.save;

    for (let attempt = 1; attempt <= 2; attempt++) {
        focusWindow(mainHandle);
        await sleep(1000);

        const main = getWindowByHandle(mainHandle);

        if (main) {
            clickModelTab(main);
            await sleep(500);
            action(`TRY ${attempt}`, 'click on the drawing area, then Ctrl+S');
            clickAt(main.x + main.width * 0.5, main.y + main.height * 0.6);
            await sleep(800);
        }

        sendKeys(sv.shortcut);

        const dialog = await waitForTitle(sv.dialogTitle, attempt === 1 ? 8000 : sv.waitForDialog);

        if (dialog) {
            writeLog(`The Save window opened with try ${attempt}.`);
            return dialog;
        }

        writeLog(`The Save window did not open with try ${attempt}.`);
    }

    return null;
}

/** Clicks OK in the Save window: UI Automation, then OCR, then a fixed point, then Enter. */
function clickSaveOk(dialog) {
    const sv = CONFIG.save;

    const result = uia(dialog.handle, 'click-button', 'OK');
    writeLog(`OK button (UI Automation): ${result}`);

    if (result === 'clicked') return 'UI Automation';

    const lowHalf = dialog.y + dialog.height * 0.7;
    const hits = ocrWords(dialog).filter(w => isOkWord(w) && w.y > lowHalf).sort((a, b) => a.x - b.x);

    if (hits.length) {
        clickAt(hits[0].x, hits[0].y);
        return 'OCR';
    }

    writeLog('The word OK was not found. Clicking the fixed OK point.');
    clickAt(dialog.x + dialog.width * sv.okButton.x, dialog.y + dialog.height * sv.okButton.y);
    return 'fixed point';
}

/** Ctrl+S, check the folder in the Save window, OK, then check that the file is really in the folder. */
async function saveFile(mainHandle) {
    const sv = CONFIG.save;
    const nf = CONFIG.newFile;
    const ext = EXTENSIONS[nf.type];
    const startTime = Date.now();

    fs.mkdirSync(sv.folder, { recursive: true });
    writeLog(`---- Save the file | folder: ${sv.folder} ----`);

    const dialog = await openSaveWindow(mainHandle);

    if (!dialog) {
        summary.saveWindow = 'NOT shown';
        throw new Error(`The "${sv.dialogTitle}" window did not open after Ctrl+S.`);
    }

    summary.saveWindow = `shown (${dialog.width}x${dialog.height})`;
    focusWindow(dialog.handle);
    await sleep(1000);

    // what will be saved? A sketch (.SEC) is not the file we want.
    const text = ocrWords(dialog).map(w => w.text).join(' ');
    writeLog(`  words read in the Save window: ${text}`);

    if (/\.sec\b/i.test(text)) {
        sendKeys('{ESC}');
        summary.saveWindow = 'wrong: the window saves a sketch (.SEC)';
        throw new Error('The Save window is for a sketch (.SEC). Creo is still in Sketch mode. Finish the sketch first, then save.');
    }

    // is the right folder already shown? (Creo started with working_directory = save folder)
    const folderName = path.basename(sv.folder);
    let folderShown = normalize(text).includes(normalize(folderName));
    writeLog(`  the folder name "${folderName}" is shown in the Save window: ${folderShown}`);

    if (folderShown) {
        summary.saveFolder = 'Save window already in the right folder (working_directory)';
    } else if (sv.useAddressBarFallback) {
        // fallback: click the path line on the top, write the path, Enter
        action('PATH', sv.folder);
        clickAt(dialog.x + dialog.width * sv.addressBar.x, dialog.y + dialog.height * sv.addressBar.y);
        await sleep(600);
        pasteText(sv.folder);
        await sleep(400);
        sendKeys('{ENTER}');
        await sleep(2000);

        const after = ocrWords(dialog).map(w => w.text).join(' ');
        folderShown = normalize(after).includes(normalize(folderName));
        writeLog(`  after typing the path, the folder name is shown: ${folderShown}`);
        summary.saveFolder = folderShown
            ? 'set with the path line'
            : 'could not be confirmed (check the screenshot)';
    } else {
        summary.saveFolder = 'not confirmed (address bar fallback is off)';
    }

    try {
        writeLog(`Screenshot saved: ${saveScreenshot(dialog, `creo-save-window-${Date.now()}.png`)}`);
    } catch (error) {
        writeLog(`Could not save the screenshot: ${firstLine(error)}`);
    }

    const how = clickSaveOk(dialog);
    writeLog(`OK in the Save window: ${how}`);

    if (!(await waitUntilTitleGone(sv.dialogTitle, 20000))) {
        throw new Error('The Save window is still open after OK.');
    }

    // the real check: is the file in the folder?
    const prefix = nf.fileName ? `${nf.fileName.toLowerCase()}.${ext}` : '';
    const end = Date.now() + sv.checkDiskWait;
    let found = null;

    while (Date.now() < end && !found) {
        try {
            found = fs.readdirSync(sv.folder).find(f => {
                const lower = f.toLowerCase();
                if (prefix) return lower.startsWith(prefix);
                return lower.includes(`.${ext}`) && fs.statSync(path.join(sv.folder, f)).mtimeMs >= startTime - 2000;
            });
        } catch {
            // try again
        }

        if (!found) await sleep(1000);
    }

    if (!found) {
        summary.saved = `NOT found in ${sv.folder}`;

        // help to see where it went (the Documents folder is where Creo goes without a working directory)
        const docs = path.join(os.homedir(), 'Documents');
        try {
            const elsewhere = fs.readdirSync(docs).find(f => {
                const lower = f.toLowerCase();
                return prefix ? lower.startsWith(prefix) : lower.includes(`.${ext}`);
            });
            if (elsewhere) writeLog(`The file was found in the WRONG folder: ${path.join(docs, elsewhere)}`);
        } catch { /* ignore */ }

        throw new Error(`The file "${prefix || '*.' + ext}" is not in ${sv.folder}.`);
    }

    state.savedName = found;
    summary.saved = `yes: ${path.join(sv.folder, found)}`;
    writeLog(`File found on the disk: ${path.join(sv.folder, found)}`);
}

/** Closes the file (Ctrl+W) and waits until its name is gone from the Creo window titles. Returns true / false. */
async function closeFile(handle, model) {
    action('CLOSE', `close the file ${model} (Ctrl+W)`);

    focusWindow(handle);
    await sleep(1000);

    const main = getWindowByHandle(handle);

    if (main) {
        clickModelTab(main);
        await sleep(500);
        clickAt(main.x + main.width * 0.5, main.y + main.height * 0.6);
        await sleep(800);
    }

    sendKeys(CONFIG.verify.closeShortcut);

    const end = Date.now() + 15000;

    while (Date.now() < end) {
        try {
            if (!listCreoWindows().some(w => normalize(w.title).includes(normalize(model)))) {
                writeLog('  the file is closed.');
                return true;
            }
        } catch { /* try again */ }

        await sleep(1000);
    }

    writeLog('  WARNING: the file name is still in a Creo window title (the file may not be closed).');
    return false;
}

/** Opens a file with Ctrl+O and the full path. 3 tries. Returns true when the file name is in a window title. */
async function openFileByPath(handle, fullPath, model) {
    const vf = CONFIG.verify;
    let dialog = null;

    for (let attempt = 1; attempt <= 3 && !dialog; attempt++) {
        focusWindow(handle);
        await sleep(1000);

        const main = getWindowByHandle(handle);
        if (!main) throw new Error('The main Creo window was not found (open file).');

        action(`TRY ${attempt}`, 'click on the empty ribbon, then Ctrl+O');
        clickEmptyRibbon(main);
        await sleep(800);
        sendKeys(vf.openShortcut);
        dialog = await waitForTitle(vf.openDialogTitle, 8000);
    }

    if (!dialog) throw new Error(`The "${vf.openDialogTitle}" window did not open.`);

    await sleep(1000);
    writeLog(`  opening: ${fullPath}`);
    pasteText(fullPath);
    await sleep(500);
    sendKeys('{ENTER}');

    const end = Date.now() + vf.waitForOpen;

    while (Date.now() < end) {
        try {
            if (listCreoWindows().some(w => normalize(w.title).includes(normalize(model)))) return true;
        } catch { /* try again */ }

        await sleep(1500);
    }

    return false;
}

/**
 * Reads the text that the Sensitivity dropdown shows. Returns { text } or null if the Sensitivity bar is not found.
 * 1st: the small window of the HaloCAD bar itself (no title, about 400x44), so its position does not matter.
 * 2nd: the upper half of the Creo window.
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
            writeLog(`  OCR failed (${area.why}): ${firstLine(error)}`);
            continue;
        }

        writeLog(`  OCR (${area.why}): ${words.map(w => w.text).join(' ')}`);

        const sens = words.find(w => normalize(w.text).includes('sensitiv'));
        if (!sens) continue;

        // the words on the same row, to the right of "Sensitivity" (the dropdown)
        const text = words
            .filter(w => w !== sens && w.x > sens.x + 5 && w.x < sens.x + 300 && Math.abs(w.y - sens.y) < 20)
            .sort((a, b) => a.x - b.x)
            .map(w => w.text)
            .join(' ');

        try { writeLog(`Screenshot saved: ${saveScreenshot(area, `creo-label-verify-${Date.now()}.png`)}`); } catch { /* ignore */ }

        return { text };
    }

    return null;
}

/** After the save: close the file, open it again, read the label, write the FILE SECURITY result. */
async function verifyProtection(handle) {
    const vf = CONFIG.verify;
    const lb = CONFIG.label;

    if (!vf.enabled) {
        summary.security = 'skipped (disabled in CONFIG)';
        return;
    }

    if (!state.savedName) throw new Error('The name of the saved file is not known, so the label cannot be checked.');

    const savedFile = state.savedName.replace(/\.\d+$/, '');         // part_0023.prt.1 -> part_0023.prt (the Open window wants this)
    const model = savedFile.replace(/\.[^.]+$/, '');                  // part_0023
    const fullPath = path.join(CONFIG.save.folder, savedFile);

    writeLog(`---- Check the label in the saved file | ${savedFile} ----`);

    // 1. close the file
    await closeFile(handle, model);

    // 2. make sure the file is read from the disk: restart Creo
    let h = handle;

    if (vf.restartCreo) {
        action('VERIFY', 'restart Creo, so the file is read from the disk');
        killCreo();

        const endKill = Date.now() + 15000;
        while (Date.now() < endKill && creoRunning()) await sleep(1000);
        await sleep(3000);

        spawn(CONFIG.creo.exePath, [], { cwd: CONFIG.save.folder, detached: true, stdio: 'ignore' }).unref();
        h = await waitForCreoHandle(CONFIG.creo.waitForWindow);
        await sleep(CONFIG.creo.loadWait);

        const keepPopups = summary.popups;
        await closePopups();
        summary.popups = keepPopups;
    }

    // 3. open the same file again
    action('VERIFY', 'open the same file again');
    const opened = await openFileByPath(h, fullPath, model);

    if (!opened) {
        summary.security = 'UNKNOWN (the file did not open again)';
        throw new Error(`"${savedFile}" did not open again (its name is not in a Creo window title).`);
    }

    // 4. read the Sensitivity label (wait until the bar is visible, then wait a little, then read again)
    action('VERIFY', 'read the Sensitivity label');
    await sleep(3000);

    let read = null;
    const end = Date.now() + vf.waitForBar;

    while (Date.now() < end && !read) {
        read = readSensitivity(h);
        if (!read) await sleep(2000);
    }

    if (read) {
        await sleep(3000);
        read = readSensitivity(h) || read;
    }

    if (!read) {
        const m = getWindowByHandle(h);
        if (m) { try { writeLog(`Screenshot saved: ${saveScreenshot(m, `creo-verify-fail-${Date.now()}.png`)}`); } catch { /* ignore */ } }
        summary.security = 'UNKNOWN (the Sensitivity bar was not found)';
        throw new Error('The Sensitivity bar was not found after opening the file.');
    }

    // 5. decide
    let status;

if (looksLike(read.text, lb.name)) status = 'PROTECTED';
else if (looksLike(read.text, 'Not set') || looksLike(read.text, 'No Protection')) status = 'UNPROTECTED';
else status = 'UNKNOWN';

    const shown = status === 'PROTECTED' ? lb.name : (read.text || '(nothing read)');

    writeLog('----------------------------------------------------');
    writeLog(`File name        : ${savedFile}`);
    writeLog(`Configured label : ${lb.name}`);
    writeLog(`Label in file    : ${shown}`);
    writeLog(`FILE SECURITY    : ${status}`);
    writeLog('----------------------------------------------------');

    summary.security = status === 'PROTECTED'
        ? `PROTECTED (${lb.name})`
        : `${status} (Sensitivity shows: ${read.text || 'nothing'})`;

    // 6. close the file (Creo itself is closed at the end of the run)
    await closeFile(h, model);

    if (status !== 'PROTECTED') {
        throw new Error(`FILE SECURITY: ${status}. Expected the label ${lb.name}, the Sensitivity bar shows: ${read.text || 'nothing'}`);
    }
}

// ---------- main ----------
async function run() {
    let driver;
    let result = 'FAILED';

    writeLog('==================== RUN START (Creo) ====================');

    try {
        // 1. check the exe
        if (!fs.existsSync(CONFIG.creo.exePath)) {
            throw new Error(`Creo not found: ${CONFIG.creo.exePath}`);
        }

        // 2. close old Creo and wait until it is really gone
        killCreo();

        const endKill = Date.now() + 15000;
        while (Date.now() < endKill && creoRunning()) {
            await sleep(1000);
        }

        await sleep(3000);

        // 3. start Creo ONE time
        writeLog('Starting Creo (one time)...');
        // Creo takes the folder it is started in as its start folder and reads config.pro from there.
        // The config.pro sets working_directory, so the Save window opens in the save folder.
        fs.mkdirSync(CONFIG.save.folder, { recursive: true });
        writeCreoConfig();
        spawn(CONFIG.creo.exePath, [], { cwd: CONFIG.save.folder, detached: true, stdio: 'ignore' }).unref();

        // 4. wait for the main window
        writeLog('Waiting for the main Creo window...');
        const handle = await waitForCreoHandle(CONFIG.creo.waitForWindow);
        writeLog(`Creo window found. Handle: ${handle}`);

        writeLog(`Waiting ${CONFIG.creo.loadWait / 1000} seconds for Creo to finish loading...`);
        await sleep(CONFIG.creo.loadWait);

        // 5. Appium attaches to the window (it does not start Creo)
        driver = await remote({
            ...CONFIG.appium,
            capabilities: {
                platformName: 'Windows',
                'appium:automationName': 'NovaWindows',
                'appium:appTopLevelWindow': handle,
                'appium:shouldCloseApp': false,
                'appium:newCommandTimeout': 120
            }
        });

        writeLog('Appium session created.');

        try {
            writeLog(`Window title: "${await driver.getTitle()}"`);
        } catch (error) {
            writeLog(`Could not read the title: ${firstLine(error)}`);
        }

        // 6. UI tree (only to see what Appium can see)
        const pageSource = await driver.getPageSource();
        fs.writeFileSync(DUMP_FILE, pageSource, 'utf8');
        writeLog(`UI tree saved: ${DUMP_FILE} (Button: ${countTag(pageSource, 'Button')}, Pane: ${countTag(pageSource, 'Pane')})`);

        // 7. close the start popups
        await closePopups();

        // 8. create the new file
        await createNewFile(handle);

        // 9. the design, the label, then save
        await createDesign(handle);
        await applyLabel(handle);
        await saveFile(handle);

        // 10. close the file, open it again and check the label
        await verifyProtection(handle);

        result = 'PASSED';
    } catch (error) {
        writeLog(`TEST FAILED: ${error.message}`);
        process.exitCode = 1;

        try {
            writeLog(`Creo windows at the error: ${listCreoWindows().map(w => `"${w.title}" ${w.width}x${w.height}`).join(' | ')}`);
        } catch {
            // ignore
        }
    } finally {
        // 10. close everything, also after an error
        if (driver) {
            try {
                await driver.deleteSession();
                writeLog('Appium session ended.');
            } catch (error) {
                writeLog(`Could not end the session: ${firstLine(error)}`);
            }
        }

        await sleep(2000);
        killCreo();

        printSummary();
        writeLog(`RESULT: ${result}`);
        writeLog('==================== RUN END ====================');
    }
}

run();