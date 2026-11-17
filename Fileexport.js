/**
 * fileexport.js - starts Creo, opens a file from a path, then exports it as STEP.
 * Run:  node fileexport.js "C:\folder\file.prt"      (or set CONFIG.filePath)
 */
const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG = {
    exePath: 'C:\\Program Files\\PTC\\Creo 13.4.0.0\\Parametric\\bin\\parametric.exe',   // <-- check this path
    filePath: 'C:\\Users\\TESTUSER\\Documents\\part_0001.prt.1',            // <-- the file to open
    processes: ['parametric', 'xtop'],
    popups: ['Administrator Mapkeys Update', 'Resource Center'],
    focusClick: { x: 0.57, y: 0.095 },   // empty part of the ribbon (Creo needs a click before it takes keys)

    // ---- export settings ----
    exportFolder: 'C:\\Users\\TESTUSER\\Documents\\exports',   // <-- where the exported file is saved
    exportTypeIndex: 9,                                         // STEP is 9 items below the top (Part) in the Type list
    closeCreoAfter: true,                                       // close Creo when the export is finished
    exportExt: '.stp',                                          // extension of the exported file
    exportTitles: ['Save a Copy', 'Save As'],                   // possible titles of the export window
    exportFocusClick: { x: 0.6, y: 0.85 },                      // empty part of the model area (safe to click)
    // positions inside the Save a Copy window (fraction of its width/height), from the screenshot
    dlg: {
        type:    { x: 0.40, y: 0.88 },    // "Type" dropdown
        pathBar: { x: 0.668, y: 0.078 },  // EMPTY part of the path bar (right of 'Documents'), not a folder name
        newName: { x: 0.56, y: 0.835 },   // "New file name" field
        ok:      { x: 0.26, y: 0.959 }    // OK button
    }
};
if (process.argv[2]) CONFIG.filePath = process.argv[2];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const log = m => console.log(`[${new Date().toLocaleTimeString()}] ${m}`);
const ps = (script, env = {}) => execFileSync('powershell.exe', ['-NoProfile', '-Command', script],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, PROCS: CONFIG.processes.join(','), ...env } }).trim();

async function waitFor(fn, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) {
        try { const v = fn(); if (v) return v; } catch { /* try again */ }
    }
    return null;
}

// PowerShell part that collects all top-level windows of the Creo processes into $all
const PRE = `
Add-Type -AssemblyName UIAutomationClient
$ids = @(Get-Process ($env:PROCS -split ',') -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$all = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,
       [Windows.Automation.Condition]::TrueCondition) | Where-Object { $ids -contains $_.Current.ProcessId }
`;

/** All visible Creo windows: [{ handle, x, y, width, height, title }] */
function windows() {
    const out = ps(PRE + `foreach ($w in $all) { $r = $w.Current.BoundingRectangle
        if ($r.Width -gt 0) { '{0}|{1}|{2}|{3}|{4}|{5}' -f $w.Current.NativeWindowHandle, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height, $w.Current.Name } }`);
    return out.split(/\r?\n/).filter(l => l.includes('|')).map(l => {
        const [handle, x, y, width, height, ...t] = l.split('|');
        return { handle, x: +x, y: +y, width: +width, height: +height, title: t.join('|') };
    });
}

/** Closes the start popups. */
function closePopups() {
    ps(PRE + `foreach ($w in $all) { if ($env:TITLES.Split('|') -contains $w.Current.Name) {
        try { $w.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close() } catch {} } }`,
        { TITLES: CONFIG.popups.join('|') });
}

/** Brings the window to the front (no Alt key) and clicks a point inside it. */
function focusAndClick(win, fx, fy) {
    ps(`
        Add-Type -AssemblyName UIAutomationClient
        Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name M -Namespace W
        [Windows.Automation.AutomationElement]::FromHandle([IntPtr][long]$env:H).SetFocus()
        Start-Sleep -Milliseconds 800
        [W.M]::SetCursorPos([int]$env:X, [int]$env:Y); Start-Sleep -Milliseconds 200
        [W.M]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 80; [W.M]::mouse_event(4,0,0,0,0)
    `, { H: win.handle, X: Math.round(win.x + win.width * fx), Y: Math.round(win.y + win.height * fy) });
}

const keys = k => ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:K)`, { K: k });

/** Pastes text into the field that has the focus, then Enter. */
const pasteAndEnter = text => ps(`
    Add-Type -AssemblyName System.Windows.Forms
    Set-Clipboard -Value $env:T; Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 400
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
`, { T: text });

/** Plain mouse click inside a window (no focus change). fx, fy = fraction of width/height. */
function clickAt(win, fx, fy) {
    ps(`
        Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int d,int e);' -Name M2 -Namespace W2
        [W2.M2]::SetCursorPos([int]$env:X, [int]$env:Y); Start-Sleep -Milliseconds 200
        [W2.M2]::mouse_event(2,0,0,0,0); Start-Sleep -Milliseconds 80; [W2.M2]::mouse_event(4,0,0,0,0)
    `, { X: Math.round(win.x + win.width * fx), Y: Math.round(win.y + win.height * fy) });
}

/** Pastes text into the field that has the focus (no Enter). */
const paste = text => ps(`
    Add-Type -AssemblyName System.Windows.Forms
    Set-Clipboard -Value $env:T; Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 400
