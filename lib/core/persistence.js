"use strict";

const { createLegacyPersistence } = require("./persistence-legacy");

function createPersistence({ adapter = createLegacyPersistence() } = {}) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("persistence adapter is required");
  return adapter;
}

module.exports = { createPersistence };
