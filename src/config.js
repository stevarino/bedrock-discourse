const fs = require('fs');
const yaml = require('yaml');
const path = require('path');
const { validate } = require('jsonschema');

const CONFIG = {};

function get() {
  if (CONFIG) return CONFIG;
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
  return config;
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

module.exports = { processConfig, get, validateConfig };
