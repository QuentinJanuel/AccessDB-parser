const assert = require("assert");
const { parseType, DataType } = require("../lib");
const { readActiveTablePages } = require("../lib/src/usage-map");

function float64LE(value) {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, true);
  return new Uint8Array(buffer);
}

// Both data pages claim the table as owner, but only page 4 is allocated to it.
// The map lives in row 1 to exercise the preceding row as the record boundary.
function activePageFixture(version, mapType) {
  const pageSize = version === 3 ? 2048 : 4096;
  const bytes = new Uint8Array(pageSize * 6);
  const view = new DataView(bytes.buffer);
  for (const page of [1, 3, 4]) {
    bytes[page * pageSize] = 1;
    bytes[page * pageSize + 1] = 1;
  }
  view.setUint32(3 * pageSize + 4, 2, true);
  view.setUint32(4 * pageSize + 4, 2, true);
  const countOffset = pageSize + (version === 3 ? 8 : 12);
  const mapLength = mapType === 0 ? 6 : 9;
  const mapStart = pageSize - 1 - mapLength;
  view.setUint16(countOffset, 2, true);
  view.setUint16(countOffset + 2, pageSize - 1, true);
  view.setUint16(countOffset + 4, mapStart, true);
  const mapOffset = pageSize + mapStart;
  bytes[mapOffset] = mapType;
  if (mapType === 0) {
    view.setUint32(mapOffset + 1, 3, true);
    bytes[mapOffset + 5] = 0b10;
  } else {
    view.setUint32(mapOffset + 1, 5, true);
    bytes[5 * pageSize] = 5;
    bytes[5 * pageSize + 4] = 0b10000;
  }
  return { bytes, view, pageSize, mapOffset };
}

function run() {
  const start = parseType(DataType.DateTime, float64LE(0));
  assert.strictEqual(start, "1899-12-30T00:00:00.000Z");

  const withTime = parseType(DataType.DateTime, float64LE(2.25));
  assert.strictEqual(withTime, "1900-01-01T06:00:00.000Z");

  for (const version of [3, 4]) {
    for (const mapType of [0, 1]) {
      const { bytes, view, pageSize, mapOffset } = activePageFixture(version, mapType);
      const read = () => readActiveTablePages(bytes, pageSize, version, 2, 0x101);
      const pages = read();
      assert.strictEqual(pages.length, 1);
      assert.strictEqual(pages[0].byteOffset, 4 * pageSize);
      assert.throws(() => readActiveTablePages(bytes, pageSize, version, 2, 0), /pointer/);
      view.setUint32(4 * pageSize + 4, 7, true);
      assert.throws(read, /belongs to table 7/);
      view.setUint32(4 * pageSize + 4, 2, true);
      if (mapType === 0) {
        bytes[mapOffset + 5] = 0b10000000;
        assert.throws(read, /missing page 10/);
        bytes[mapOffset + 5] = 0;
      } else {
        bytes[5 * pageSize] = 1;
        assert.throws(read, /bitmap page 5 has invalid type/);
        bytes[5 * pageSize] = 5;
        view.setUint32(mapOffset + 1, 6, true);
        assert.throws(read, /missing page 6/);
        view.setUint32(mapOffset + 1, 0, true);
      }
      assert.deepStrictEqual(read(), []);
      bytes[mapOffset] = 2;
      assert.throws(read, /Unsupported usage map type 2/);
    }
  }

  console.log("regression tests passed");
}

run();
