const agyDriver = require('./agyDriver');
const codexDriver = require('./codexDriver');
const geminiDriver = require('./geminiDriver');

const drivers = {
  agy: agyDriver,
  codex: codexDriver,
  gemini: geminiDriver
};

function getDriver(tool) {
  const driver = drivers[tool.toLowerCase()];
  if (!driver) {
    throw new Error(`No registered driver found for tool: ${tool}`);
  }
  return driver;
}

module.exports = {
  getDriver,
  drivers
};
