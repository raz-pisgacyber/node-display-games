const neo4j = require('neo4j-driver');
const config = require('../config');

const driver = neo4j.driver(
  config.neo4j.uri,
  neo4j.auth.basic(config.neo4j.user, config.neo4j.password),
  {
    disableLosslessIntegers: true,
  }
);

async function verifyNeo4jConnection() {
  const connectivity = await driver.verifyConnectivity();
  const resolvedAddress = connectivity?.address?.asHostPort?.() || connectivity?.address;
  const addressLabel =
    typeof resolvedAddress === 'string'
      ? resolvedAddress
      : `${config.neo4j.uri} (resolved)`;
  console.log(`Connected to Neo4j at ${addressLabel}`);
}

async function closeNeo4j() {
  await driver.close();
}

module.exports = {
  driver,
  closeNeo4j,
  verifyNeo4jConnection,
};
