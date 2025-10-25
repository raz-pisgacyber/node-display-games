let workingMemorySnapshot = null;

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function getWorkingMemorySnapshot() {
  return workingMemorySnapshot;
}

function setWorkingMemorySnapshot(snapshot) {
  if (!isObject(snapshot)) {
    workingMemorySnapshot = null;
    return workingMemorySnapshot;
  }
  workingMemorySnapshot = snapshot;
  return workingMemorySnapshot;
}

function updateWorkingMemorySnapshot(updater) {
  if (typeof updater !== 'function') {
    throw new TypeError('updater must be a function');
  }
  const nextSnapshot = updater(workingMemorySnapshot);
  return setWorkingMemorySnapshot(nextSnapshot);
}

module.exports = {
  getWorkingMemorySnapshot,
  setWorkingMemorySnapshot,
  updateWorkingMemorySnapshot,
};
