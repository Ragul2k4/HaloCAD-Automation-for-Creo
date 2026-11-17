/**
 * Main.js
 *
 * One file to run the three Creo scripts. When you start it, a menu is shown in the terminal:
 *
 *   1. Creo test
 *   2. User reset
 *   3. Microsoft sign-in
 *   4. Run all one by one
 *   5. Exit
 *
 * Every script is started as its own Node process, so each one keeps its own log file and its own settings.
 * This file writes ONE main log (CONFIG.log.file) with the choice, the start, the end, the exit code and the result.
 *
 * A script is PASSED when its exit code is 0 and none of its "failPatterns" is found in its own log file.
 * (Microsoft-sign.js writes a failed rights check only in its log, not in the exit code, so it needs a pattern.)
 *
 * Run with the menu:      node Main.js
 * Run without the menu:   node Main.js creo reset sign      (keys: creo, reset, sign. Use "all" for all three)
 */
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// ---------- settings (change only here) ----------
const CONFIG = {
    log: { file: 'Main-log.txt' },

    // the order of this list is the order of the menu and of "Run all"
    scripts: [
        {
            key: 'creo',
            name: 'Creo test',
            files: ['Creo-test.js'],
            logFile: 'Creo-run-log.txt',
            failPatterns: [/RESULT:\s*FAILED/i, /FILE SECURITY\s*:\s*(UNPROTECTED|UNKNOWN)/i]
        },
        {
            key: 'reset',
            name: 'User reset',
            // the first name that exists in the folder is used (the file was renamed, so both spellings are tried)
            files: ['User-rest.js', 'User-reset.js', 'Reset-user.js'],
            logFile: 'User-reset-log.txt',          // same name as CONFIG.log.file in that script
            failPatterns: [/RESULT:\s*FAILED/i]
        },
        {
            key: 'sign',
            name: 'Microsoft sign-in',
            files: ['Microsoft-sign.js'],
            logFile: 'Microsoft-sign-log.txt',
            failPatterns: [/Rights check\s*:\s*FAIL/i, /Test failed:/i, /\| ERROR \|/]
        }
    ],

    stopOnFailure: false,        // true = in "Run all", if one script fails, the next ones are NOT started
    pauseBetween: 8000,          // ms to wait between two scripts (Creo needs time to close)
    scriptTimeout: 20 * 60000,   // ms. A script that runs longer than this is stopped (20 minutes)
    checkAppium: true,           // writes a warning in the log if the Appium server does not answer
    appiumStatusUrl: 'http://127.0.0.1:4723/status'
};

// ---------- log ----------
const LOG_FILE = path.join(__dirname, CONFIG.log.file);

try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch { /* ignore */ }

function writeLog(message) {
    const line = `[${new Date().toLocaleString()}] ${message}\n`;
    console.log(line.trim());
    try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* ignore */ }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstLine = error => String(error.message || error).split('\n')[0];

function formatTime(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// ---------- helpers ----------
/** The real file name of a script: the first one of "files" that exists in the folder. */
function scriptFile(script) {
    return script.files.find(f => fs.existsSync(path.join(__dirname, f))) || null;
}

/** Stops a process and everything it started (PowerShell, Creo helpers ...). */
function killTree(pid) {
    try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
        // already gone
    }
}

/** Is the Appium server answering? Only a warning, the scripts decide by themselves what to do. */
async function checkAppium() {
    if (!CONFIG.checkAppium) return;

    if (typeof fetch !== 'function') {
        writeLog('Appium check skipped (this Node version has no fetch).');
        return;
    }

    try {
        const response = await fetch(CONFIG.appiumStatusUrl, { signal: AbortSignal.timeout(5000) });
        writeLog(`Appium server: answers (HTTP ${response.status})`);
    } catch (error) {
        writeLog(`WARNING: the Appium server does not answer at ${CONFIG.appiumStatusUrl} (${firstLine(error)}). Creo-test.js and the reset script may wait a long time.`);
    }
}

/** Looks in the log file of a script for a failure line. Returns the first line found, or ''. */
function findFailureInLog(script) {
    const file = path.join(__dirname, script.logFile);
    let text = '';

    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        return '';   // no log file: the exit code decides
    }

    const lines = text.split(/\r?\n/);

    for (const pattern of script.failPatterns || []) {
        const hit = lines.find(l => pattern.test(l));
        if (hit) return hit.trim();
    }

    return '';
}

/** Runs one script as its own Node process. Returns { exitCode, timedOut }. */
function runScript(file) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(__dirname, file)], {
            cwd: __dirname,
            stdio: 'inherit'
        });

        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            writeLog(`TIMEOUT: ${file} runs longer than ${formatTime(CONFIG.scriptTimeout)}. Stopping it.`);
            killTree(child.pid);
        }, CONFIG.scriptTimeout);

        child.on('error', error => {
            clearTimeout(timer);
            writeLog(`Could not start ${file}: ${firstLine(error)}`);
            resolve({ exitCode: -1, timedOut: false });
        });

        child.on('close', code => {
            clearTimeout(timer);
            resolve({ exitCode: code === null ? -1 : code, timedOut });
        });
    });
}

