const mysql = require('mysql2/promise');
const config = require('../config');

const pool = mysql.createPool(config.mysql);

async function closeMysql() {
  await pool.end();
}

module.exports = {
  pool,
  closeMysql,
};
