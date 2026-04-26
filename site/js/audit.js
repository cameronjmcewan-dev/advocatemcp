/*!
 * Public GEO Audit client, posts to api.advocatemcp.com/audit/run,
 * renders results, wires CTA. Zero dependencies. Never throws,
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
        // Skip Google Maps "search shim" URLs, the host is just google.com
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
  // r.html can reuse it via copy/paste, the audit site has no module bundler.
  function renderLeaderboard(audit, bodyEl, headEl, cardEl) {
    if (!bodyEl) return;
    var lb = buildLeaderboard(audit, 5);
    if (lb.rows.length === 0) {
      // Hide the whole card on zero, no competitors means either an empty
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

  // Expose for r.html (which copies the same logic), keeps the
  // implementation in one place if both pages load this script. r.html
  // currently inlines its own copy; if we ever consolidate, this works.
  window.__advocateAuditLeaderboard = { buildLeaderboard: buildLeaderboard, renderLeaderboard: renderLeaderboard };

  // ── URL-param prefill, frictionless cold-outreach landing ─────────────
  // Cameron sends a prospect:
  //   advocatemcp.com/audit?domain=acme.com&category=plumber&location=Boise,TX
  // Fields auto-populate on load. Add ?auto=1 and the audit fires
  // immediately (no click required), for the truly hot pitch:
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
        // Not thrown to console, failure is already shown.
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
      ctaBody.textContent = "AI-driven discovery is already shifting how customers find businesses like yours. An Advocate agent gives every AI a structured, citation-ready answer about you, the difference between scraped guesswork and your real pitch.";
    } else if (cited < total) {
      ctaTitle.textContent = "You're showing up, but not consistently";
      ctaBody.textContent = "AI cited you on some queries and missed you on others. An Advocate agent gives every AI the same structured answer about your business, so you stop competing with your own HTML.";
    } else {
      ctaTitle.textContent = "You're cited, now control what AI says about you";
      ctaBody.textContent = "You're in the answer set. But AI is building the quote from scraped HTML. An Advocate agent lets you supply the exact structured pitch, the specialty, pricing, credentials, and CTA you want AIs to surface.";
    }

    // Build the competitor leaderboard: aggregate citation counts across
    // every query, exclude the tenant's own domain, surface the top 5.
    // This is the most actionable single insight in the audit, "here's
    // who's winning your category in AI", and computes entirely from
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
    // checks for, bare /onboarding keeps the empty-form behavior.
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
                : "✓ Already on the list, you're set.";
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

  // ── Citation-readiness widget (Apr 25 2026) ────────────────────────
  // Standalone form on the audit page. Hits POST /audit/citation-readiness
  // (Railway via api.advocatemcp.com, same base as the visibility audit).
  // Renders score + signals breakdown + improvements. Independent of the
  // visibility check; visitor can run either or both.
  (function readinessWidget() {
    var rForm    = document.getElementById("readiness-form");
    var rUrl     = document.getElementById("readiness-url");
    var rBtn     = document.getElementById("readiness-btn");
    var rLoading = document.getElementById("readiness-loading");
    var rError   = document.getElementById("readiness-error");
    var rResult  = document.getElementById("readiness-result");
    if (!rForm || !rUrl || !rBtn || !rLoading || !rError || !rResult) return;

    rForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var url = (rUrl.value || "").trim();
      if (!url) return;
      rBtn.disabled = true;
      rBtn.textContent = "Scoring...";
      rError.style.display = "none";
      rError.textContent = "";
      rResult.style.display = "none";
      rResult.innerHTML = "";
      rLoading.style.display = "block";

      fetch(API_BASE + "/audit/citation-readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url }),
      })
        .then(function (res) {
          return res.json().then(function (body) { return { status: res.status, body: body }; });
        })
        .then(function (out) {
          rLoading.style.display = "none";
          rBtn.disabled = false;
          rBtn.textContent = "Score my homepage";

          if (!out.body.ok) {
            var msg = out.body.message || "Something went wrong.";
            var hint = "";
            if (out.body.reason === "non_https")               hint = "Make sure the URL starts with https://";
            else if (out.body.reason === "private_address")    hint = "We only accept public, internet-reachable URLs.";
            else if (out.body.reason === "ip_rate_limited")    hint = "You've hit the daily limit (5 per IP). Try again tomorrow.";
            else if (out.body.reason === "budget_exhausted")   hint = "Our daily AI budget is exhausted. Resets after UTC midnight.";
            else if (out.body.reason === "wrong_content_type") hint = "The URL did not return HTML, make sure it is a public homepage.";
            else if (out.body.reason === "too_large")          hint = "Page is too large (over 500kb). Try a more focused page.";
            else if (out.body.reason === "timeout")            hint = "The site took too long to respond.";
            else if (out.body.reason === "no_api_key")         hint = "Server config is missing the API key, let us know.";
            rError.innerHTML =
              '<strong style="color:var(--text);display:block;margin-bottom:6px;">Could not score that URL</strong>' +
              '<span style="color:var(--muted);">' + escapeHtml(msg) + (hint ? ' ' + escapeHtml(hint) : '') + '</span>';
            rError.style.display = "block";
            return;
          }

          renderReadinessResult(out.body);
        })
        .catch(function (err) {
          rLoading.style.display = "none";
          rBtn.disabled = false;
          rBtn.textContent = "Score my homepage";
          rError.innerHTML =
            '<strong style="color:var(--text);display:block;margin-bottom:6px;">Network error</strong>' +
            '<span style="color:var(--muted);">' + escapeHtml(String(err && err.message ? err.message : err)) + '</span>';
          rError.style.display = "block";
        });
    });

    /* Render the result panel: score wheel + signals checklist +
     * improvements list + judge reasoning + how-it-compares note. */
    function renderReadinessResult(body) {
      var pct = Math.max(0, Math.min(100, (body.score / body.score_max) * 100));
      var wouldCiteText = body.would_cite
        ? '<span style="color:var(--green,#3fb950);">would likely cite</span>'
        : '<span style="color:var(--accent-bright);">unlikely to cite as-is</span>';

      var presentList = (body.signals_present || []).map(function (s) {
        return '<li style="padding:5px 0;color:var(--text);">'
             + '<span style="color:var(--green,#3fb950);margin-right:8px;">&#10003;</span>'
             + escapeHtml(s) + '</li>';
      }).join("") || '<li style="color:var(--muted);">No structured signals detected.</li>';

      var missingList = (body.signals_missing || []).map(function (s) {
        return '<li style="padding:5px 0;color:var(--muted);">'
             + '<span style="color:var(--accent-bright);margin-right:8px;">&#10007;</span>'
             + escapeHtml(s) + '</li>';
      }).join("") || '<li style="color:var(--muted);">All checked signals present.</li>';

      var improvementsList = (body.improvements || []).map(function (i) {
        return '<div style="padding:14px 16px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-md);margin-bottom:10px;display:flex;gap:14px;align-items:flex-start;">'
             + '<div style="font-family:var(--font-serif);font-size:24px;color:var(--accent-bright);min-width:48px;text-align:center;line-height:1;">+' + i.expected_lift.toFixed(1) + '</div>'
             + '<div style="flex:1;font-size:var(--tx-sm);line-height:1.55;color:var(--text);">' + escapeHtml(i.reason) + '</div>'
             + '</div>';
      }).join("") || '<p style="color:var(--muted);font-size:var(--tx-sm);">No specific improvements suggested, your homepage scored well.</p>';

      rResult.innerHTML =
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:24px;">' +
          '<div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:18px;">' +
            '<div style="display:flex;align-items:baseline;gap:8px;">' +
              '<div style="font-family:var(--font-serif);font-size:64px;font-weight:400;line-height:1;color:var(--accent-bright);">' + body.score.toFixed(1) + '</div>' +
              '<div style="font-size:24px;color:var(--muted);">/ ' + body.score_max + '</div>' +
            '</div>' +
            '<div style="flex:1;min-width:200px;">' +
              '<div style="font-size:var(--tx-sm);color:var(--muted);margin-bottom:6px;">Citation-readiness, the judge ' + wouldCiteText + ' your page.</div>' +
              '<div style="height:8px;background:var(--surface-2);border-radius:999px;overflow:hidden;border:1px solid var(--border);">' +
                '<div style="height:100%;width:' + pct + '%;background:var(--accent-bright);"></div>' +
              '</div>' +
              '<div style="margin-top:8px;font-size:var(--tx-xs);color:var(--muted);">For comparison: WCC (Advocate-enabled) scores 8.5; the lowest archetype on our homepage scores 3.8.</div>' +
            '</div>' +
          '</div>' +

          '<div style="padding:16px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-md);margin-bottom:18px;font-size:var(--tx-sm);line-height:1.55;color:var(--text);font-style:italic;">' +
            '<strong style="font-style:normal;color:var(--muted);font-size:var(--tx-xs);letter-spacing:.06em;text-transform:uppercase;display:block;margin-bottom:6px;">Claude judge reasoning</strong>' +
            '"' + escapeHtml(body.reasoning) + '"' +
          '</div>' +

          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px;">' +
            '<div>' +
              '<div style="font-size:var(--tx-xs);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">What you have</div>' +
              '<ul style="list-style:none;padding:0;margin:0;font-size:var(--tx-sm);">' + presentList + '</ul>' +
            '</div>' +
            '<div>' +
              '<div style="font-size:var(--tx-xs);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;">What is missing</div>' +
              '<ul style="list-style:none;padding:0;margin:0;font-size:var(--tx-sm);">' + missingList + '</ul>' +
            '</div>' +
          '</div>' +

          '<div>' +
            '<div style="font-size:var(--tx-xs);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;">Top improvements (sorted by predicted lift)</div>' +
            improvementsList +
          '</div>' +

          '<div style="margin-top:20px;padding-top:18px;border-top:1px solid var(--border);font-size:var(--tx-xs);color:var(--muted);line-height:1.5;">' +
            'Reproduce this score yourself: <a href="/methodology.html" style="color:var(--accent-bright);">methodology.html</a> publishes the full judge prompt + rubric. Page fetched ' + new Date(body.fetched_at).toLocaleString() + ' (' + Math.round(body.byte_length / 1024) + 'kb).' +
          '</div>' +
        '</div>';

      rResult.style.display = "block";
      // Smooth scroll to result so the visitor sees it without manual scroll
      var top = rResult.getBoundingClientRect().top + window.pageYOffset - 80;
      window.scrollTo({ top: top, behavior: "smooth" });
    }
  })();
})();
