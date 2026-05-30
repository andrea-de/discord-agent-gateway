const agyDriver = require('./agyDriver');
const codexDriver = require('./codexDriver');

const drivers = {
  agy: agyDriver,
  codex: codexDriver
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
