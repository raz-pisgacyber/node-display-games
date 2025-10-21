const { v4: uuidv4 } = require('uuid');

function extractNode(recordNode) {
  if (!recordNode) return null;
  const properties = recordNode.properties || {};
  const meta = properties.meta || {};
  const lastModified = properties.last_modified;
  return {
    id: properties.id,
    label: properties.label || '',
    content: properties.content || '',
    meta,
    last_modified: formatNeo4jDate(lastModified),
    version_id: properties.version_id,
  };
}

function formatNeo4jDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.toString) {
    return value.toString();
  }
  return new Date().toISOString();
}

function validateRelationshipType(type) {
  if (!type) return 'LINKS_TO';
  const valid = type.toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(valid)) {
    throw new Error('Invalid relationship type.');
  }
  return valid;
}

function newVersionMeta() {
  return {
    versionId: uuidv4(),
    lastModified: new Date().toISOString(),
  };
}

module.exports = {
  extractNode,
  formatNeo4jDate,
  validateRelationshipType,
  newVersionMeta,
};
