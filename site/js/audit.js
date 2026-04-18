/*!
 * Public GEO Audit client — posts to api.advocatemcp.com/audit/run,
 * renders results, wires CTA. Zero dependencies. Never throws —
 * every failure path renders a human-readable error instead.
 */
(function () {
  "use strict";

  var API_BASE = "https://api.advocatemcp.com";

  var form     = document.getElementById("audit-form");
  var btn      = document.getElementById("submit-btn");
  var loading  = document.getElementById("loading");
  var errorEl  = document.getElementById("error");
  var results  = document.getElementById("results");

  if (!form) return;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.add("show");
    loading.classList.remove("show");
    results.classList.remove("show");
    btn.disabled = false;
    btn.textContent = "Run my audit";
  }

  function clearError() {
    errorEl.classList.remove("show");
    errorEl.textContent = "";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // Reduce a URL to its canonical bare hostname for leaderboard grouping.
  // "https://www.example.com/path?utm=x" → "example.com"
  function bareDomain(urlStr) {
    if (!urlStr) return "";
    try {
      var u = new URL(urlStr);
      return u.hostname.replace(/^www\./i, "").toLowerCase();
    } catch (_) {
      return String(urlStr).replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[\/?#]/)[0].toLowerCase();
    }
  }

  // Aggregate citation counts across every query → ranked competitor list.
  // Exclude the tenant's own domain and Google Maps re-search shims (which
  // OpenAI sometimes returns instead of real domains for local searches).
  // Returns up to `topN` rows, sorted descending.
  function buildLeaderboard(audit, topN) {
    var ownDomain = bareDomain(audit && audit.domain ? audit.domain : "");
    var counts = Object.create(null);
    var totalCites = 0;
    (audit.queries || []).forEach(function (q) {
      (q.citations || []).forEach(function (c) {
        var d = bareDomain(c);
        if (!d) return;
        if (d === ownDomain) return;
        // Skip Google Maps "search shim" URLs — the host is just google.com
        // and they're not a real competitor surface.
        if (d === "google.com" && /maps\/search\//i.test(c)) return;
        counts[d] = (counts[d] || 0) + 1;
        totalCites++;
      });
    });
    var rows = Object.keys(counts).map(function (d) {
      return { domain: d, count: counts[d] };
    });
    rows.sort(function (a, b) { return b.count - a.count || a.domain.localeCompare(b.domain); });
    return { rows: rows.slice(0, topN || 5), max: rows.length > 0 ? rows[0].count : 0, totalCites: totalCites };
  }

  // Render the leaderboard into the supplied DOM nodes. Self-contained so
  // r.html can reuse it via copy/paste — the audit site has no module bundler.
  function renderLeaderboard(audit, bodyEl, headEl, cardEl) {
    if (!bodyEl) return;
    var lb = buildLeaderboard(audit, 5);
    if (lb.rows.length === 0) {
      // Hide the whole card on zero — no competitors means either an empty
      // category response or a 100% citation rate, neither benefits from
      // the leaderboard.
      if (cardEl) cardEl.style.display = "none";
      return;
    }
    if (cardEl) cardEl.style.display = "";
    if (headEl) {
      var category = audit.category ? ' for <em>' + escapeHtml(audit.category) + '</em>' : '';
      headEl.innerHTML = "Who's winning" + category;
    }
    bodyEl.innerHTML = lb.rows.map(function (r, i) {
      var rank = i + 1;
      var pctFill = lb.max > 0 ? (r.count / lb.max) : 0;
      var podiumClass = rank <= 3 ? " podium" : "";
      return '<div class="lb-row">' +
        '<div class="lb-rank' + podiumClass + '">' + rank + '</div>' +
        '<div class="lb-domain"><a href="https://' + escapeHtml(r.domain) + '" target="_blank" rel="noopener noreferrer nofollow">' + escapeHtml(r.domain) + '</a></div>' +
        '<div class="lb-meter"><div class="lb-meter-fill" style="transform:scaleX(' + pctFill.toFixed(3) + ')"></div></div>' +
        '<div class="lb-count"><strong>' + r.count + '</strong> ' + (r.count === 1 ? "cite" : "cites") + '</div>' +
      '</div>';
    }).join("");
  }

  // Expose for r.html (which copies the same logic) — keeps the
  // implementation in one place if both pages load this script. r.html
  // currently inlines its own copy; if we ever consolidate, this works.
  window.__advocateAuditLeaderboard = { buildLeaderboard: buildLeaderboard, renderLeaderboard: renderLeaderboard };

  // ── URL-param prefill — frictionless cold-outreach landing ─────────────
  // Cameron sends a prospect:
  //   advocatemcp.com/audit?domain=acme.com&category=plumber&location=Boise,TX
  // Fields auto-populate on load. Add ?auto=1 and the audit fires
  // immediately (no click required) — for the truly hot pitch:
  //   advocatemcp.com/audit?domain=acme.com&category=plumber&location=Boise,TX&auto=1
  // Strips the params from the URL bar after consuming so a refresh
  // doesn't re-trigger an audit and the URL stays clean for sharing.
  (function prefillFromUrl() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (_) { return; }
    var d = (params.get("domain")   || "").trim();
    var c = (params.get("category") || "").trim();
    var l = (params.get("location") || "").trim();
    var auto = params.get("auto") === "1";
    if (!d && !c && !l && !auto) return;

    var domainEl   = document.getElementById("domain");
    var categoryEl = document.getElementById("category");
    var locationEl = document.getElementById("location");

    if (d && domainEl) {
      domainEl.value = /^https?:\/\//i.test(d) ? d : "https://" + d;
    }
    if (c && categoryEl) categoryEl.value = c;
    if (l && locationEl) locationEl.value = l;

    // Strip params from the URL bar so refresh doesn't re-fire an audit
    // and the page stays bookmark-friendly.
    if (window.history && window.history.replaceState) {
      try {
        window.history.replaceState(window.history.state, "", window.location.pathname);
      } catch (_) { /* ignore */ }
    }

    // Auto-fire the audit if requested AND we have at least domain + category.
    // Wait one tick so all listeners are attached.
    if (auto && d && c) {
      setTimeout(function () {
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }, 30);
    }
  })();

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearError();
    results.classList.remove("show");

    var domain   = form.domain.value.trim();
    var category = form.category.value.trim();
    var location = form.location.value.trim();

    if (!domain || !category) {
      showError("Please fill in the website and category fields.");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Running…";
    loading.classList.add("show");

    var payload = { domain: domain, category: category };
    if (location) payload.location = location;

    fetch(API_BASE + "/audit/run", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .then(function (r) {
        if (r.status === 429 && r.body.error === "ip_rate_limited") {
          showError("You've run " + (r.body.limit || 3) + " audits in the last 24 hours. Try again tomorrow or reach out at support@advocatemcp.com.");
          return;
        }
        if (r.status === 503 && r.body.error === "daily_budget_exhausted") {
          showError("The free audit hit its daily budget. Try again tomorrow, or skip the line and claim an AdvocateMCP agent directly.");
          return;
        }
        if (r.status === 400) {
          showError("Couldn't read that input. Please check your website URL and category, then try again.");
          return;
        }
        if (r.status >= 400 || !r.body.audit) {
          showError("Something went wrong on our end. Please try again in a minute.");
          return;
        }
        renderResults(r.body.audit, r.body.cached);
      })
      .catch(function (err) {
        showError("Couldn't reach the audit service. Check your connection and try again.");
        // Not thrown to console — failure is already shown.
        void err;
      });
  });

  function renderResults(audit, cached) {
    loading.classList.remove("show");
    btn.disabled = false;
    btn.textContent = "Run my audit";

    var score   = document.getElementById("score-big");
    var label   = document.getElementById("score-label");
    var detail  = document.getElementById("score-detail");
    var queries = document.getElementById("queries");
    var ctaTitle = document.getElementById("cta-title");
    var ctaBody  = document.getElementById("cta-body");

    var cited   = audit.cited_count || 0;
    var total   = audit.total_queries || 0;
    var rate    = total > 0 ? Math.round((cited / total) * 100) : 0;

    score.textContent = cited + " / " + total;
    score.classList.remove("zero", "some", "all");
    if (cited === 0)           score.classList.add("zero");
    else if (cited < total)    score.classList.add("some");
    else                       score.classList.add("all");

    label.textContent = "AI cited " + escapeHtml(audit.domain) + " in " + cited + " of " + total + " category queries (" + rate + "% citation rate)";
    detail.textContent = cached
      ? "Cached result from earlier today · 24h cache window"
      : "Live AI run · " + new Date(audit.created_at).toLocaleString();

    // Tailor the CTA to the audit outcome.
    if (cited === 0) {
      ctaTitle.textContent = "You're invisible to AI today";
      ctaBody.textContent = "AI-driven discovery is already shifting how customers find businesses like yours. An Advocate agent gives every AI a structured, citation-ready answer about you — the difference between scraped guesswork and your real pitch.";
    } else if (cited < total) {
      ctaTitle.textContent = "You're showing up, but not consistently";
      ctaBody.textContent = "AI cited you on some queries and missed you on others. An Advocate agent gives every AI the same structured answer about your business, so you stop competing with your own HTML.";
    } else {
      ctaTitle.textContent = "You're cited — now control what AI says about you";
      ctaBody.textContent = "You're in the answer set. But AI is building the quote from scraped HTML. An Advocate agent lets you supply the exact structured pitch — the specialty, pricing, credentials, and CTA you want AIs to surface.";
    }

    // Build the competitor leaderboard: aggregate citation counts across
    // every query, exclude the tenant's own domain, surface the top 5.
    // This is the most actionable single insight in the audit — "here's
    // who's winning your category in AI" — and computes entirely from
    // data already in audit.queries[].citations[].
    renderLeaderboard(audit, document.getElementById("leaderboard-body"), document.getElementById("leaderboard-head"), document.getElementById("leaderboard-card"));

    queries.innerHTML = (audit.queries || []).map(function (q) {
      var head = '<div class="query-head">' +
        '<div class="query-text">"' + escapeHtml(q.query) + '"</div>' +
        '<span class="badge ' + (q.cited ? "win" : "loss") + '">' +
        (q.cited ? "cited" : "not cited") + '</span>' +
      '</div>';
      var citations = (q.citations || []).slice(0, 5).map(escapeHtml);
      var cites = citations.length === 0
        ? '<em>No citations returned for this query.</em>'
        : '<strong>Sources AI cited:</strong> ' + citations.join(", ");
      return '<div class="query">' + head + '<div class="citations">' + cites + '</div></div>';
    }).join("");

    // Thread audit inputs into the Claim-your-agent CTA so onboarding
    // can pre-fill the business name (derived from domain), website,
    // industry (fuzzy-mapped from category), and city/state (parsed from
    // location). from_audit=1 is the sentinel the onboarding script
    // checks for — bare /onboarding keeps the empty-form behavior.
    //
    // URL uses /onboarding (not /onboarding.html) because Pages 308-
    // redirects the .html form to the clean URL and strips the query
    // string in the process. Going direct to /onboarding preserves
    // params. Observed on 2026-04-18; root cause diagnosed by curl -sI.
    var cta = document.getElementById("cta-link");
    if (cta) {
      var params = new URLSearchParams({ from_audit: "1" });
      if (audit.domain)   params.set("domain",   audit.domain);
      if (audit.category) params.set("category", audit.category);
      if (audit.location) params.set("location", audit.location);
      cta.href = "/onboarding?" + params.toString();
    }

    // Wire the share-link row. The audit id makes the report shareable
    // at /r/:id (Pages routes /r/* → /r.html?id=:splat via _redirects).
    var shareUrlInput = document.getElementById("share-url");
    if (shareUrlInput && audit.id) {
      var shareUrl = window.location.origin + "/r/" + audit.id;
      shareUrlInput.value = shareUrl;
      var copyBtn = document.getElementById("share-copy");
      if (copyBtn) {
        copyBtn.onclick = function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareUrl).then(function () {
              copyBtn.textContent = "Copied!";
              setTimeout(function () { copyBtn.textContent = "Copy link"; }, 2000);
            }).catch(function () {
              shareUrlInput.select();
            });
          } else {
            shareUrlInput.select();
            try { document.execCommand("copy"); copyBtn.textContent = "Copied!"; setTimeout(function () { copyBtn.textContent = "Copy link"; }, 2000); } catch (_) {}
          }
        };
      }
    }

    // Wire the email-capture follow-up form. POSTs to
    // /audit/:id/follow-up; the endpoint is rate-limited at 10/IP/day
    // and idempotent per (audit_id, email).
    var followupForm   = document.getElementById("followup-form");
    var followupInput  = document.getElementById("followup-email");
    var followupSubmit = document.getElementById("followup-submit");
    var followupMsg    = document.getElementById("followup-msg");
    if (followupForm && audit.id) {
      followupForm.onsubmit = function (e) {
        e.preventDefault();
        if (!followupMsg || !followupInput || !followupSubmit) return;
        var email = followupInput.value.trim();
        if (!email) return;
        followupMsg.textContent = "";
        followupMsg.className = "followup-msg";
        followupSubmit.disabled = true;
        followupSubmit.textContent = "Saving…";

        fetch(API_BASE + "/audit/" + encodeURIComponent(audit.id) + "/follow-up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email }),
        })
          .then(function (res) {
            return res.json().then(function (body) { return { status: res.status, body: body }; });
          })
          .then(function (r) {
            followupSubmit.disabled = false;
            followupSubmit.textContent = "Email me monthly";
            if (r.status === 200 && r.body.ok) {
              followupMsg.textContent = r.body.created
                ? "✓ You're on the list. We'll re-audit and email you next month."
                : "✓ Already on the list — you're set.";
              followupMsg.className = "followup-msg ok";
              followupInput.value = "";
            } else if (r.status === 429) {
              followupMsg.textContent = "Too many submissions from your network today. Try again tomorrow.";
              followupMsg.className = "followup-msg err";
            } else if (r.status === 400) {
              followupMsg.textContent = "That email doesn't look right. Double-check and resubmit.";
              followupMsg.className = "followup-msg err";
            } else {
              followupMsg.textContent = "Something went wrong on our end. Please try again in a minute.";
              followupMsg.className = "followup-msg err";
            }
          })
          .catch(function () {
            followupSubmit.disabled = false;
            followupSubmit.textContent = "Email me monthly";
            followupMsg.textContent = "Couldn't reach the server. Check your connection and try again.";
            followupMsg.className = "followup-msg err";
          });
      };
    }

    results.classList.add("show");
  }
})();
