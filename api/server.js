"use strict";

const { createApp } = require("./portal");
const { createServices } = require("./services");

const services = createServices(process.env);
createApp(services, process.env).listen(process.env.PORT || 8080, () => {
  console.log("Secure intake portal listening.");
});
