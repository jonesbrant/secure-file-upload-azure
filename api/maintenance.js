"use strict";

const { createPortal } = require("./portal");
const { createServices } = require("./services");

createPortal(createServices(process.env), process.env).maintenance()
  .then(result => console.log("Maintenance complete", result))
  .catch(() => { console.error("Maintenance failed"); process.exitCode = 1; });
