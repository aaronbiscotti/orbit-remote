// Orbit's wire format: [int32 BE jsonLen][int32 BE binLen][JSON][binary].

function writeProtocolFrame(socket, jsonObj, binaryBuffer = null) {
  if (!socket || socket.destroyed) return;
  const json = JSON.stringify(jsonObj);
  const jsonLen = Buffer.byteLength(json);
  const bin = binaryBuffer ? (Buffer.isBuffer(binaryBuffer) ? binaryBuffer : Buffer.from(binaryBuffer)) : null;
  // Header and JSON in one write: a mouse move becomes one TLS record and one packet instead of two.
  const head = Buffer.allocUnsafe(8 + jsonLen);
  head.writeInt32BE(jsonLen, 0);
  head.writeInt32BE(bin ? bin.length : 0, 4);
  head.write(json, 8, 'utf8');
  socket.write(head);
  if (bin && bin.length > 0) socket.write(bin);
}

class FrameAccumulator {
  constructor(onFrame) {
    this.chunks = [];
    this.totalLength = 0;
    this.need = 8; // bytes needed before the next parse step
    this.onFrame = onFrame;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
    this.drain();
  }

  // Join the buffered pieces only once a whole message is here, not again on every 16 KB piece.
  drain() {
    while (this.totalLength >= this.need) {
      const combined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.totalLength);
      this.chunks = [combined];

      const jsonLen = combined.readInt32BE(0);
      const binLen = combined.readInt32BE(4);
      if (jsonLen <= 0 || jsonLen > 4 * 1024 * 1024 || binLen < 0 || binLen > 32 * 1024 * 1024) {
        this.chunks = [];
        this.totalLength = 0;
        this.need = 8;
        return;
      }

      const frameTotal = 8 + jsonLen + binLen;
      if (this.totalLength < frameTotal) {
        this.need = frameTotal;
        return;
      }

      const jsonSlice = combined.subarray(8, 8 + jsonLen);
      // Own copy, so IPC to the page never carries the neighbouring messages that share this buffer.
      const binSlice = binLen > 0 ? Buffer.from(combined.subarray(8 + jsonLen, frameTotal)) : Buffer.alloc(0);

      const remainder = combined.subarray(frameTotal);
      this.chunks = remainder.length > 0 ? [remainder] : [];
      this.totalLength = remainder.length;
      this.need = 8;

      try {
        this.onFrame(JSON.parse(jsonSlice.toString('utf8')), binSlice);
      } catch (error) {
        console.error('ORBIT_FRAME', error.message);
      }
    }
  }
}

module.exports = { writeProtocolFrame, FrameAccumulator };
