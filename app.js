// The test page: connect, Screen Mirror, upload a program, install an app. usb_link.js talks to the board; this is only the page.
"use strict";

const $ = (id) => document.getElementById(id);
const PROGRAM_NAME = /^[a-z0-9_-]{1,24}$/;
let link = null;
let wanted = false;         // the person wants to be connected: come back if the USB lead does
let busy = false;           // an upload or a speed test is going on
let cancelUpload = false;
let programs = [], apps = [];
let programFile = null;
let app = null;             // { bytes, label, fields }
let mirrorWanted = MIRROR.OFF;
let drawing = false, frames = 0, lastStats = 0, lastBytes = 0;

function log(text, kind = "") {
    const line = document.createElement("li");
    line.className = kind;
    line.textContent = new Date().toLocaleTimeString() + "  " + text;
    $("log").prepend(line);
    while ($("log").children.length > 60) $("log").lastChild.remove();
}

function megabytes(n) {
    return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
}

function connected() {
    return link !== null && link.info !== null;
}

function refreshButtons() {
    const on = connected();
    $("connect").textContent = on ? "Disconnect" : "Connect";
    $("status").textContent = on ? "Connected to the board, " + megabytes(link.info.free) + " free" : link ? "Connecting..." : "Not connected";
    $("status").dataset.on = on;
    $("baud").disabled = link !== null;
    $("mirrorToggle").disabled = !on || busy;
    $("mirrorToggle").textContent = mirrorWanted === MIRROR.OFF ? "Start mirror" : "Stop mirror";
    for (const r of document.querySelectorAll("input[name=size]")) r.disabled = !on || busy;
    $("programUpload").disabled = !on || busy || !programFile || !PROGRAM_NAME.test($("programName").value);
    $("appInstall").disabled = !on || busy || !app;
    $("speedTest").disabled = !on || busy;
    $("refresh").disabled = !on || busy;
    for (const b of document.querySelectorAll(".cancel")) b.hidden = !busy;
}

// ------------------------------------------------------------------------------------------------------- connecting
async function connect(port) {
    link = new UsbLink(port);
    link.onFrame = drawFrame;
    link.onClose = lost;
    refreshButtons();
    try {
        await link.open(Number($("baud").value));
    } catch (e) {
        log("The port wouldn't open. Is another tab or program using it? (" + e.message + ")", "bad");
        link = null;
        wanted = false;
        refreshButtons();
        return;
    }
    try {
        await link.hello();
    } catch (e) {
        log("Nothing on this port answered. Is usb_link on this board? (" + e.message + ")", "bad");
        await link.close();
        link = null;
        wanted = false;
        refreshButtons();
        return;
    }
    log("Connected to the board");
    refreshButtons();
    await refreshLists();
    if (mirrorWanted !== MIRROR.OFF) await startMirror();
}

function lost(error) {
    log("The USB link has gone" + (error ? " (" + error.message + ")" : ""), "bad");
    link = null;
    busy = false;
    $("mirrorNote").textContent = "";
    refreshButtons();
}

async function pressConnect() {
    if (link) {
        wanted = false;
        const old = link;
        link = null;
        old.onClose = null;
        await old.close();
        mirrorWanted = MIRROR.OFF;
        log("Disconnected");
        refreshButtons();
        return;
    }
    try {
        const port = await navigator.serial.requestPort({ filters: [{ usbVendorId: BOARD_USB_VENDOR }] });
        wanted = true;
        await connect(port);
    } catch (e) {
        if (e.name !== "NotFoundError") log(e.message, "bad");   // NotFoundError: the person closed the chooser
    }
}

async function reconnectIfGranted() {
    const ports = (await navigator.serial.getPorts()).filter((p) => p.getInfo().usbVendorId === BOARD_USB_VENDOR);
    if (ports.length && !link) {
        wanted = true;
        await connect(ports[0]);
    }
}

// ------------------------------------------------------------------------------------------------------ Screen Mirror
function chosenSize() {
    return document.querySelector("input[name=size]:checked").value === "full" ? MIRROR.FULL : MIRROR.HALF;
}

async function startMirror() {
    mirrorWanted = chosenSize();
    lastStats = performance.now();
    lastBytes = link.bytesIn;
    frames = 0;
    try {
        await link.mirror(mirrorWanted);
        $("screen").classList.add("live");
    } catch (e) {
        log("The mirror wouldn't start: " + e.message, "bad");
        mirrorWanted = MIRROR.OFF;
    }
    refreshButtons();
}

