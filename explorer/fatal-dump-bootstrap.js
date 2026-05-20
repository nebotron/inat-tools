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
            (cur.stack ? "stack:\n" + cur.stack + "\n" : "")
        );
        cur = cur.cause;
      } else {
        parts.push("--- Non-Error cause (" + depth + ") ---\n" + safeString(cur) + "\n");
        break;
      }
    }
    return parts.join("\n");
  }

  function formatReason(r) {
    if (r instanceof Error) return formatErrorChain(r);
    return safeString(r);
  }

  function buildDump(reason, contextLabel) {
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
    if (reason instanceof Error) {
      lines.push(formatErrorChain(reason));
    } else {
      lines.push("Thrown / rejected value:\n" + safeString(reason));
    }
    lines.push("");
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

  function report(reason, contextLabel) {
    if (shown) return;
    shown = true;
    var text;
    try {
      text = buildDump(reason, contextLabel);
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

  window.explorerReportFatalException = report;

  window.addEventListener(
    "error",
    function (ev) {
      if (shown) return;
      var err = ev.error;
      if (!(err instanceof Error)) {
        err = new Error(ev.message || "window error event", { cause: ev });
      }
      report(err, 'window "error" event (filename: ' + (ev.filename || "?") + ", line: " + (ev.lineno || "?") + ")");
    },
    true
  );

  window.addEventListener("unhandledrejection", function (ev) {
    if (shown) return;
    report(ev.reason, "unhandledrejection");
  });
})();
