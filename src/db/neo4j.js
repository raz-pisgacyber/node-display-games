const neo4j = require('neo4j-driver');
const config = require('../config');

const driver = neo4j.driver(
  config.neo4j.uri,
  neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
  {
    disableLosslessIntegers: true,
  }
);

async function closeNeo4j() {
  await driver.close();
}

module.exports = {
  driver,
  closeNeo4j,
};
