const isDev = import.meta.env.MODE === 'development';

export const logger = {
  error: (...args) => isDev && console.error(...args),
  warn: (...args) => isDev && console.warn(...args),
  debug: (...args) => isDev && console.log(...args),
};

export default logger;