`, { T: text });

async function run() {
    // Creo saves name.prt.1 but the Open window wants name.prt
    const target = path.resolve(CONFIG.filePath).replace(/(\.[a-z]{2,4})\.\d+$/i, '$1');
    const base = path.basename(target);
    const model = base.replace(/\.[^.]+$/, '');

    if (!fs.existsSync(CONFIG.exePath)) throw new Error(`Creo not found: ${CONFIG.exePath}`);
    if (!fs.readdirSync(path.dirname(target)).some(f => f.toLowerCase().startsWith(base.toLowerCase())))
        throw new Error(`The file does not exist: ${target}`);

    // 1. start Creo (close the old one first)
    CONFIG.processes.forEach(p => { try { execSync(`taskkill /IM ${p}.exe /F`, { stdio: 'ignore' }); } catch { /* not running */ } });
    await sleep(4000);
    log('Starting Creo...');
    spawn(CONFIG.exePath, [], { cwd: path.dirname(target), detached: true, stdio: 'ignore' }).unref();

    const main = await waitFor(() => windows().filter(w => w.width >= 800 && w.height >= 500)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0], 120000);
    if (!main) throw new Error('The main Creo window did not appear.');
    log(`Creo window found: "${main.title}"`);

    await sleep(15000);   // let Creo finish loading
    closePopups();

    // 2. open the file: click the ribbon, Ctrl+O, wait for the File Open window (3 tries)
    let dialog = null;
    for (let i = 1; i <= 3 && !dialog; i++) {
        log(`Opening the File Open window (try ${i})...`);
        const w = windows().find(x => x.handle === main.handle) || main;
        focusAndClick(w, CONFIG.focusClick.x, CONFIG.focusClick.y);
        keys('^o');
        dialog = await waitFor(() => windows().find(x => x.title === 'File Open'), 8000);
    }
    if (!dialog) throw new Error('The File Open window did not open.');

    log(`Opening: ${target}`);
    pasteAndEnter(target);

    const opened = await waitFor(() => windows().some(w => norm(w.title).includes(norm(model))), 40000);
    if (!opened) throw new Error(`"${base}" is not open (its name is not in a Creo window title).`);
    log(`"${model}" is open.`);

    // 3. export: Ctrl+Shift+S -> Save a Copy -> choose STEP -> set folder -> set name -> OK
    fs.mkdirSync(CONFIG.exportFolder, { recursive: true });
    const outName = model + CONFIG.exportExt;
    const outFile = path.join(CONFIG.exportFolder, outName);
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);   // so the check at the end is reliable

    let saveWin = null;
    for (let i = 1; i <= 3 && !saveWin; i++) {
        log(`Opening the Save a Copy window (try ${i})...`);
        const w = windows().find(x => norm(x.title).includes(norm(model))) || main;
        focusAndClick(w, CONFIG.exportFocusClick.x, CONFIG.exportFocusClick.y);
        keys('^+s');
        saveWin = await waitFor(() => windows().find(x => CONFIG.exportTitles.includes(x.title)), 8000);
    }
    if (!saveWin) throw new Error('The Save a Copy window did not open.');
    await sleep(1000);

    // the window can move or resize after a change, so read its position again before every click
    const dlg = () => windows().find(x => CONFIG.exportTitles.includes(x.title)) || saveWin;

    // a) Type dropdown: open it, go to the top of the list, go down to STEP, Enter
    log('Choosing type: STEP');
    clickAt(dlg(), CONFIG.dlg.type.x, CONFIG.dlg.type.y);
    await sleep(1000);
    keys('{HOME}');
    await sleep(500);
    keys(`{DOWN ${CONFIG.exportTypeIndex}}`);
    await sleep(500);
    keys('{ENTER}');
    await sleep(1500);

    // b) Folder: click the path bar, paste the folder, Enter
    log(`Folder: ${CONFIG.exportFolder}`);
    clickAt(dlg(), CONFIG.dlg.pathBar.x, CONFIG.dlg.pathBar.y);
    await sleep(500);
    pasteAndEnter(CONFIG.exportFolder);
    await sleep(1500);

    // c) New file name: click the field and paste the name (no Enter)
    log(`File name: ${outName}`);
    clickAt(dlg(), CONFIG.dlg.newName.x, CONFIG.dlg.newName.y);
    await sleep(500);
    paste(model);          // Creo adds the .stp itself
    await sleep(800);

    // d) click the OK button at the bottom of the window (second try if the window is still open)
    for (let i = 1; i <= 2; i++) {
        log(`Clicking OK (try ${i})`);
        clickAt(dlg(), CONFIG.dlg.ok.x, CONFIG.dlg.ok.y);
        await sleep(2500);
        if (!windows().some(x => CONFIG.exportTitles.includes(x.title))) break;
    }

    // Creo may open an "Export STEP" options window - accept the defaults with Enter
    const optWin = await waitFor(() => windows().find(x => /step|export/i.test(x.title) && x.handle !== saveWin.handle), 10000);
    if (optWin) { log(`Options window: "${optWin.title}" - pressing Enter`); keys('{ENTER}'); }

    const saved = await waitFor(() => fs.existsSync(outFile), 60000);
    if (!saved) throw new Error(`The export file was not created: ${outFile}`);
    log(`PASSED: exported to ${outFile}.`);

    // 4. close Creo
    if (CONFIG.closeCreoAfter) {
        await sleep(2000);   // let Creo finish writing the file
        CONFIG.processes.forEach(p => { try { execSync(`taskkill /IM ${p}.exe /F`, { stdio: 'ignore' }); } catch { /* not running */ } });
        log('Creo closed.');
    } else {
        log('Creo stays open.');
    }
}

run().catch(e => { log(`FAILED: ${e.message}`); process.exitCode = 1; });