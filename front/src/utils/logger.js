const isDev = import.meta.env.MODE === "development";

// Route through a computed member so the dev-only wrapper stays DRY.
const emit =
  (method) =>
  (...args) =>
    isDev && console[method](...args);

export const logger = {
  error: emit("error"),
  warn: emit("warn"),
  info: emit("info"),
  debug: emit("log"),
};

export default logger;
