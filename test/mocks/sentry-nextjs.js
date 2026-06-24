export function captureException() {}

export function captureMessage() {}

export function setUser() {}

export function withScope(callback) {
  callback({
    setExtras() {},
    setLevel() {},
  });
}

export default {
  captureException,
  captureMessage,
  setUser,
  withScope,
};
