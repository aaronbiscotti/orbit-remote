const test = require('node:test');
const assert = require('node:assert/strict');
const { writeProtocolFrame, FrameAccumulator } = require('../electron/protocol');

function encode(json, bin) {
  const writes = [];
  writeProtocolFrame({ destroyed: false, write: (b) => writes.push(Buffer.from(b)) }, json, bin);
  return { writes, all: Buffer.concat(writes) };
}

test('a message without binary is one write; a binary part is a second write', () => {
  assert.equal(encode({ type: 'mouse', x: 0.5 }).writes.length, 1);
  assert.equal(encode({ type: 'fs_upload' }, Buffer.from([1, 2, 3])).writes.length, 2);
});

test('messages survive any chunking and back-to-back delivery', () => {
  const a = encode({ type: 'frame', seq: 1 }, Buffer.alloc(40000, 7)).all;
  const b = encode({ type: 'hello', name: 'Zoë' }).all;
  const stream = Buffer.concat([a, b]);
  for (const size of [1, 7, 16384, stream.length]) {
    const got = [];
    const acc = new FrameAccumulator((json, bin) => got.push([json, bin.length]));
    for (let i = 0; i < stream.length; i += size) acc.push(stream.subarray(i, i + size));
    assert.deepEqual(got, [[{ type: 'frame', seq: 1 }, 40000], [{ type: 'hello', name: 'Zoë' }, 0]]);
  }
});

test('a bad header is dropped instead of buffered', () => {
  const got = [];
  const acc = new FrameAccumulator((json) => got.push(json));
  const bad = Buffer.alloc(8);
  bad.writeInt32BE(-1, 0);
  acc.push(bad);
  acc.push(encode({ ok: true }).all);
  assert.deepEqual(got, [{ ok: true }]);
  assert.equal(acc.totalLength, 0);
});