/** Runs a list of scripts one by one and writes the summary. Returns the number of failed scripts. */
async function runScripts(scripts) {
    const startAll = Date.now();
    const results = [];
    let stopped = false;

    // all script files must exist before anything is started
    const missing = scripts.filter(s => !scriptFile(s));

    if (missing.length) {
        missing.forEach(s => writeLog(`ERROR: no file found in ${__dirname} for "${s.name}". Tried: ${s.files.join(', ')}`));
        return missing.length;
    }

    writeLog('==================== RUN START ====================');
    writeLog(`Scripts to run: ${scripts.map(s => `${s.name} (${scriptFile(s)})`).join(' -> ')}`);
    await checkAppium();

    for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];
        const file = scriptFile(script);

        if (stopped) {
            results.push({ script, status: 'SKIPPED', detail: 'an earlier script failed (stopOnFailure)', time: 0 });
            continue;
        }

        writeLog('----------------------------------------------------');
        writeLog(`START  ${i + 1}/${scripts.length}: ${script.name} (${file})`);

        const start = Date.now();
        const { exitCode, timedOut } = await runScript(file);
        const time = Date.now() - start;

        let status = 'PASSED';
        let detail = '';

        if (timedOut) {
            status = 'FAILED';
            detail = `stopped after the timeout (${formatTime(CONFIG.scriptTimeout)})`;
        } else if (exitCode !== 0) {
            status = 'FAILED';
            detail = `exit code ${exitCode}`;
        }

        const logLine = findFailureInLog(script);

        if (status === 'PASSED' && logLine) {
            status = 'FAILED';
            detail = `found in ${script.logFile}: ${logLine}`;
        } else if (status === 'FAILED' && logLine) {
            detail += ` | ${script.logFile}: ${logLine}`;
        }

        results.push({ script, status, detail, time });
        writeLog(`END    ${script.name}: ${status}${detail ? ` (${detail})` : ''} | time ${formatTime(time)} | log: ${script.logFile}`);

        if (status === 'FAILED' && CONFIG.stopOnFailure && scripts.length > 1) {
            stopped = true;
            writeLog('stopOnFailure is true: the next scripts are not started.');
        }

        if (i < scripts.length - 1 && !stopped) {
            writeLog(`Waiting ${CONFIG.pauseBetween / 1000} seconds before the next script...`);
            await sleep(CONFIG.pauseBetween);
        }
    }

    // ---------- summary ----------
    const failed = results.filter(r => r.status === 'FAILED').length;
    const skipped = results.filter(r => r.status === 'SKIPPED').length;

    writeLog('----------------------------------------------------');

    results.forEach((r, i) => {
        writeLog(`${String(i + 1)}. ${r.script.name.padEnd(18)}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
    });

    writeLog('----------------------------------------------------');
    writeLog(`Total time: ${formatTime(Date.now() - startAll)}`);
    writeLog(`RESULT: ${failed || skipped ? 'FAILED' : 'PASSED'} (${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped)`);
    writeLog('==================== RUN END ====================');

    return failed;
}

// ---------- menu ----------
/** Asks one question in the terminal. The input is closed after the answer, so the scripts can use the terminal. */
function ask(question) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        let answered = false;

        rl.question(question, answer => {
            answered = true;
            rl.close();
            resolve(answer.trim());
        });

        // Ctrl+C / Ctrl+D or a closed input: leave the menu
        rl.on('close', () => { if (!answered) resolve('5'); });
    });
}

function printMenu() {
    console.log('');
    console.log('==================== Creo automation ====================');
    CONFIG.scripts.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}`));
    console.log(`  ${CONFIG.scripts.length + 1}. Run all one by one`);
    console.log(`  ${CONFIG.scripts.length + 2}. Exit`);
    console.log('==========================================================');
}

async function menu() {
    const all = CONFIG.scripts.length + 1;
    const exit = CONFIG.scripts.length + 2;
    let anyFailed = false;

    writeLog('Main started (menu).');

    for (;;) {
        printMenu();
        const answer = await ask(`Choose 1-${exit}: `);
        const number = Number(answer);

        if (!Number.isInteger(number) || number < 1 || number > exit) {
            console.log(`"${answer}" is not a choice. Type a number from 1 to ${exit}.`);
            continue;
        }

        if (number === exit) {
            writeLog('Choice: Exit');
            break;
        }

        const chosen = number === all ? CONFIG.scripts : [CONFIG.scripts[number - 1]];
        writeLog(`Choice: ${number === all ? 'Run all one by one' : chosen[0].name}`);

        if (await runScripts(chosen)) anyFailed = true;
    }

    writeLog('Main closed.');
    if (anyFailed) process.exitCode = 1;
}

/** Without the menu: node Main.js creo reset sign   (or: node Main.js all) */
async function fromCommandLine(args) {
    const wanted = args.map(a => a.toLowerCase());
    const unknown = wanted.filter(w => w !== 'all' && !CONFIG.scripts.some(s => s.key === w));

    if (unknown.length) {
        writeLog(`ERROR: unknown script: ${unknown.join(', ')}. Use: ${CONFIG.scripts.map(s => s.key).join(', ')}, all`);
        process.exitCode = 1;
        return;
    }

    // keep the order of CONFIG.scripts, not the order of the command line
    const chosen = wanted.includes('all') ? CONFIG.scripts : CONFIG.scripts.filter(s => wanted.includes(s.key));

    writeLog(`Main started (command line: ${args.join(' ')}).`);
    if (await runScripts(chosen)) process.exitCode = 1;
    writeLog('Main closed.');
}

// ---------- main ----------
const args = process.argv.slice(2);

(args.length ? fromCommandLine(args) : menu()).catch(error => {
    writeLog(`ERROR: ${error.message}`);
    process.exitCode = 1;
});