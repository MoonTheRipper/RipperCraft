// Builds zip archives in memory, byte by byte, for tests of what the dashboard
// does with one. A real zip tool only writes honest, well-formed archives; the
// ones that matter here are the others - a link where a file should be, a
// header that lies about a size, a path that climbs out of the folder.
//
//   buildZip([
//     { name: "world/" },
//     { name: "world/level.dat", data: "contents" },
//     { name: "world/link", symlink: "/etc" }
//   ])
//
// Each entry may set:
//   data            a string or Buffer (default: empty)
//   method          "deflate" (default when there is data) or "store"
//   symlink         a target path: the entry becomes a symbolic link to it
//   mode            the Unix mode, type bits included (default: file or folder)
//   madeBy          "version made by" (default 0x031e: Unix, zip 3.0)
//   declaredSize    the unpacked size to write in the headers, when lying
//   declaredCrc     the checksum to write in the headers, when lying
//   methodNumber    the compression method to write, whatever was really used
//   flags           extra general-purpose flag bits
//   localName       a different name for the local header than the directory's
//   descriptor      true: sizes left out of the local header (flag bit 3)
//   zip64           "sizes" | "offset" | "all": move those fields into a ZIP64
//                   extra field, as an archive past 4 GB has them
//
// options.zip64End writes the ZIP64 end-of-archive record and locator, as an
// archive with more than 65,535 entries has them. options.comment appends an
// archive comment; options.disk sets the "number of this disk" field.
const zlib = require("node:zlib");

const UINT32_MAX = 0xffffffff;

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function buildZip(entries, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const isDirectory = entry.symlink === undefined && entry.name.endsWith("/");
    const data = Buffer.from(entry.symlink !== undefined ? entry.symlink : entry.data === undefined ? "" : entry.data);
    const deflate = entry.method ? entry.method === "deflate" : data.length > 0 && entry.symlink === undefined;
    const packed = deflate ? zlib.deflateRawSync(data) : data;
    const method = entry.methodNumber !== undefined ? entry.methodNumber : deflate ? 8 : 0;
    const crc = entry.declaredCrc !== undefined ? entry.declaredCrc : zlib.crc32(data);
    const size = entry.declaredSize !== undefined ? entry.declaredSize : data.length;
    const mode =
      entry.mode !== undefined ? entry.mode : entry.symlink !== undefined ? 0o120777 : isDirectory ? 0o040755 : 0o100644;
    const flags = 0x0800 | (entry.flags || 0) | (entry.descriptor ? 0x0008 : 0);
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName === undefined ? entry.name : entry.localName);

    locals.push(
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0x5a6f),
      u32(entry.descriptor ? 0 : crc),
      u32(entry.descriptor ? 0 : packed.length),
      u32(entry.descriptor ? 0 : size),
      u16(localName.length),
      u16(0),
      localName,
      packed
    );
    let localLength = 30 + localName.length + packed.length;
    if (entry.descriptor) {
      locals.push(u32(0x08074b50), u32(crc), u32(packed.length), u32(size));
      localLength += 16;
    }

    // ZIP64: the overflowing fields read 0xFFFFFFFF and the real values follow
    // in an extra field, in this order.
    const moved = entry.zip64 === "all" ? ["size", "packed", "offset"] : entry.zip64 === "sizes" ? ["size", "packed"] : entry.zip64 === "offset" ? ["offset"] : [];
    const values = { offset, packed: packed.length, size };
    const extraBody = Buffer.concat(moved.map((field) => u64(values[field])));
    const extra = moved.length ? Buffer.concat([u16(0x0001), u16(extraBody.length), extraBody]) : Buffer.alloc(0);

    centrals.push(
      u32(0x02014b50),
      u16(entry.madeBy === undefined ? 0x031e : entry.madeBy),
      u16(moved.length ? 45 : 20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0x5a6f),
      u32(crc),
      u32(moved.includes("packed") ? UINT32_MAX : packed.length),
      u32(moved.includes("size") ? UINT32_MAX : size),
      u16(name.length),
      u16(extra.length),
      u16(0),
      u16(0),
      u16(0),
      u32((mode << 16) | (isDirectory ? 0x10 : 0)),
      u32(moved.includes("offset") ? UINT32_MAX : offset),
      name,
      extra
    );
    offset += localLength;
  }

  const central = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment || "");
  const tail = [];
  if (options.zip64End) {
    tail.push(
      u32(0x06064b50),
      u64(44),
      u16(45),
      u16(45),
      u32(0),
      u32(0),
      u64(entries.length),
      u64(entries.length),
      u64(central.length),
      u64(offset),
      u32(0x07064b50),
      u32(0),
      u64(offset + central.length),
      u32(1)
    );
  }
  tail.push(
    u32(0x06054b50),
    u16(options.disk || 0),
    u16(0),
    u16(options.zip64End ? 0xffff : entries.length),
    u16(options.zip64End ? 0xffff : entries.length),
    u32(options.zip64End ? UINT32_MAX : central.length),
    u32(options.zip64End ? UINT32_MAX : offset),
    u16(comment.length),
    comment
  );

  return Buffer.concat([...locals, central, ...tail]);
}

module.exports = {
  buildZip
};
