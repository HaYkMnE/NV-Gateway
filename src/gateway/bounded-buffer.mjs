const DEFAULT_MAX = 5 * 1024 * 1024;
const MIN_MAX = 1024;
const MAX_MAX = 32 * 1024 * 1024;

export function resolveMaxBufferedResponseBytes(env = process.env) {
    const raw = env.GATEWAY_MAX_BUFFERED_RESPONSE_BYTES;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return DEFAULT_MAX;
    const value = Number(raw);
    return value >= MIN_MAX && value <= MAX_MAX ? value : DEFAULT_MAX;
}

export function createBoundedBuffer(maxBytes) {
    let bytes = 0;
    let exceeded = false;
    const chunks = [];
    return {
        push(chunk) {
            if (exceeded) return false;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxBytes) { exceeded = true; return false; }
            chunks.push(buffer);
            return true;
        },
        toBuffer() {
            if (exceeded) throw new Error('Buffered response exceeded configured limit.');
            return Buffer.concat(chunks, bytes);
        }
    };
}
