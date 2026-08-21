const express = require('express');

// Express 4 does not understand a promise returned by a route handler. When an
// async handler rejects — any failed query — the rejection goes unhandled, and
// Node's default behaviour since v15 is to terminate the process. One bad query
// therefore takes down the whole server, and whatever proxy sits in front of it
// answers 502 for every request until the host restarts the app.
//
// Wrapping each handler so its rejection is passed to next() turns that into an
// ordinary 500 from the error handler in server.js, with the server still up.
// Routers built here behave exactly like express.Router() otherwise.

function wrap(handler) {
  if (Array.isArray(handler)) return handler.map(wrap);
  if (typeof handler !== 'function') return handler; // a path string, or a sub-router
  // Express identifies error-handling middleware by its arity; leave it alone.
  if (handler.length === 4) return handler;

  return function wrapped(req, res, next) {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
      return result;
    } catch (err) {
      return next(err);
    }
  };
}

const METHODS = ['use', 'all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function asyncRouter(options) {
  const router = express.Router(options);
  for (const method of METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map(wrap));
  }
  return router;
}

module.exports = { asyncRouter, wrap };
