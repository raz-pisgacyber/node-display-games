const mysql = require('mysql2/promise');
const config = require('../config');
const { queryWithLogging, executeWithLogging } = require('../utils/mysqlLogger');

const pool = mysql.createPool(config.mysql);

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS node_versions (
    project_id VARCHAR(64) NOT NULL,
    node_id VARCHAR(64) NOT NULL,
    version_id VARCHAR(64) NOT NULL,
    last_modified DATETIME NOT NULL,
    meta_hash CHAR(40) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, node_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    active_node VARCHAR(64) NULL,
    last_sync DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sessions_project (project_id),
    INDEX idx_sessions_user_project (user_id, project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    session_id BIGINT NOT NULL,
    node_id VARCHAR(64) NULL,
    role VARCHAR(32) NOT NULL,
    message_type VARCHAR(32) NOT NULL DEFAULT 'user_reply',
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_messages_session (session_id),
    CONSTRAINT fk_messages_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS node_working_history (
    project_id VARCHAR(64) NOT NULL,
    node_id VARCHAR(64) NOT NULL,
    working_history TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, node_id)
  )`,
  `CREATE TABLE IF NOT EXISTS summaries (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    session_id BIGINT NOT NULL,
    summary_json JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_summaries_session (session_id),
    CONSTRAINT fk_summaries_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    project_id VARCHAR(64) NOT NULL,
    name VARCHAR(191) NOT NULL,
    json_snapshot LONGTEXT NOT NULL,
    checksum CHAR(40) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_checkpoints_project (project_id)
  )`,
  `CREATE TABLE IF NOT EXISTS working_memory_parts (
    session_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    part VARCHAR(32) NOT NULL,
    payload JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, part),
    INDEX idx_working_memory_parts_project (project_id),
    INDEX idx_working_memory_parts_part (part)
  )`,
];

async function ensureSchema(connection) {
  for (const statement of SCHEMA_STATEMENTS) {
    // eslint-disable-next-line no-await-in-loop
    await queryWithLogging(connection, statement);
  }

  const [projectColumn] = await queryWithLogging(connection, "SHOW COLUMNS FROM node_versions LIKE 'project_id'");
  if (projectColumn.length === 0) {
    await queryWithLogging(connection, 'ALTER TABLE node_versions ADD COLUMN project_id VARCHAR(64) NULL');
    await executeWithLogging(connection, 'UPDATE node_versions SET project_id = ?', [config.defaults.projectId]);
    await queryWithLogging(connection, 'ALTER TABLE node_versions MODIFY project_id VARCHAR(64) NOT NULL');
  }

  const [primaryKey] = await queryWithLogging(connection, "SHOW INDEXES FROM node_versions WHERE Key_name = 'PRIMARY'");
  const hasProjectComposite =
    primaryKey.length >= 2 &&
    primaryKey.some((row) => row.Column_name === 'project_id') &&
    primaryKey.some((row) => row.Column_name === 'node_id');
  if (!hasProjectComposite) {
    await queryWithLogging(connection, 'ALTER TABLE node_versions DROP PRIMARY KEY, ADD PRIMARY KEY (project_id, node_id)');
  }

  const [messageTypeColumn] = await queryWithLogging(
    connection,
    "SHOW COLUMNS FROM messages LIKE 'message_type'"
  );
  if (messageTypeColumn.length === 0) {
    await queryWithLogging(
      connection,
      "ALTER TABLE messages ADD COLUMN message_type VARCHAR(32) NOT NULL DEFAULT 'user_reply' AFTER role"
    );
  }
}

let initialisationPromise;

async function initMysql() {
  if (!initialisationPromise) {
    initialisationPromise = (async () => {
      const connection = await pool.getConnection();
      try {
        await ensureSchema(connection);
        console.log(
          `Connected to MySQL at ${config.mysql.host}:${config.mysql.port} (schema: ${config.mysql.database})`
        );
      } finally {
        connection.release();
      }
    })();
  }
  return initialisationPromise;
}

async function closeMysql() {
  await pool.end();
}

module.exports = {
  pool,
  closeMysql,
  initMysql,
};
