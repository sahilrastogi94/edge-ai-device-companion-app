// The page's end of the board's USB serial port: maixcam/system/usb_link/usb_link.c describes the packets. No page in here, so AMS can take this file as it is.
"use strict";

const HEAD = 8;
const MAX_PACKET = 1024 * 1024;
const T = {
    HELLO: 1, LIST: 2, PUT_BEGIN: 3, PUT_DATA: 4, PUT_END: 5, PUT_ABORT: 6, MIRROR: 7, SPEED: 8,
    OK: 0x80, ERR: 0x81, FRAME: 0x90, SPEED_DATA: 0x91,
};
const KIND = { PROGRAM: 1, APP: 2 };
const MIRROR = { OFF: 0, HALF: 1, FULL: 2 };
const BOARD_USB_VENDOR = 0x359f;       // Sipeed's, as the board reports it
const LEASE_RENEW_MS = 2000;           // the board stops the mirror by itself 6 s after the last request

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[i] = c >>> 0;
}

function crc32(bytes, from = 0, to = bytes.length) {
    let c = 0xffffffff;
    for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function u32(value) {
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
}

class UsbLink {
    constructor(port) {
        this.port = port;
        this.buf = new Uint8Array(256 * 1024);
        this.len = 0;
        this.seq = 0;
        this.pending = new Map();
        this.open_ = false;
        this.mirrorMode = MIRROR.OFF;
        this.leaseTimer = null;
        this.onFrame = null;        // (Uint8Array jpeg)
        this.onClose = null;        // (Error or null): the port has gone
        this.bytesIn = 0;
        this.speed = null;
        this.info = null;
    }

    // Opens the port. The baud rate is only a number here: nothing on the board is a real UART, so it doesn't set the speed.
    async open(baudRate = 115200) {
        await this.port.open({ baudRate, bufferSize: 256 * 1024 });
        this.open_ = true;
        this.writer = this.port.writable.getWriter();
        this.loop = this.readLoop();
    }

    async readLoop() {
        let error = null;
        while (this.open_ && this.port.readable) {
            this.reader = this.port.readable.getReader();
            try {
                for (;;) {
                    const { value, done } = await this.reader.read();
                    if (done) break;
                    if (value && value.length) this.feed(value);
                }
            } catch (e) {
                error = e;      // a lost device: port.readable is null next time round. Anything else: read on
            } finally {
                this.reader.releaseLock();
                this.reader = null;
            }
        }
        const wasOpen = this.open_;
        this.open_ = false;
        this.stopLease();
        this.failAll(new Error("The USB link has gone"));
        if (wasOpen && this.onClose) this.onClose(error);
    }

    feed(chunk) {
        this.bytesIn += chunk.length;
        if (this.len + chunk.length > this.buf.length) {
            const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
            bigger.set(this.buf.subarray(0, this.len));
            this.buf = bigger;
        }
        this.buf.set(chunk, this.len);
        this.len += chunk.length;
        const b = this.buf;
        let at = 0;
        while (this.len - at >= HEAD) {
            if (b[at] !== 0x4d || b[at + 1] !== 0x58 || (b[at] ^ b[at + 1] ^ b[at + 2] ^ b[at + 3] ^ b[at + 4] ^ b[at + 5] ^ b[at + 6]) !== b[at + 7]) {
                at++;
                continue;
            }
            const n = b[at + 4] | (b[at + 5] << 8) | (b[at + 6] << 16);
            if (n > MAX_PACKET) {
                at++;
                continue;
            }
            if (this.len - at < HEAD + n + 4) break;
            const end = at + HEAD + n;
            const want = (b[end] | (b[end + 1] << 8) | (b[end + 2] << 16) | (b[end + 3] << 24)) >>> 0;
            if (crc32(b, at + 2, end) !== want) {   // the rest of a frame for someone who left, and so on
                at++;
                continue;
            }
            this.deliver(b[at + 2], b[at + 3], b.slice(at + HEAD, end));
            at = end + 4;
        }
        if (at) {
            b.copyWithin(0, at, this.len);
            this.len -= at;
        }
    }

    deliver(type, seq, payload) {
        if (type === T.FRAME) {
            if (this.onFrame && this.mirrorMode !== MIRROR.OFF) this.onFrame(payload);
        } else if (type === T.SPEED_DATA) {
            if (this.speed) {
                this.speed.got += payload.length;
                if (this.speed.got >= this.speed.total) this.speed.done();
            }
        } else if (type === T.OK || type === T.ERR) {
            const waiting = this.pending.get(seq);
            if (!waiting) return;
            this.pending.delete(seq);
            clearTimeout(waiting.timer);
            const text = new TextDecoder().decode(payload);
            if (type === T.OK) waiting.resolve(text);
            else waiting.reject(new Error(text));
        }
    }

    failAll(error) {
        for (const waiting of this.pending.values()) {
            clearTimeout(waiting.timer);
            waiting.reject(error);
        }
        this.pending.clear();
    }

    packet(type, seq, payload) {
        const n = payload.length, p = new Uint8Array(HEAD + n + 4);
        p.set([0x4d, 0x58, type, seq, n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);
        p[7] = p[0] ^ p[1] ^ p[2] ^ p[3] ^ p[4] ^ p[5] ^ p[6];
        p.set(payload, HEAD);
        p.set(u32(crc32(p, 2, HEAD + n)), HEAD + n);
        return p;
    }

    request(type, payload = new Uint8Array(0), timeoutMs = 3000) {
        if (!this.open_) return Promise.reject(new Error("Not connected"));
        const seq = (this.seq = (this.seq + 1) & 0xff);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq);
                reject(new Error("The board didn't answer"));
            }, timeoutMs);
            this.pending.set(seq, { resolve, reject, timer });
            this.writer.write(this.packet(type, seq, payload)).catch((e) => {
                this.pending.delete(seq);
                clearTimeout(timer);
                reject(e);
            });
        });
    }

    // Whoever has just opened the port may find the end of what was going out to someone else, and half a request of theirs may be waiting at
    // the other end, so this asks until it is answered. What it hears counts as the start of a new session on the board: mirror and uploads stop.
    // It carries this computer's clock, which the board takes if its own is more than a minute off: with no Wi-Fi it starts at 1 January 1970.
    async hello(tries = 6) {
        let last = null;
        for (let i = 0; i < tries; i++) {
            this.len = 0;
            const now = Date.now();
            try {
                this.info = JSON.parse(await this.request(T.HELLO, new Uint8Array(u32(now % 0x100000000).concat(u32(Math.floor(now / 0x100000000)))), 1000));
                this.mirrorMode = MIRROR.OFF;
                this.stopLease();
                return this.info;
            } catch (e) {
                last = e;
            }
        }
        throw last;
    }

    async list(what) {
        return JSON.parse(await this.request(T.LIST, new TextEncoder().encode(what)));
    }

    // bytes: Uint8Array. onProgress(sent, total). isCancelled(): checked between chunks. The answer is a sentence to show.
    // The board ends the mirror when this starts: the caller turns it on again afterwards.
    async upload(kind, name, bytes, onProgress, isCancelled) {
        const nameBytes = new TextEncoder().encode(name);
        const begin = new Uint8Array(9 + nameBytes.length);
        begin[0] = kind;
        begin.set(u32(bytes.length), 1);
        begin.set(u32(crc32(bytes)), 5);
        begin.set(nameBytes, 9);
        this.setMirrorMode(MIRROR.OFF);
        await this.request(T.PUT_BEGIN, begin, 5000);
        const chunk = (this.info && this.info.chunk) || 32768;
        try {
            for (let at = 0; at < bytes.length; at += chunk) {
                if (isCancelled && isCancelled()) throw new Error("Cancelled");
                await this.request(T.PUT_DATA, bytes.subarray(at, Math.min(at + chunk, bytes.length)), 8000);
                if (onProgress) onProgress(Math.min(at + chunk, bytes.length), bytes.length);
            }
        } catch (e) {
            await this.request(T.PUT_ABORT, new Uint8Array(0), 2000).catch(() => {});
            throw e;
        }
        return this.request(T.PUT_END, new Uint8Array(0), kind === KIND.APP ? 130000 : 15000);
    }

    setMirrorMode(mode) {
        this.mirrorMode = mode;
        this.stopLease();
    }

    stopLease() {
        clearInterval(this.leaseTimer);
        this.leaseTimer = null;
    }

    // MIRROR.HALF or FULL to start or change size, OFF to stop. Frames go to onFrame, and only when the picture changes (every 2 s at least).
    async mirror(mode) {
        await this.request(T.MIRROR, new Uint8Array([mode]));
        this.setMirrorMode(mode);
        if (mode !== MIRROR.OFF) {
            this.leaseTimer = setInterval(() => {
                this.request(T.MIRROR, new Uint8Array([mode])).catch(() => {});
            }, LEASE_RENEW_MS);
        }
    }

    // How fast the board can send: { bytes, seconds }.
    speedTest(total = 4 * 1024 * 1024) {
        return new Promise((resolve, reject) => {
            const start = performance.now();
            const timer = setTimeout(() => {
                this.speed = null;
                reject(new Error("The board stopped sending"));
            }, 60000);
            this.speed = {
                got: 0, total,
                done: () => {
                    clearTimeout(timer);
                    this.speed = null;
                    resolve({ bytes: total, seconds: (performance.now() - start) / 1000 });
                },
            };
            this.setMirrorMode(MIRROR.OFF);
            this.request(T.SPEED, new Uint8Array(u32(total))).catch((e) => {
                clearTimeout(timer);
                this.speed = null;
                reject(e);
            });
        });
    }

    async close() {
        const wasOpen = this.open_;
        this.stopLease();
        if (wasOpen && this.mirrorMode !== MIRROR.OFF) await this.request(T.MIRROR, new Uint8Array([MIRROR.OFF]), 500).catch(() => {});
        this.open_ = false;
        if (this.reader) await this.reader.cancel().catch(() => {});
        if (this.loop) await this.loop;
        if (this.writer) {
            this.writer.releaseLock();
            this.writer = null;
        }
        await this.port.close().catch(() => {});
    }
}
