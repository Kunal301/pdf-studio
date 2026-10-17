// Small, idempotent polyfills for JavaScript features that current PDF.js (and other libraries) call but that
// many Safari / Chrome / Firefox versions don't have yet. Imported first in the page AND in the PDF worker.
const define = (obj, name, fn) => {
  if (obj && typeof obj[name] !== "function") Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true });
};

for (const C of [Map, WeakMap]) {
  define(C.prototype, "getOrInsert", function (key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });
  define(C.prototype, "getOrInsertComputed", function (key, compute) {
    if (!this.has(key)) this.set(key, compute(key));
    return this.get(key);
  });
}

define(Promise, "withResolvers", function () {
  let resolve, reject;
  const promise = new this((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
});
define(Promise, "try", function (fn, ...args) {
  return new this((resolve) => resolve(fn(...args)));
});
define(Math, "sumPrecise", (values) => { let s = 0; for (const v of values) s += v; return s; });

define(Array.prototype, "at", function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return this[i]; });
define(Array.prototype, "findLast", function (fn, thisArg) { for (let i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return this[i]; });
define(Array.prototype, "findLastIndex", function (fn, thisArg) { for (let i = this.length - 1; i >= 0; i--) if (fn.call(thisArg, this[i], i, this)) return i; return -1; });
define(Array.prototype, "toSorted", function (cmp) { return [...this].sort(cmp); });
define(Array.prototype, "toReversed", function () { return [...this].reverse(); });
define(Uint8Array.prototype, "at", Array.prototype.at);
define(Object, "groupBy", (items, fn) => { const out = Object.create(null); let i = 0; for (const x of items) (out[fn(x, i++)] ||= []).push(x); return out; });
define(Map, "groupBy", (items, fn) => { const out = new Map(); let i = 0; for (const x of items) { const k = fn(x, i++); if (!out.has(k)) out.set(k, []); out.get(k).push(x); } return out; });
define(Object, "hasOwn", (o, k) => Object.prototype.hasOwnProperty.call(o, k));
define(globalThis, "structuredClone", (v) => JSON.parse(JSON.stringify(v)));

// ReadableStream async iteration (missing in older Safari) — used with `for await (const x of stream)`
if (typeof ReadableStream !== "undefined" && !ReadableStream.prototype[Symbol.asyncIterator]) {
  const values = async function* () {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
  ReadableStream.prototype[Symbol.asyncIterator] = values;
  if (!ReadableStream.prototype.values) ReadableStream.prototype.values = values;
}
