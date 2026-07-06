const isDev = import.meta.env.MODE === "development";

// Route through a computed member so the dev-only wrapper stays DRY.
const emit =
  (method) =>
  (...args) =>
    isDev && console[method](...args);

// Errors and warnings must be visible in production too (e.g. the browser
// console, or any error-tracking integration that taps console.*), so they
// always emit regardless of mode. Wiring these into a dedicated
// telemetry/error-reporting sink is a separate decision — not done here.
const emitAlways =
  (method) =>
  (...args) =>
    console[method](...args);

export const logger = {
  error: emitAlways("error"),
  warn: emitAlways("warn"),
  info: emit("info"),
  debug: emit("log"),
};

export default logger;