async function stopMirror() {
    mirrorWanted = MIRROR.OFF;
    $("screen").classList.remove("live");
    $("mirrorStats").textContent = "";
    if (connected()) await link.mirror(MIRROR.OFF).catch(() => {});
    refreshButtons();
}

async function drawFrame(jpeg) {
    frames++;
    if (drawing) return;    // a slow screen misses frames rather than falling behind
    drawing = true;
    try {
        const picture = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
        const canvas = $("screen");
        // The panel stands portrait, and frames come as it does: a quarter turn to the screen as people see it.
        if (canvas.width !== picture.height || canvas.height !== picture.width) {
            canvas.width = picture.height;
            canvas.height = picture.width;
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(0, 1, -1, 0, canvas.width, 0);
        ctx.drawImage(picture, 0, 0);
        picture.close();
        $("screenEmpty").hidden = true;
    } catch (e) {
        log("A frame couldn't be drawn: " + e.message, "bad");
    }
    drawing = false;
}

setInterval(() => {
    if (!connected() || mirrorWanted === MIRROR.OFF || busy) return;
    const now = performance.now(), seconds = (now - lastStats) / 1000;
    if (seconds < 1) return;
    $("mirrorStats").textContent = (frames / seconds).toFixed(1) + " frames a second, " + Math.round((link.bytesIn - lastBytes) / 1024 / seconds) + " KB/s";
    frames = 0;
    lastStats = now;
    lastBytes = link.bytesIn;
}, 1000);

// While something else needs the link, as the board's mirror stops for an upload. Afterwards, the mirror comes back if it was on.
async function withLink(work) {
    if (busy || !connected()) return;
    const mirrorWas = mirrorWanted;
    busy = true;
    cancelUpload = false;
    if (mirrorWas !== MIRROR.OFF) $("mirrorNote").textContent = "Paused while the upload runs";
    refreshButtons();
    try {
        await work();
    } catch (e) {
        log(e.message, "bad");
    }
    busy = false;
    $("mirrorNote").textContent = "";
    refreshButtons();
    if (connected()) {
        await refreshLists();
        if (mirrorWas !== MIRROR.OFF) await startMirror();
    }
}

function showProgress(barId, sent, total, startedAt) {
    const seconds = (performance.now() - startedAt) / 1000;
    $(barId).hidden = false;
    $(barId).value = sent / total;
    const rate = seconds > 0.05 ? ", " + megabytes(sent / seconds) + "/s" : "";
    $(barId + "Text").textContent = megabytes(sent) + " of " + megabytes(total) + rate;
}

// ----------------------------------------------------------------------------------------------------------- programs
function nameFromFile(fileName) {
    return fileName.replace(/\.py$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 24);
}

function programChosen() {
    programFile = $("programFile").files[0] || null;
    if (programFile) $("programName").value = nameFromFile(programFile.name);
    programNameChanged();
}

function programNameChanged() {
    const name = $("programName").value;
    const hint = $("programHint");
    if (!programFile) {
        hint.textContent = "";
    } else if (!PROGRAM_NAME.test(name)) {
        hint.textContent = "A name is a-z, 0-9, _ and -, up to 24 of them.";
        hint.className = "hint bad";
    } else if (programs.some((p) => p.name === name)) {
        hint.textContent = "This will replace the program of that name on the board.";
        hint.className = "hint warn";
    } else {
        hint.textContent = megabytes(programFile.size) + ", a new program.";
        hint.className = "hint";
    }
    refreshButtons();
}

async function uploadProgram() {
    const name = $("programName").value;
    if (programs.some((p) => p.name === name) && !confirm("Replace " + name + " on the board?")) return;
    await withLink(async () => {
        const bytes = new Uint8Array(await programFile.arrayBuffer()), started = performance.now();
        const answer = await link.upload(KIND.PROGRAM, name, bytes, (sent, total) => showProgress("programBar", sent, total, started), () => cancelUpload);
        log(answer + " (" + ((performance.now() - started) / 1000).toFixed(2) + " s)", "good");
    });
    $("programBar").hidden = true;
    $("programBarText").textContent = "";
    programNameChanged();
}

// --------------------------------------------------------------------------------------------------------------- apps
function describeApp() {
    const hint = $("appHint");
    if (!app) {
        hint.textContent = "";
    } else if (!app.fields.id) {
        hint.textContent = app.label + ": no app.yaml with an id found. The board will check it too.";
        hint.className = "hint warn";
    } else {
        const here = apps.find((a) => a.id === app.fields.id);
        hint.textContent = (app.fields.name || app.fields.id) + " (" + app.fields.id + (app.fields.version ? ", " + app.fields.version : "") + "), " + megabytes(app.bytes.length) +
            (here ? ". This will replace the one on the board." : ", a new app.");
        hint.className = here ? "hint warn" : "hint";
    }
    refreshButtons();
}

async function appZipChosen() {
    const file = $("appZip").files[0];
    $("appFolder").value = "";
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    app = { bytes, label: file.name, fields: appYamlFields(await appYamlInZip(bytes)) };
    describeApp();
}

async function appFolderChosen() {
    const list = $("appFolder").files;
    $("appZip").value = "";
    if (!list.length) return;
    const packed = await zipOfFolder(list);
    app = { bytes: packed.bytes, label: packed.count + " files", fields: appYamlFields(packed.yaml) };
    describeApp();
}

async function installApp() {
    const here = app.fields.id && apps.find((a) => a.id === app.fields.id);
    if (here && !confirm("Replace " + (here.name || here.id) + " on the board?")) return;
    await withLink(async () => {
        const started = performance.now();
        const answer = await link.upload(KIND.APP, app.label.slice(0, 24), app.bytes, (sent, total) => {
            showProgress("appBar", sent, total, started);
            if (sent === total) $("appBarText").textContent = "Installing on the board...";
        }, () => cancelUpload);
        log(answer + " (" + ((performance.now() - started) / 1000).toFixed(1) + " s)", "good");
    });
    $("appBar").hidden = true;
    $("appBarText").textContent = "";
    describeApp();
}

// -------------------------------------------------------------------------------------------------------------- lists
function fillList(id, rows) {
    const list = $(id);
    list.replaceChildren();
    for (const [main, side] of rows) {
        const row = document.createElement("li"), name = document.createElement("span"), more = document.createElement("span");
        name.textContent = main;
        more.textContent = side;
        more.className = "side";
        row.append(name, more);
        list.append(row);
    }
    if (!rows.length) {
        const row = document.createElement("li");
        row.textContent = "None";
        row.className = "side";
        list.append(row);
    }
}

async function refreshLists() {
    try {
        programs = (await link.list("programs")).sort((a, b) => b.time - a.time);
        apps = (await link.list("apps")).sort((a, b) => (a.name > b.name ? 1 : -1));
    } catch (e) {
        log("The lists didn't come: " + e.message, "bad");
        return;
    }
    fillList("programList", programs.map((p) => [p.name, megabytes(p.size) + ", " + new Date(p.time * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })]));
    fillList("appList", apps.map((a) => [a.name, a.id + (a.version ? ", " + a.version : "")]));
    programNameChanged();
    describeApp();
}

