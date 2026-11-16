/**
 * Reset-user.js
 *
 * What this script does:
 *   1. Closes any old Creo, starts Creo ONE time, finds the main window
 *   2. Appium attaches to the main window (title check + UI tree dump)
 *   3. Closes the start popups (Administrator Mapkeys Update, Resource Center)
 *   4. Opens the "HaloCAD" tab of the ribbon
 *   5. Clicks the "Status" button of the HaloCAD tab and opens the Status window
 *   6. Saves screenshots + a UI Automation list of the Status window
 *   7. Clicks "Reset" in the HaloCAD window
 *   8. The question "Want to reset Authentication details?" opens -> clicks "Yes"
 *   9. Clicks "OK" in the HaloCAD window
 *  10. Closes Creo (CONFIG.creo.closeCreoAtEnd)
 *
 * How the elements are found (the order is always the same):
 *   1st  UI Automation (by name)   -> best, if Creo shows the element
 *   2nd  OCR (read the screen text) -> finds the word and clicks it
 *
 * Run:   node Reset-user.js
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
        processNames: ['parametric.exe', 'xtop.exe'],
        minWidth: 800,
        minHeight: 500,
        waitForWindow: 120000,
        loadWait: 15000,
        startFolder: 'C:\\Users\\TESTUSER\\Documents',   // Creo is started in this folder
        popupTitles: ['Administrator Mapkeys Update', 'Resource Center'],
        closeCreoAtEnd: true                             // true = Creo is closed at the end (false = it stays open)
    },

    halocad: {
        tabName: 'HaloCAD',            // the tab name as written in the Creo ribbon
        statusName: 'Status',          // the button name on the HaloCAD tab
        ribbonHeight: 190,             // height (px) of the ribbon area that OCR reads
        tabBarHeight: 140,             // height (px) of the tab bar area that OCR reads for the tab name
        afterTabWait: 2500,
        afterStatusWait: 4000,
        statusWindowTitle: 'HaloCAD',  // title of the window that opens (part of the title, not case sensitive)
        waitForStatusWindow: 15000,

        resetName: 'Reset',            // button in the HaloCAD window ("Connected as ... [Reset]")
        confirmYesName: 'Yes',         // button in the question "Want to reset Authentication details?"
        okName: 'OK',                  // button at the bottom of the HaloCAD window
        waitForConfirm: 15000,         // ms to wait for the question window after Reset
        afterYesWait: 4000,            // ms to wait after Yes (the reset needs a moment)
        yesPoint: { x: 0.64, y: 0.87 },   // fixed point of Yes (0..1 of the question window), used if UI Automation and OCR fail
        okPoint: { x: 0.50, y: 0.92 },    // fixed point of OK (0..1 of the HaloCAD window), used if UI Automation and OCR fail
        waitForInfo: 15000,               // ms to wait for the 2nd popup "Authentication reset completed" after Yes
        infoOkPoint: { x: 0.86, y: 0.855 } // fixed point of the OK of the 2nd popup (0..1 of that popup), used if UI Automation and OCR fail
    },

    ocrScale: 3,
    screenshotFolder: 'screenshots',
    log: { file: 'Reset-user-log.txt' },
    dumpFile: 'reset-user-ui-dump.xml',
    statusDumpFile: 'halocad-status-dump.txt',
    ribbonDumpFile: 'halocad-ribbon-dump.txt'
};

// ---------- log ----------
const LOG_FILE = path.join(__dirname, CONFIG.log.file);
const DUMP_FILE = path.join(__dirname, CONFIG.dumpFile);
const STATUS_DUMP_FILE = path.join(__dirname, CONFIG.statusDumpFile);
const RIBBON_DUMP_FILE = path.join(__dirname, CONFIG.ribbonDumpFile);
const SHOT_DIR = path.join(__dirname, CONFIG.screenshotFolder);

try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch { /* ignore */ }

function writeLog(message) {
    const line = `[${new Date().toLocaleString()}] ${message}\n`;
    console.log(line.trim());
    try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* ignore */ }
}

