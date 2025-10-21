const path = require('path');
const express = require('express');
const morgan = require('morgan');

const config = require('./src/config');
const apiRouter = require('./src/routes/api');
const { closeNeo4j } = require('./src/db/neo4j');
const { closeMysql } = require('./src/db/mysql');

const app = express();

app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/modules', express.static(path.join(__dirname, 'modules')));
app.use('/core', express.static(path.join(__dirname, 'core')));

app.use('/api', apiRouter);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'modules', 'main', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error', detail: err.message });
});

const server = app.listen(config.port, () => {
  console.log(`Server listening at http://localhost:${config.port}`);
});

async function shutdown() {
  await Promise.allSettled([closeNeo4j(), closeMysql()]);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;
