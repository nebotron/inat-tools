/**
 * Loads before `app.js` (non-module). Registers global error handlers and
 * `window.explorerReportFatalException` so the explorer can replace the page with a full dump.
 */
(function explorerFatalDumpBootstrap() {
  "use strict";

  var shown = false;
  var dumpText = "";

  function safeString(x) {
    if (x == null) return String(x);
    if (typeof x === "string") return x;
    if (typeof x === "number" || typeof x === "boolean" || typeof x === "bigint") return String(x);
    if (x instanceof Error) return x.message || String(x);
    try {
      return JSON.stringify(x, null, 2);
    } catch (jsonEx) {
      return "[safeString: JSON.stringify failed: " + String(jsonEx && jsonEx.message ? jsonEx.message : jsonEx) + "]";
    }
  }

  function formatErrorEvent(ev) {
    if (!ev || typeof ev !== "object") return "(no ErrorEvent)";
    var lines = [];
    lines.push("type: " + String(ev.type || ""));
    lines.push("message: " + String(typeof ev.message === "string" ? ev.message : ""));
    lines.push("filename: " + String(typeof ev.filename === "string" ? ev.filename : ""));
    lines.push("lineno: " + String(ev.lineno != null ? ev.lineno : ""));
    lines.push("colno: " + String(ev.colno != null ? ev.colno : ""));
    if (ev.error != null && ev.error !== undefined) {
      lines.push("ev.error (typeof): " + typeof ev.error);
      if (ev.error instanceof Error) {
        lines.push("ev.error.name: " + String(ev.error.name || ""));
        lines.push("ev.error.message: " + String(ev.error.message || ""));
        if (ev.error.stack) lines.push("ev.error.stack:\n" + ev.error.stack);
      } else {
        lines.push("ev.error (value): " + safeString(ev.error));
      }
    } else {
      lines.push("ev.error: (absent)");
    }
    return lines.join("\n");
  }

  function formatCauseValue(cur) {
    if (cur == null) return String(cur);
    if (typeof ErrorEvent !== "undefined" && cur instanceof ErrorEvent) return formatErrorEvent(cur);
    if (typeof Event !== "undefined" && cur instanceof Event) {
      return (
        "Event:\n" +
        "  type: " +
        String(cur.type || "") +
        "\n  defaultPrevented: " +
        String(!!cur.defaultPrevented) +
        "\n  isTrusted: " +
        String(!!cur.isTrusted)
      );
    }
    return safeString(cur);
  }

  function recentScriptResourceUrls() {
    try {
      if (typeof performance === "undefined" || !performance.getEntriesByType) return "";
      var entries = performance.getEntriesByType("resource");
      var out = [];
      var i;
      var max = 20;
      for (i = entries.length - 1; i >= 0 && out.length < max; i -= 1) {
        var e = entries[i];
        var n = String(e.name);
        if (!/\.js(\?|$|#)/i.test(n) && e.initiatorType !== "script") continue;
        out.push(n + "  [" + String(e.initiatorType || "?") + "]");
      }
      return out.length ? out.reverse().join("\n") : "";
    } catch (x) {
      return "(could not read performance entries: " + String(x && x.message ? x.message : x) + ")";
    }
  }

  function isOpaqueCrossOriginScriptError(ev, err) {
    var msg = ev && typeof ev.message === "string" ? ev.message : "";
    if (msg === "Script error.") return true;
    if (err && err instanceof Error && err.message === "Script error.") return true;
    if (msg === "" && ev && !ev.filename && (ev.lineno === 0 || ev.lineno === undefined)) return true;
    return false;
  }

  function formatErrorChain(err) {
    var parts = [];
    var cur = err;
    var depth = 0;
    while (cur != null && depth < 12) {
      depth += 1;
      if (cur instanceof Error) {
        parts.push(
          "--- Error (" + depth + ") ---\n" +
            "name: " + (cur.name || "(anonymous)") + "\n" +
            "message: " + (cur.message || "") + "\n" +
            (cur.stack ? "stack:\n" + cur.stack + "\n" : "(no stack on this Error)\n")
        );
        cur = cur.cause;
      } else {
        parts.push("--- Non-Error cause (" + depth + ") ---\n" + formatCauseValue(cur) + "\n");
        break;
      }
    }
    return parts.join("\n");
  }

  function formatReason(r) {
    if (r instanceof Error) return formatErrorChain(r);
    return safeString(r);
  }

  function buildDump(reason, contextLabel, appendix) {
    var lines = [];
    lines.push("iNaturalist observation browser — fatal error report");
    lines.push("Generated (ISO): " + new Date().toISOString());
    lines.push("Page URL: " + (typeof location !== "undefined" ? location.href : "(unknown)"));
    lines.push("User agent: " + (typeof navigator !== "undefined" ? navigator.userAgent : "(unknown)"));
    if (typeof screen !== "undefined") {
      lines.push(
        "Viewport: " +
          String(typeof innerWidth !== "undefined" ? innerWidth : "") +
          "×" +
          String(typeof innerHeight !== "undefined" ? innerHeight : "") +
          "  screen: " +
          screen.width +
          "×" +
          screen.height
      );
    }
    if (typeof visualViewport !== "undefined" && visualViewport) {
      lines.push(
        "visualViewport: scale=" +
          String(visualViewport.scale) +
          " offset=" +
          String(visualViewport.offsetLeft) +
          "," +
          String(visualViewport.offsetTop) +
          " size=" +
          String(visualViewport.width) +
          "×" +
          String(visualViewport.height)
      );
    }
    lines.push("");
    lines.push("Context label (from app): " + (contextLabel || "(none)"));
    lines.push("");
    var appendixStr = appendix ? String(appendix).trim() : "";
    var diagFirst = appendixStr.indexOf('--- ErrorEvent (window "error") ---') === 0;
    if (diagFirst) {
      lines.push(
        "--- Diagnostics (window error; cross-origin script throws hide filename/line on the primary Error) ---"
      );
      lines.push(appendixStr);
      lines.push("");
    }
    lines.push("--- Primary exception ---");
    if (reason instanceof Error) {
      lines.push(formatErrorChain(reason));
    } else {
      lines.push("Thrown / rejected value:\n" + safeString(reason));
    }
    lines.push("");
    if (!diagFirst && appendixStr) {
      lines.push("--- Additional diagnostics ---");
      lines.push(appendixStr);
      lines.push("");
    }
    lines.push("--- document.readyState ---");
    lines.push(typeof document !== "undefined" ? document.readyState : "(no document)");
    return lines.join("\n");
  }

  function copyDumpToClipboard() {
    if (!dumpText) return;
    function done(ok, msg) {
      var st = document.getElementById("explorer-fatal-copy-status");
      if (st) st.textContent = msg || (ok ? "Copied." : "Copy failed.");
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(dumpText).then(
        function () {
          done(true, "Copied full report to clipboard.");
        },
        function (err) {
          done(false, "Clipboard API failed: " + (err && err.message ? err.message : String(err)));
        }
      );
      return;
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = dumpText;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done(true, "Copied full report (fallback).");
    } catch (e) {
      done(false, "Copy failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function installCopyShortcut() {
    document.addEventListener(
      "keydown",
      function (ev) {
        var d = ev.key === "d" || ev.key === "D";
        if (!d || !ev.shiftKey) return;
        var mod = ev.ctrlKey || ev.metaKey;
        if (!mod) return;
        ev.preventDefault();
        copyDumpToClipboard();
      },
      true
    );
  }

  function replacePageWithDump(text) {
    dumpText = text;
    var esc = function (s) {
      var d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    };

    document.documentElement.innerHTML =
      '<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>' +
      "<title>Fatal error — observation browser</title>" +
      "<style>" +
      "html,body{margin:0;height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#1a1a2e;color:#eee;}" +
      ".wrap{box-sizing:border-box;min-height:100%;padding:1rem 1.25rem 2rem;display:flex;flex-direction:column;gap:0.75rem;}" +
      "h1{margin:0;font-size:1.15rem;font-weight:700;color:#ff8a80;}" +
      ".actions{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;}" +
      "button{font:inherit;padding:0.45rem 0.85rem;border-radius:6px;border:1px solid #5c6bc0;background:#3949ab;color:#fff;cursor:pointer;font-weight:600;}" +
      "button:hover{background:#5c6bc0;}" +
      "#explorer-fatal-copy-status{font-size:0.85rem;color:#b0bec5;min-height:1.2em;}" +
      "pre#explorer-fatal-dump{flex:1;min-height:12rem;margin:0;padding:0.85rem;background:#0d1117;border:1px solid #30363d;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:0.78rem;line-height:1.45;color:#e6edf3;overflow:auto;}" +
      ".hint{font-size:0.82rem;color:#90a4ae;line-height:1.4;}" +
      "</style></head>" +
      '<body><div class="wrap">' +
      "<h1>This page stopped because of an exception</h1>" +
      '<div class="actions"><button type="button" id="explorer-fatal-copy-btn">Copy full report</button></div>' +
      '<p id="explorer-fatal-copy-status" aria-live="polite"></p>' +
      '<p class="hint">Shortcut: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> (Windows/Linux) or <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> (macOS).</p>' +
      "<pre id=\"explorer-fatal-dump\">" +
      esc(text) +
      "</pre></div></body>";

    var btn = document.getElementById("explorer-fatal-copy-btn");
    if (btn) btn.addEventListener("click", copyDumpToClipboard);
    installCopyShortcut();
  }

  function report(reason, contextLabel, appendix) {
    if (shown) return;
    shown = true;
    var text;
    try {
      text = buildDump(reason, contextLabel, appendix);
    } catch (e) {
      text =
        "While building the primary error report, a second error occurred:\n\n" +
        formatReason(e) +
        "\n\n--- original ---\n" +
        formatReason(reason);
    }
    try {
      replacePageWithDump(text);
    } catch (e2) {
      try {
        document.body.innerHTML = "";
        var pre = document.createElement("pre");
        pre.style.cssText = "white-space:pre-wrap;padding:1rem;font:12px/1.4 monospace";
        pre.textContent =
          text +
          "\n\n(replacePageWithDump failed: " +
          String(e2 && e2.message ? e2.message : e2) +
          ")";
        document.body.appendChild(pre);
      } catch (lastEx) {
        if (typeof console !== "undefined" && console.error) console.error(lastEx);
      }
    }
  }

  /** @param {unknown} reason @param {string} [contextLabel] @param {string} [appendix] */
  window.explorerReportFatalException = report;

  /**
   * Browsers (especially WebKit) may dispatch a window `error` for ResizeObserver feedback during
   * pinch / page zoom. It is not a fatal app bug; replacing the entire document would look like a
   * refresh and can trigger Safari’s “a problem repeatedly occurred” if it fires in a loop.
   */
  function isBenignResizeObserverLoopMessage(msg) {
    var s = typeof msg === "string" ? msg : msg == null ? "" : String(msg);
    return (
      s.indexOf("ResizeObserver loop limit exceeded") !== -1 ||
      s.indexOf("ResizeObserver loop completed with undelivered notifications") !== -1
    );
  }

  window.addEventListener(
    "error",
    function (ev) {
      if (shown) return;
      var msg = ev && typeof ev.message === "string" ? ev.message : "";
      if (isBenignResizeObserverLoopMessage(msg)) {
        try {
          ev.preventDefault();
        } catch {
          /* ignore */
        }
        return;
      }
      if (ev && ev.error && isBenignResizeObserverLoopMessage(ev.error.message)) {
        try {
          ev.preventDefault();
        } catch {
          /* ignore */
        }
        return;
      }
      var rawErr = ev.error;
      var err;
      if (rawErr instanceof Error && !isOpaqueCrossOriginScriptError(ev, rawErr)) {
        err = rawErr;
      } else if (rawErr instanceof Error && isOpaqueCrossOriginScriptError(ev, rawErr)) {
        err = new Error(
          "Script error. (browser omitted source location, often cross-origin). See Diagnostics for ErrorEvent fields and recent script URLs.",
          { cause: rawErr }
        );
      } else {
        err = new Error(
          isOpaqueCrossOriginScriptError(ev, null)
            ? "Script error. (browser omitted details). See Diagnostics below."
            : typeof ev.message === "string" && ev.message
              ? ev.message
              : "window error event"
        );
      }
      var evBlock = "--- ErrorEvent (window \"error\") ---\n" + formatErrorEvent(ev);
      var appendix = evBlock;
      if (isOpaqueCrossOriginScriptError(ev, err)) {
        appendix +=
          "\n\n--- Cross-origin / sanitized script errors ---\n" +
          "Browsers often report only \"Script error.\" with no filename or line when the throw site is in another\n" +
          "origin (classic script without CORS) or when details are withheld. The stack on a synthetic Error below\n" +
          "points at this fatal reporter, not the original file.\n";
        var scripts = recentScriptResourceUrls();
        if (scripts) appendix += "\n--- Recent JS-related resource URLs (Performance API) ---\n" + scripts + "\n";
      } else {
        var scripts2 = recentScriptResourceUrls();
        if (scripts2) appendix += "\n--- Recent JS-related resource URLs (Performance API) ---\n" + scripts2 + "\n";
      }
      var ctx =
        'window "error" event — filename: ' +
        (ev.filename || "(none)") +
        "  line: " +
        (ev.lineno != null ? ev.lineno : "(none)") +
        "  col: " +
        (ev.colno != null ? ev.colno : "(none)");
      report(err, ctx, appendix);
    },
    true
  );

  window.addEventListener("unhandledrejection", function (ev) {
    if (shown) return;
    var r = ev.reason;
    var m =
      r instanceof Error
        ? r.message
        : r && typeof r.message === "string"
          ? r.message
          : typeof r === "string"
            ? r
            : "";
    if (isBenignResizeObserverLoopMessage(m)) return;
    var appendix = "";
    var scripts = recentScriptResourceUrls();
    if (scripts) appendix = "--- Recent JS-related resource URLs (Performance API) ---\n" + scripts;
    report(ev.reason, "unhandledrejection", appendix || undefined);
  });
})();