const summary = {
    popups: 'not done',
    halocadTab: 'not done',
    statusClick: 'not done',
    statusWindow: 'not done',
    reset: 'not done',
    confirm: 'not done',
    info: 'not done',
    ok: 'not done',
    appClosed: 'not done'
};

function printSummary() {
    writeLog('----------------------------------------------------');
    writeLog(`Popups closed    : ${summary.popups}`);
    writeLog(`HaloCAD tab      : ${summary.halocadTab}`);
    writeLog(`Status click     : ${summary.statusClick}`);
    writeLog(`Status window    : ${summary.statusWindow}`);
    writeLog(`Reset clicked    : ${summary.reset}`);
    writeLog(`Question (Yes)   : ${summary.confirm}`);
    writeLog(`Info popup (OK)  : ${summary.info}`);
    writeLog(`OK clicked       : ${summary.ok}`);
    writeLog(`Creo closed      : ${summary.appClosed}`);
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

function countTag(xml, tag) {
    const match = xml.match(new RegExp(`<${tag}[\\s>]`, 'g'));
    return match ? match.length : 0;
}

// ---------- windows of Creo ----------
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

// focus without the Alt key (a tapped Alt switches on the ribbon key tips in Creo)
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

function getWindowByHandle(handle) {
    return listCreoWindows().find(w => w.handle === String(handle)) || null;
}

// ---------- mouse, focus ----------
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
        writeLog(`Screenshot saved: ${saveScreenshot(rect, `${name}-${Date.now()}.png`)}`);
    } catch (error) {
        writeLog(`Could not save the screenshot: ${firstLine(error)}`);
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

// ---------- UI Automation (by name) ----------
/**
 * Tries to click an element with this name. The first control type that works is used:
 * TabItem / Button / MenuItem / ListItem / Hyperlink / Text (via SelectionItem, Invoke or ExpandCollapse pattern).
 * Returns 'clicked', 'no-element' or 'no-pattern' (the element exists but cannot be clicked by pattern).
 */
function uiaClickByName(handle, name) {
    try {
        return runPowerShell(`
            Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
            $A = [System.Windows.Automation.AutomationElement]
            $T = [System.Windows.Automation.TreeScope]
            try { $win = $A::FromHandle([IntPtr][long]$env:WIN_HANDLE) } catch { $win = $null }

            if (-not $win) { 'no-window' } else {
                $c = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:UIA_NAME)
                $found = $win.FindAll($T::Descendants, $c)
                if ($found.Count -eq 0) { 'no-element' } else {
                    $result = 'no-pattern'
                    foreach ($e in $found) {
                        try { $e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $result = 'clicked'; break } catch { }
                        try { $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $result = 'clicked'; break } catch { }
                    }
                    $result
                }
            }
        `, 60000, { WIN_HANDLE: String(handle), UIA_NAME: name }).split(/\r?\n/).pop();
    } catch (error) {
        return `error: ${firstLine(error)}`;
    }
}

/** Saves every element that UI Automation can see in a window, to know the real names. */
function dumpWindow(handle, file) {
    try {
        const out = runPowerShell(`
            Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
            $A = [System.Windows.Automation.AutomationElement]
            $T = [System.Windows.Automation.TreeScope]
            $win = $A::FromHandle([IntPtr][long]$env:WIN_HANDLE)
            foreach ($e in $win.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
                '{0}|{1}|enabled={2}|id={3}' -f $e.Current.ControlType.ProgrammaticName, $e.Current.Name, $e.Current.IsEnabled, $e.Current.AutomationId
            }
        `, 90000, { WIN_HANDLE: String(handle) });

        fs.writeFileSync(file, out || '(nothing found: UI Automation sees no element in this window)', 'utf8');
        writeLog(`UI Automation list saved: ${file}`);
    } catch (error) {
        writeLog(`Could not save the UI Automation list: ${firstLine(error)}`);
    }
}

// ---------- steps ----------
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

/** Is the HaloCAD tab the open one? The HaloCAD buttons (for example "Status") are visible on the ribbon. */
function halocadRibbonShown(main) {
    const hc = CONFIG.halocad;
    return !!findWord({ x: main.x, y: main.y + 40, width: main.width, height: hc.ribbonHeight - 40 }, hc.statusName);
}

/** Goes to the HaloCAD tab: 1st UI Automation, 2nd OCR on the tab bar. */
async function openHalocadTab(mainHandle) {
    const hc = CONFIG.halocad;

    focusWindow(mainHandle);
    await sleep(1000);

    const main = getWindowByHandle(mainHandle);
    if (!main) throw new Error('The main Creo window was not found.');

    // a picture of the tab bar before the click, as proof
    shot({ x: main.x, y: main.y, width: main.width, height: hc.tabBarHeight }, 'creo-tabbar-before');

    action('TAB', `go to the "${hc.tabName}" tab`);

    // 1st: UI Automation
    const uia = uiaClickByName(mainHandle, hc.tabName);
    writeLog(`  "${hc.tabName}" (UI Automation): ${uia}`);

    if (uia === 'clicked') {
        await sleep(hc.afterTabWait);
        summary.halocadTab = 'opened (UI Automation)';
        return;
    }

    // 2nd: OCR, click on the word in the tab bar
    writeLog('  UI Automation did not click the tab. Using OCR.');
    const area = { x: main.x, y: main.y, width: main.width, height: hc.tabBarHeight };
    const words = ocrWords(area);
    writeLog(`  words read in the tab bar: ${words.map(w => w.text).join(' ')}`);

    const tab = words.find(w => normalize(w.text) === normalize(hc.tabName));

    if (!tab) {
        summary.halocadTab = 'FAILED (tab not found)';
        shot(main, 'creo-halocad-tab-fail');
        throw new Error(`The tab "${hc.tabName}" was not found in the ribbon. Check CONFIG.halocad.tabName and the screenshot.`);
    }

    clickAt(tab.x, tab.y);
    await sleep(hc.afterTabWait);

    // check that the tab really opened (the Status button is on the ribbon)
    const now = getWindowByHandle(mainHandle) || main;
    shot({ x: now.x, y: now.y, width: now.width, height: hc.ribbonHeight }, 'creo-halocad-ribbon');
    dumpWindow(mainHandle, RIBBON_DUMP_FILE);

    summary.halocadTab = halocadRibbonShown(now)
        ? 'opened (OCR, the Status button is on the ribbon)'
        : 'clicked (OCR), but the Status button is not seen yet (check the screenshot)';
}

/** Clicks the Status button of the HaloCAD tab: 1st UI Automation, 2nd OCR on the ribbon. */
async function clickStatus(mainHandle) {
    const hc = CONFIG.halocad;

    const main = getWindowByHandle(mainHandle);
    if (!main) throw new Error('The main Creo window was not found.');

    // remember the windows that are open now, to see the new one
    const before = new Set(listCreoWindows().map(w => w.handle));

    action('STATUS', `click "${hc.statusName}"`);

    let how = null;
    const uia = uiaClickByName(mainHandle, hc.statusName);
    writeLog(`  "${hc.statusName}" (UI Automation): ${uia}`);

    if (uia === 'clicked') {
        how = 'UI Automation';
    } else {
        writeLog('  UI Automation did not click it. Using OCR.');
        const area = { x: main.x, y: main.y + 40, width: main.width, height: hc.ribbonHeight - 40 };
        const words = ocrWords(area);
        writeLog(`  words read on the ribbon: ${words.map(w => w.text).join(' ')}`);

        const hit = words.filter(w => normalize(w.text) === normalize(hc.statusName)).sort((a, b) => a.x - b.x)[0];

        if (!hit) {
            summary.statusClick = 'FAILED (button not found)';
            shot(main, 'creo-status-fail');
            throw new Error(`The button "${hc.statusName}" was not found on the "${hc.tabName}" tab. Check CONFIG.halocad.statusName and the screenshot.`);
        }

        clickAt(hit.x, hit.y);
        how = 'OCR';
    }

    summary.statusClick = `clicked (${how})`;
    await sleep(hc.afterStatusWait);

    // find the Status window: a new window, or a window whose title has the word "Status"
    const end = Date.now() + hc.waitForStatusWindow;
    let statusWin = null;

    while (Date.now() < end && !statusWin) {
        try {
            const windows = listCreoWindows();
            statusWin =
                windows.find(w => w.title && w.title.toLowerCase().includes(hc.statusWindowTitle.toLowerCase()) && w.handle !== String(mainHandle)) ||
                windows.find(w => !before.has(w.handle) && w.width > 100 && w.height > 80) ||
                null;
        } catch (error) {
            writeLog(`Could not list the windows: ${firstLine(error)}`);
        }

        if (!statusWin) await sleep(1000);
    }

    const now = getWindowByHandle(mainHandle) || main;

    if (statusWin) {
        writeLog(`Status window found: handle=${statusWin.handle} title="${statusWin.title}" position=${statusWin.x},${statusWin.y} size=${statusWin.width}x${statusWin.height}`);
        summary.statusWindow = `opened ("${statusWin.title}" ${statusWin.width}x${statusWin.height})`;

        focusWindow(statusWin.handle);
        await sleep(1000);
        shot(statusWin, 'halocad-status-window');
        dumpWindow(statusWin.handle, STATUS_DUMP_FILE);

        try {
            writeLog(`  words read in the Status window: ${ocrWords(statusWin).map(w => w.text).join(' ')}`);
        } catch (error) {
            writeLog(`  OCR failed in the Status window: ${firstLine(error)}`);
        }

        await resetAuthentication(statusWin, mainHandle);
    } else {
        // the Status can also be a panel inside the Creo window (no new window)
        writeLog('No separate Status window was found. It may be a panel inside the Creo window.');
        shot(now, 'halocad-status-main');
        summary.statusWindow = 'no new window found (check the halocad-status-main screenshot, it can be a panel inside Creo)';
        throw new Error('The HaloCAD Status window was not found, so Reset cannot be clicked. Check CONFIG.halocad.statusWindowTitle and the screenshot.');
    }
}

function isOkWord(w) {
    return ['ok', '0k'].includes(normalize(w.text));
}

/**
 * Clicks a button inside one window: 1st UI Automation (by name), 2nd OCR (only inside this window).
 * Returns 'UI Automation', 'OCR' or null.
 */
function clickButtonInWindow(win, name, opts = {}) {
    focusWindow(win.handle);

    // fresh position of the window
    const now = listCreoWindows().find(w => w.handle === String(win.handle)) || win;

    const uia = uiaClickByName(win.handle, name);
    writeLog(`  "${name}" (UI Automation): ${uia}`);
    if (uia === 'clicked') return 'UI Automation';

    writeLog(`  UI Automation did not click "${name}". Using OCR.`);
    const words = ocrWords(now);
    writeLog(`  words read in the window: ${words.map(w => w.text).join(' ')}`);

    const target = normalize(name);
    const exact = w => normalize(w.text) === target || (target === 'ok' && isOkWord(w));
    // softer: OCR can read "Yes" as "Yes." / "Yes|" / "Ye5"
    const soft = w => {
        const t = normalize(w.text);
        return t.length > 0 && (t.startsWith(target) || (target.length >= 3 && t.length >= 3 && t.slice(0, 2) === target.slice(0, 2) && Math.abs(t.length - target.length) <= 1));
    };

    let hits = words.filter(exact).sort((a, b) => b.y - a.y);
    if (!hits.length) hits = words.filter(soft).sort((a, b) => b.y - a.y);

    if (hits.length) {
        clickAt(hits[0].x, hits[0].y);
        return 'OCR';
    }

    if (opts.fixed) {
        writeLog(`  the word "${name}" was not found. Clicking the fixed point.`);
        shot(now, `halocad-${normalize(name)}-fixedpoint`);
        clickAt(now.x + now.width * opts.fixed.x, now.y + now.height * opts.fixed.y);
        return 'fixed point';
    }

    if (opts.enterKey) {
        writeLog(`  the word "${name}" was not found. Pressing Enter (default button).`);
        sendKeys('{ENTER}');
        return 'Enter key';
    }

    return null;
}

/** Sends keys like a person, for example '{ENTER}'. */
function sendKeys(keys) {
    runPowerShell(`
        Add-Type -AssemblyName System.Windows.Forms
        try { [System.Windows.Forms.SendKeys]::SendWait($env:KEYS) } catch { }
    `, 20000, { KEYS: keys });
}

/** Waits until a window with this handle is gone. Returns true / false. */
async function waitUntilHandleGone(handle, ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        try {
            if (!listCreoWindows().some(w => w.handle === String(handle))) return true;
        } catch { /* try again */ }

        await sleep(1000);
    }

    return false;
}

