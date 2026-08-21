// Entry point for hosts that expect a startup file at the project root —
// cPanel's Node.js Selector (which GoDaddy uses) defaults to app.js and starts
// it under Phusion Passenger. Everything real lives in src/server.js.
module.exports = require('./src/server');
