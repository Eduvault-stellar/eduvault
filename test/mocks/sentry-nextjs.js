export function captureException() {}

export function captureMessage() {}

export function setUser() {}

export function withScope(callback) {
  callback({
    setExtras() {},
    setLevel() {},
  });
}

const sentryMock = {
  captureException,
  captureMessage,
  setUser,
  withScope,
};

export default sentryMock;