// ------------------------------------------------------------------------------------------------------------- speed
async function speedTest() {
    await withLink(async () => {
        const r = await link.speedTest();
        const rate = r.bytes / r.seconds / 1024 / 1024;
        $("speedResult").textContent = rate.toFixed(1) + " MB/s from the board at baud setting " + $("baud").value + ". The mirror needs about 0.2 MB/s at full size.";
        log("Speed: " + rate.toFixed(1) + " MB/s from the board", "good");
    });
}

// ---------------------------------------------------------------------------------------------------------------- start
function start() {
    if (!("serial" in navigator)) {
        $("unsupported").hidden = false;
        $("connect").disabled = true;
        return;
    }
    $("connect").addEventListener("click", pressConnect);
    $("mirrorToggle").addEventListener("click", () => (mirrorWanted === MIRROR.OFF ? startMirror() : stopMirror()));
    for (const r of document.querySelectorAll("input[name=size]")) {
        r.addEventListener("change", () => {
            if (mirrorWanted !== MIRROR.OFF) startMirror();
        });
    }
    $("programFile").addEventListener("change", programChosen);
    $("programName").addEventListener("input", programNameChanged);
    $("programUpload").addEventListener("click", uploadProgram);
    $("appZip").addEventListener("change", appZipChosen);
    $("appFolder").addEventListener("change", appFolderChosen);
    $("appInstall").addEventListener("click", installApp);
    $("speedTest").addEventListener("click", speedTest);
    $("refresh").addEventListener("click", refreshLists);
    for (const b of document.querySelectorAll(".cancel")) b.addEventListener("click", () => { cancelUpload = true; });
    navigator.serial.addEventListener("connect", () => {
        if (wanted) setTimeout(reconnectIfGranted, 500);
    });
    refreshButtons();
    reconnectIfGranted().catch((e) => log(e.message, "bad"));
}

start();
