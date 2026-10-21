/*
 * INFINICUS device shell: defines window.InfinicusDevice (contract version 1) for the bundled counter. POS-8d-2b.
 *
 * Contract:  window.InfinicusDevice = { version: 1, printEscPos(dataBase64): Promise<{ ok: boolean, error?: string }> }
 *
 * The native side installs this script at document start, for the app's own origin only, together with a message port named InfinicusNative that
 * carries one line pair per call: "<id>\n<base64 bytes>" out, "<id>\n<code>" back (code "ok" or a fixed failure code). The page never learns where the
 * printer is, and the printer's address is never in this file. The answer is settled within 12 seconds even if the device never replies (the web
 * counter waits at most 15). The object is frozen and cannot be replaced by page code. Plain ES5 on purpose: it runs before anything else.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.InfinicusDevice) return;

  var TIMEOUT_MS = 12000;
  var BASE64 = /^[A-Za-z0-9+\/]+={0,2}$/;
  var pending = {};
  var counter = 0;
  var listening = false;

  function port() {
    var p = window.InfinicusNative;                      // read at call time: it may be installed just after this script
    return p && typeof p.postMessage === 'function' ? p : null;
  }

  function onReply(event) {
    var data = event && event.data;
    if (typeof data !== 'string') return;
    var nl = data.indexOf('\n');
    if (nl < 1) return;
    var id = data.slice(0, nl);
    var code = data.slice(nl + 1);
    var call = pending[id];
    if (!call) return;                                   // unknown or already settled: ignore
    delete pending[id];
    clearTimeout(call.timer);
    call.resolve(code === 'ok' ? { ok: true } : { ok: false, error: String(code).slice(0, 40) });
  }

  function newId() {
    counter += 1;
    return 'p' + Date.now().toString(36) + '-' + counter + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }

  function printEscPos(dataBase64) {
    return new Promise(function (resolve) {
      if (typeof dataBase64 !== 'string' || dataBase64.length % 4 !== 0 || !BASE64.test(dataBase64)) {
        resolve({ ok: false, error: 'invalid_request' });
        return;
      }
      var native = port();
      if (!native) {
        resolve({ ok: false, error: 'not_available' });
        return;
      }
      if (!listening) { native.onmessage = onReply; listening = true; }
      var id = newId();
      var timer = setTimeout(function () {
        if (pending[id]) { delete pending[id]; resolve({ ok: false, error: 'timeout' }); }
      }, TIMEOUT_MS);
      pending[id] = { resolve: resolve, timer: timer };
      try {
        native.postMessage(id + '\n' + dataBase64);
      } catch (e) {
        delete pending[id];
        clearTimeout(timer);
        resolve({ ok: false, error: 'connection_failed' });
      }
    });
  }

  Object.defineProperty(window, 'InfinicusDevice', {
    value: Object.freeze({ version: 1, printEscPos: printEscPos }),
    writable: false,
    configurable: false,
    enumerable: false
  });
})();
