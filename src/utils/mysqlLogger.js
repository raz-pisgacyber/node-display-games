const formatValueType = (value) => {
  if (value === null) {
    return [null, 'null'];
  }
  if (value instanceof Date) {
    return [value.toISOString(), 'date'];
  }
  return [value, typeof value];
};

function logSqlExecution(sql, params = []) {
  const formatted = params.map(formatValueType);
  console.log('Executing SQL', sql, formatted);
}

async function runWithLogging(target, method, sql, params = []) {
  logSqlExecution(sql, params);
  try {
    return await target[method](sql, params);
  } catch (error) {
    error.sql = sql;
    error.sqlParams = params;
    console.error('SQL error', sql, params.map(formatValueType), error.message);
    throw error;
  }
}

function executeWithLogging(target, sql, params = []) {
  return runWithLogging(target, 'execute', sql, params);
}

function queryWithLogging(target, sql, params = []) {
  return runWithLogging(target, 'query', sql, params);
}

module.exports = {
  executeWithLogging,
  queryWithLogging,
  logSqlExecution,
};
