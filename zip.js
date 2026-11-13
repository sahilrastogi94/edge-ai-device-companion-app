// What the page needs of zip files, with nothing but the browser: a folder chosen on the computer packed as a zip (stored, not compressed: the USB
// link is fast and most of an app is already small), and a look at the app.yaml inside a zip, to say what is about to be installed.
"use strict";

const SKIPPED_IN_FOLDERS = /(^|\/)(__pycache__|\.git|\.DS_Store|Thumbs\.db)(\/|$)/;

// files: [{ name, bytes }], name with / between folders.
function storedZip(files) {
    const encoder = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const put16 = (view, at, v) => view.setUint16(at, v, true);
    const put32 = (view, at, v) => view.setUint32(at, v, true);
    for (const file of files) {
        const name = encoder.encode(file.name), crc = crc32(file.bytes), size = file.bytes.length;
        const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
        put32(l, 0, 0x04034b50);
        put16(l, 4, 20);
        put16(l, 6, 0x0800);    // names are UTF-8
        put32(l, 14, crc);
        put32(l, 18, size);
        put32(l, 22, size);
        put16(l, 26, name.length);
        local.set(name, 30);
        const entry = new Uint8Array(46 + name.length), c = new DataView(entry.buffer);
        put32(c, 0, 0x02014b50);
        put16(c, 4, 20);
        put16(c, 6, 20);
        put16(c, 8, 0x0800);
        put32(c, 16, crc);
        put32(c, 20, size);
        put32(c, 24, size);
        put16(c, 28, name.length);
        put32(c, 42, offset);
        entry.set(name, 46);
        parts.push(local, file.bytes);
        central.push(entry);
        offset += local.length + size;
    }
    const centralSize = central.reduce((sum, e) => sum + e.length, 0);
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    put32(e, 0, 0x06054b50);
    put16(e, 8, files.length);
    put16(e, 10, files.length);
    put32(e, 12, centralSize);
    put32(e, 16, offset);
    const out = new Uint8Array(offset + centralSize + 22);
    let at = 0;
    for (const part of parts.concat(central, [end])) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

// The folder a person chose (an <input webkitdirectory>'s files), as a zip, and what its app.yaml says.
async function zipOfFolder(fileList) {
    const files = [];
    for (const file of fileList) {
        const path = file.webkitRelativePath || file.name;
        const name = path.split("/").slice(1).join("/") || path;
        if (!SKIPPED_IN_FOLDERS.test(name)) files.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    const yaml = files.find((f) => f.name === "app.yaml");
    return { bytes: storedZip(files), count: files.length, yaml: yaml ? new TextDecoder().decode(yaml.bytes) : null };
}

// The text of the app.yaml at the top of a zip, or inside its one folder; null if there is none or it can't be read.
async function appYamlInZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) return null;
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true), best = null;
    for (let i = 0; i < count && at + 46 <= bytes.length; i++) {
        if (view.getUint32(at, true) !== 0x02014b50) return null;
        const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
        const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
        if (/^([^/]+\/)?app\.yaml$/.test(name) && (!best || name.length < best.name.length)) {
            best = { name, method: view.getUint16(at + 10, true), size: view.getUint32(at + 20, true), offset: view.getUint32(at + 42, true) };
        }
        at += 46 + nameLength + extra + comment;
    }
    if (!best) return null;
    const start = best.offset + 30 + view.getUint16(best.offset + 26, true) + view.getUint16(best.offset + 28, true);
    const data = bytes.subarray(start, start + best.size);
    if (best.method === 0) return new TextDecoder().decode(data);
    if (best.method !== 8 || typeof DecompressionStream === "undefined") return null;
    try {
        return await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    } catch (e) {
        return null;
    }
}

// id, name and version from app.yaml's text: the plain "key: value" lines at its top level.
function appYamlFields(text) {
    const value = (key) => {
        const m = text && text.match(new RegExp("^" + key + ":[ \\t]*(.*?)[ \\t]*\\r?$", "m"));
        return m ? m[1].replace(/^(['"])(.*)\1$/, "$2") : "";
    };
    return { id: value("id"), name: value("name"), version: value("version") };
}