/** In the HaloCAD window: Reset -> question window -> Yes -> OK. */
async function resetAuthentication(statusWin, mainHandle) {
    const hc = CONFIG.halocad;

    // 1. Reset
    action('RESET', `click "${hc.resetName}" in the HaloCAD window`);
    const beforeReset = new Set(listCreoWindows().map(w => w.handle));

    let how = clickButtonInWindow(statusWin, hc.resetName);

    if (!how) {
        summary.reset = 'FAILED (button not found)';
        shot(statusWin, 'halocad-reset-fail');
        throw new Error(`The button "${hc.resetName}" was not found in the HaloCAD window. See the screenshot and halocad-status-dump.txt.`);
    }

    summary.reset = `clicked (${how})`;

    // 2. wait for the question window ("Want to reset Authentication details?")
    action('RESET', 'wait for the question window');
    const end = Date.now() + hc.waitForConfirm;
    let confirm = null;

    while (Date.now() < end && !confirm) {
        try {
            const all = listCreoWindows().filter(w =>
                w.handle !== String(mainHandle) && w.handle !== String(statusWin.handle) && w.width > 150 && w.height > 80);
            confirm =
                all.find(w => w.title.toLowerCase().includes(hc.statusWindowTitle.toLowerCase())) ||
                all.find(w => !beforeReset.has(w.handle)) ||
                null;
        } catch (error) {
            writeLog(`Could not list the windows: ${firstLine(error)}`);
        }

        if (!confirm) await sleep(1000);
    }

    if (!confirm) {
        summary.confirm = 'FAILED (question window did not open)';
        shot(statusWin, 'halocad-confirm-fail');
        throw new Error('The question window did not open after Reset.');
    }

    writeLog(`Question window found: handle=${confirm.handle} title="${confirm.title}" size=${confirm.width}x${confirm.height}`);
    focusWindow(confirm.handle);
    await sleep(800);
    shot(confirm, 'halocad-confirm-window');
    dumpWindow(confirm.handle, path.join(__dirname, 'halocad-confirm-dump.txt'));

    // 3. Yes
    action('RESET', `click "${hc.confirmYesName}"`);
    how = clickButtonInWindow(confirm, hc.confirmYesName, { fixed: hc.yesPoint });

    if (!how) {
        summary.confirm = 'FAILED (Yes not found)';
        throw new Error(`The button "${hc.confirmYesName}" was not found in the question window. See the halocad-confirm-window screenshot.`);
    }

    if (!(await waitUntilHandleGone(confirm.handle, 15000))) {
        summary.confirm = `clicked (${how}), but the question window is still open`;
        throw new Error('The question window is still open after Yes.');
    }

    summary.confirm = `clicked (${how})`;
    await sleep(1500);

    // 3b. the 2nd popup: "Authentication reset completed. Please relaunch the CAD application." with its own OK.
    // It is modal: the OK of the HaloCAD window cannot be clicked before this OK is clicked.
    action('RESET', 'wait for the 2nd popup (Authentication reset completed)');
    const endInfo = Date.now() + hc.waitForInfo;
    let info = null;

    while (Date.now() < endInfo && !info) {
        try {
            const all = listCreoWindows().filter(w =>
                w.handle !== String(mainHandle) && w.handle !== String(statusWin.handle) &&
                w.handle !== String(confirm.handle) && w.width > 150 && w.height > 80);
            info = all.find(w => w.title.toLowerCase().includes(hc.statusWindowTitle.toLowerCase())) || all[0] || null;
        } catch (error) {
            writeLog(`Could not list the windows: ${firstLine(error)}`);
        }

        if (!info) await sleep(1000);
    }

    if (info) {
        writeLog(`2nd popup found: handle=${info.handle} title="${info.title}" size=${info.width}x${info.height}`);
        focusWindow(info.handle);
        await sleep(800);
        shot(info, 'halocad-info-popup');

        try {
            writeLog(`  words read in the 2nd popup: ${ocrWords(info).map(w => w.text).join(' ')}`);
        } catch { /* ignore */ }

        // only the 2nd popup is searched (not the HaloCAD window), so the red OK is never clicked here
        action('RESET', `click "${hc.okName}" in the 2nd popup`);
        how = clickButtonInWindow(info, hc.okName, { fixed: hc.infoOkPoint });

        if (!how) {
            summary.info = 'FAILED (OK not found)';
            throw new Error('The OK button of the 2nd popup was not found. See the halocad-info-popup screenshot.');
        }

        if (!(await waitUntilHandleGone(info.handle, 15000))) {
            summary.info = `clicked (${how}), but the 2nd popup is still open`;
            shot(info, 'halocad-info-still-open');
            throw new Error('The 2nd popup is still open after OK.');
        }

        summary.info = `clicked (${how}), the 2nd popup is closed`;
    } else {
        writeLog('The 2nd popup did not open. Going on with the OK of the HaloCAD window.');
        summary.info = 'popup not seen (skipped)';
    }

    await sleep(hc.afterYesWait);

    try {
        writeLog(`Creo windows after Yes: ${listCreoWindows().map(w => `"${w.title}" ${w.width}x${w.height}`).join(' | ')}`);
    } catch { /* ignore */ }

    // 4. OK in the HaloCAD window
    const current = listCreoWindows().find(w => w.handle === statusWin.handle);

    if (!current) {
        summary.ok = 'not needed (the HaloCAD window closed by itself after Yes)';
        return;
    }

    action('RESET', `click "${hc.okName}" in the HaloCAD window`);
    shot(current, 'halocad-before-ok');
    how = clickButtonInWindow(current, hc.okName, { fixed: hc.okPoint });

    if (!how) {
        summary.ok = 'FAILED (OK not found)';
        throw new Error(`The button "${hc.okName}" was not found in the HaloCAD window.`);
    }

    if (!(await waitUntilHandleGone(current.handle, 15000))) {
        summary.ok = `clicked (${how}), but the HaloCAD window is still open`;
        throw new Error('The HaloCAD window is still open after OK.');
    }

    summary.ok = `clicked (${how}), the HaloCAD window is closed`;
}

// ---------- main ----------
async function run() {
    let driver;
    let result = 'FAILED';

    writeLog('==================== RUN START (Reset-user) ====================');

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
        fs.mkdirSync(CONFIG.creo.startFolder, { recursive: true });
        spawn(CONFIG.creo.exePath, [], { cwd: CONFIG.creo.startFolder, detached: true, stdio: 'ignore' }).unref();

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

        // 8. HaloCAD tab, then the Status button
        await openHalocadTab(handle);
        await clickStatus(handle);

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
        if (driver) {
            try {
                await driver.deleteSession();
                writeLog('Appium session ended.');
            } catch (error) {
                writeLog(`Could not end the session: ${firstLine(error)}`);
            }
        }

        await sleep(2000);

        if (CONFIG.creo.closeCreoAtEnd) {
            killCreo();
            await sleep(2000);
            summary.appClosed = creoRunning() ? 'NO (Creo is still running)' : 'yes';
        } else {
            summary.appClosed = 'no (left open, closeCreoAtEnd is false)';
            writeLog('Creo is left open (CONFIG.creo.closeCreoAtEnd = false).');
        }

        printSummary();
        writeLog(`RESULT: ${result}`);
        writeLog('==================== RUN END ====================');
    }
}

run();