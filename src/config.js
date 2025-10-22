const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const DEFAULT_PROJECT_ID = 'default_project';

const envFile = process.env.APP_ENV_FILE
  ? path.resolve(process.cwd(), process.env.APP_ENV_FILE)
  : path.resolve(process.cwd(), '.env');

if (process.env.LOAD_ENV !== 'false') {
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  }
}

module.exports = {
  port: parseInt(process.env.PORT || '8080', 10),
  neo4j: {
    uri: process.env.NEO4J_URI || 'neo4j://localhost:7687',
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'password',
  },
  mysql: {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'story_graph',
    waitForConnections: true,
    connectionLimit: parseInt(process.env.MYSQL_POOL_SIZE || '10', 10),
  },
  defaults: {
    projectId: process.env.DEFAULT_PROJECT_ID || DEFAULT_PROJECT_ID,
    versionPollIntervalMs: parseInt(process.env.VERSION_POLL_INTERVAL_MS || '5000', 10),
  },
};
