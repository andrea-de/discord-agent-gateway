const agyDriver = require('./agyDriver');
const codexDriver = require('./codexDriver');
const geminiDriver = require('./geminiDriver');

const drivers = {
  agy: agyDriver,
  codex: codexDriver,
  gemini: geminiDriver
};

function getDriver(tool) {
  let normalizedTool = tool.toLowerCase();
  if (normalizedTool === 'antigravity') {
    normalizedTool = 'agy';
  }
  const driver = drivers[normalizedTool];
  if (!driver) {
    throw new Error(`No registered driver found for tool: ${tool}`);
  }
  return driver;
}

module.exports = {
  getDriver,
  drivers
};
