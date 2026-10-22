// Shim para discos exFAT/FAT32 no Windows: fs.readlink em um arquivo comum retorna EISDIR
// (no NTFS retorna EINVAL, que é o que webpack/Next esperam para "não é symlink").
// Converte somente esse caso; qualquer outro erro passa intacto.
const fs = require('node:fs');

function normalize(err) {
  if (err && err.code === 'EISDIR' && err.syscall === 'readlink') {
    err.code = 'EINVAL';
    err.errno = -4071;
    err.message = err.message.replace('EISDIR: illegal operation on a directory', 'EINVAL: invalid argument');
  }
  return err;
}

const origSync = fs.readlinkSync;
fs.readlinkSync = function readlinkSync(...args) {
  try {
    return origSync.apply(this, args);
  } catch (e) {
    throw normalize(e);
  }
};

const origCb = fs.readlink;
fs.readlink = function readlink(...args) {
  const cb = args[args.length - 1];
  if (typeof cb !== 'function') return origCb.apply(this, args);
  args[args.length - 1] = (err, ...rest) => cb(normalize(err), ...rest);
  return origCb.apply(this, args);
};

const origPromise = fs.promises.readlink;
fs.promises.readlink = function readlink(...args) {
  return origPromise.apply(this, args).catch((e) => {
    throw normalize(e);
  });
};
