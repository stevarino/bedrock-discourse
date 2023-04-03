const fs = require('fs');
const yaml = require('yaml');
const path = require('path');
const { validate } = require('jsonschema');

const CONFIG = {};

const ENDPOINT_CACHE = {};

function get() {
  if (Object.keys(CONFIG).length) return CONFIG;
  return Object.assign(CONFIG, processConfig());
}

function processConfig() {
  const args = process.argv.slice(2);
  let filename = './config.yaml';
  if (args.length >= 1) {
    filename = args[0];
  }
  const file = fs.readFileSync(filename, 'utf8');
  const config = yaml.parse(file);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error('Invalid config file:', errors);
    process.exit(1);
  }
  return normalizeConfig(config);
}

/**
 * Validates a config, returning a list of errors.
 *
 * @param {object} config 
 * @returns {array[string]}
 */
function validateConfig(config) {
  /** @type {Set}| */
  const names = new Set();
  const errors = [];
  Object.keys(config.minecraft.servers).forEach(n => names.add(n));
  Object.keys(config?.discord.channels ?? {}).forEach(n => {
    if (names.has(n)) errors.push(`Multiple definitions for "${n}"`);
  });
  const filePath = path.join(path.dirname(__dirname), 'data', 'config_schema.yaml');
  const schema = yaml.parse(fs.readFileSync(filePath, 'utf8'));
  const result = validate(config, schema, { allowUnknownAttributes: false });
  return errors.concat(result.errors.map(e => e.stack));
}

function normalizeConfig(config) {
  Object.keys(ENDPOINT_CACHE).forEach(key => {
    delete ENDPOINT_CACHE[key];
  });
  Object.entries(config.minecraft.servers).forEach(([name, server]) => {
    ENDPOINT_CACHE[name] = server;
    server.name = name;
    server.endpointType = 'minecraft';
  });
  Object.entries(config.discord?.channels ?? {}).forEach(([name, channel]) => {
    ENDPOINT_CACHE[name] = channel;
    channel.name = name;
    channel.endpointType = 'discord';
  })
  return config;
}

function findEndpoint(name) {
  return ENDPOINT_CACHE[name];
}

function getEndpoints() {
  return Object.values(ENDPOINT_CACHE);
}

module.exports = { processConfig, get, validateConfig, findEndpoint, getEndpoints, normalizeConfig };
