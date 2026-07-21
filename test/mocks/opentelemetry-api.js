export const trace = {
  getTracer: () => ({
    startActiveSpan: (name, fn) => fn({
      setAttribute: () => {},
      setStatus: () => {},
      recordException: () => {},
      end: () => {},
    }),
  }),
};
export const SpanStatusCode = { OK: 0, ERROR: 1 };
export default { trace, SpanStatusCode };
