const crypto = require('crypto');
const stableStringify = require('./stableStringify');

function metaHash(meta = {}) {
  const stable = stableStringify(meta);
  return crypto.createHash('sha1').update(stable).digest('hex');
}

module.exports = metaHash;
