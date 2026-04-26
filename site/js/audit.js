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
    btn.textContent = "See what AI thinks of my site";
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
    btn.textContent = "Running...";
    loading.classList.add("show");

    var payload = { domain: domain, category: category };
    if (location) payload.location = location;

    // Fire BOTH calls in parallel: the visibility audit (existing flow)
    // and the citation-readiness scoring (new). They're independent on
    // the backend (different endpoints, different rate limits, different
    // cost paths) so doing both simultaneously costs the visitor no
    // extra wall-clock time. We treat readiness as a "best-effort
    // companion" — if it fails (rate-limit, fetch error, judge
    // hiccup), we still render the visibility results with a soft
    // "score not available" note.
    var visibilityPromise = fetch(API_BASE + "/audit/run", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .catch(function (err) {
        // Surface the actual error so it's diagnosable. "Failed to fetch"
        // typically means CORS blocked, network blocked, or browser
        // extension blocked; the console message is the only way to tell
        // them apart from the user side.
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[audit/visibility] fetch failed:", err);
        }
        return { status: 0, body: { error: "network_error", _err: String(err) } };
      });

    // Citation-readiness needs a full URL. The form's `domain` field is
    // a URL input so it should already be a complete URL — but we
    // defensively handle the bare-domain case ("yourbusiness.com").
    var fullUrl = /^https?:\/\//i.test(domain) ? domain : "https://" + domain;
    var readinessPromise = fetch(API_BASE + "/audit/citation-readiness", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: fullUrl }),
    })
      .then(function (res) {
        return res.json().then(function (body) { return { status: res.status, body: body }; });
      })
      .catch(function (err) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[audit/readiness] fetch failed:", err);
        }
        return { status: 0, body: { ok: false, reason: "network_error", message: String(err) } };
      });

    Promise.all([visibilityPromise, readinessPromise]).then(function (parts) {
      var v = parts[0]; // visibility result
      var r = parts[1]; // readiness result

      // Visibility error handling — match prior behaviour.
      var visibility = null;
      var visibilityError = null;
      if (v.status === 429 && v.body.error === "ip_rate_limited") {
        visibilityError = "You've run " + (v.body.limit || 3) + " audits in the last 24 hours. Try again tomorrow or reach out at support@advocatemcp.com.";
      } else if (v.status === 503 && v.body.error === "daily_budget_exhausted") {
        visibilityError = "The free audit hit its daily budget. Try again tomorrow.";
      } else if (v.status === 400) {
        visibilityError = "Couldn't read that input. Please check your website URL and category.";
      } else if (v.status >= 400 || !v.body.audit) {
        visibilityError = "Visibility check failed. Please try again in a minute.";
      } else {
        visibility = v.body.audit;
      }

      // Readiness error handling — softer, since visibility is the
      // primary signal. We still render visibility even if readiness
      // failed.
      var readiness = null;
      var readinessError = null;
      if (!r.body.ok) {
        var rmsg = r.body.message || "Score check unavailable.";
        if (r.body.reason === "ip_rate_limited")    rmsg = "Hit the daily score-check limit (5 per IP). Visibility check still ran below.";
        else if (r.body.reason === "budget_exhausted") rmsg = "Score-check budget hit. Visibility check still ran below.";
        else if (r.body.reason === "non_https" || r.body.reason === "invalid_url") rmsg = "URL didn't parse for the score check (must start with https://). Visibility check still ran below.";
        else if (r.body.reason === "private_address") rmsg = "URL resolved to a private/reserved address. Visibility check still ran below.";
        readinessError = rmsg;
      } else {
        readiness = r.body;
      }

      // If BOTH failed, show the visibility error (more informative)
      // and abort — there's nothing useful to render.
      if (!visibility && !readiness) {
        showError(visibilityError || readinessError || "Something went wrong on our end. Please try again in a minute.");
        return;
      }

      renderResults(visibility, !!(v.body && v.body.cached), readiness, readinessError, visibilityError);
    });
  });

  function renderResults(audit, cached, readiness, readinessError, visibilityError) {
    loading.classList.remove("show");
    btn.disabled = false;
    btn.textContent = "See what AI thinks of my site";

    // If only the readiness signal succeeded (visibility failed), build
    // a minimal audit shape so the rest of renderResults can run with
    // empty fields rather than crashing on null. Visibility cards still
    // render but show the specific failure reason from visibilityError
    // (rate limit hit, network error, etc.) instead of a generic
    // "didn't run" message.
    if (!audit) {
      audit = { domain: "", category: "", location: null, cited_count: 0, total_queries: 0, queries: [], created_at: new Date().toISOString(), id: null };
    }

    // ── Citation-readiness card ─────────────────────────────────────
    // Rendered as the FIRST card in the results stack. We prepend it
    // dynamically (not in the static HTML) so the audit page reflows
    // cleanly when only the visibility signal exists. The card lives
    // inside #results so the existing .show transition + share/email
    // capture flow keep working unchanged.
    var existingReadinessCard = document.getElementById("readiness-card-injected");
    if (existingReadinessCard) existingReadinessCard.remove();
    var readinessCard = document.createElement("div");
    readinessCard.id = "readiness-card-injected";
    readinessCard.className = "card";
    readinessCard.innerHTML = renderReadinessHtml(readiness, readinessError);
    results.insertBefore(readinessCard, results.firstChild);

    var score   = document.getElementById("score-big");
    var label   = document.getElementById("score-label");
    var detail  = document.getElementById("score-detail");
    var queries = document.getElementById("queries");
    var ctaTitle = document.getElementById("cta-title");
    var ctaBody  = document.getElementById("cta-body");

    // Tag the visibility card with "Score 2 of 2" so it's visually
    // paired with the readiness card above. Only inject the label
    // once — guard against re-render duplicating it.
    var scoreCard = score && score.closest(".score-card");
    if (scoreCard && !scoreCard.querySelector(".score-step-tag")) {
      var tag = document.createElement("div");
      tag.className = "score-step-tag";
      tag.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:14px;font-size:var(--tx-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--accent-bright);font-weight:600;";
      tag.innerHTML = '<span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:var(--accent-bright);"></span><span>Score 2 of 2 &middot; AI visibility for your category</span>';
      scoreCard.insertBefore(tag, scoreCard.firstChild);
    }

    var cited   = audit.cited_count || 0;
    var total   = audit.total_queries || 0;
    var rate    = total > 0 ? Math.round((cited / total) * 100) : 0;

    // If visibility audit failed (audit was synthesized empty in the
    // top-of-function fallback), render a soft "unavailable" state
    // rather than confusing "0/0" cards.
    if (!audit.id) {
      score.textContent = "n/a";
      score.classList.remove("zero", "some", "all");
      label.textContent = "Visibility check unavailable.";
      // Surface the actual failure reason instead of the old generic
      // copy. visibilityError comes from the form-submit handler and
      // explains the specific problem (rate limit hit, network error,
      // budget exhausted, browser blocked the request, etc.).
      detail.textContent = visibilityError
        ? visibilityError + " The score card above is still accurate."
        : "The category-visibility audit didn't run. Open your browser console for details.";
    } else {
      score.textContent = cited + " / " + total;
      score.classList.remove("zero", "some", "all");
      if (cited === 0)           score.classList.add("zero");
      else if (cited < total)    score.classList.add("some");
      else                       score.classList.add("all");

      label.textContent = "AI cited " + escapeHtml(audit.domain) + " in " + cited + " of " + total + " category queries (" + rate + "% citation rate)";
      detail.textContent = cached
        ? "Cached result from earlier today · 24h cache window"
        : "Live AI run · " + new Date(audit.created_at).toLocaleString();
    }

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
    //
    // Citation-readiness audits don't have a stored id (they're not
    // retained per the disclosure story), and a visibility-failed run
    // also leaves audit.id null. In both cases there's nothing to
    // share — hide the entire share row instead of leaving an empty
    // input + non-functional copy button. (Reported by user: "the
    // share report button doesn't work either.")
    var shareRow = document.getElementById("share-row");
    var shareUrlInput = document.getElementById("share-url");
    if (audit.id && shareUrlInput) {
      if (shareRow) shareRow.style.display = "";
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
    } else if (shareRow) {
      shareRow.style.display = "none";
    }

    // Wire the email-capture follow-up form. POSTs to
    // /audit/:id/follow-up; the endpoint is rate-limited at 10/IP/day
    // and idempotent per (audit_id, email).
    var followupForm   = document.getElementById("followup-form");
    var followupInput  = document.getElementById("followup-email");
    var followupSubmit = document.getElementById("followup-submit");
    var followupMsg    = document.getElementById("followup-msg");
    var followupCard   = document.getElementById("followup-card");
    // Same audit.id gate as the share row: monthly-followup POSTs to
    // /audit/:id/follow-up so it has nothing to attach to when the
    // visibility audit failed (or for citation-readiness-only runs).
    // Hide the card rather than letting the user submit into a 404.
    if (followupForm && audit.id) {
      if (followupCard) followupCard.style.display = "";
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
    } else if (followupCard) {
      followupCard.style.display = "none";
    }

    results.classList.add("show");
  }

  /* Render the citation-readiness card HTML.
   *
   * Two render modes:
   *   - readiness present (judge succeeded): full breakdown — score
   *     wheel + horizontal bar (positioned vs WCC's 8.5 and the lowest
   *     archetype's 3.8), Claude judge reasoning quote, two-column
   *     signals checklist (present/missing), ranked improvements with
   *     predicted lift, methodology link footer.
   *   - readiness null + error set (judge failed/rate-limited/etc.):
   *     a soft note in the same card so the visitor knows we tried,
   *     plus the visibility check still ran below.
   */
  function renderReadinessHtml(readiness, errorMsg) {
    if (!readiness) {
      return (
        '<div style="padding:20px 22px;">' +
          '<div style="font-size:var(--tx-xs);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;">Citation-readiness score</div>' +
          '<div style="font-size:var(--tx-md);color:var(--text);margin-bottom:6px;">Score check unavailable.</div>' +
          '<div style="font-size:var(--tx-sm);color:var(--muted);line-height:1.5;">' + escapeHtml(errorMsg || "Try again in a minute. The visibility check below still ran successfully.") + '</div>' +
        '</div>'
      );
    }

    var pct = Math.max(0, Math.min(100, (readiness.score / readiness.score_max) * 100));
    var wouldCiteText = readiness.would_cite
      ? '<span style="color:var(--green,#3fb950);">would likely cite</span>'
      : '<span style="color:var(--accent-bright);">unlikely to cite as-is</span>';

    var presentList = (readiness.signals_present || []).map(function (s) {
      return '<li style="padding:5px 0;color:var(--text);">'
           + '<span style="color:var(--green,#3fb950);margin-right:8px;">&#10003;</span>'
           + escapeHtml(s) + '</li>';
    }).join("") || '<li style="color:var(--muted);">No structured signals detected.</li>';

    var missingList = (readiness.signals_missing || []).map(function (s) {
      return '<li style="padding:5px 0;color:var(--muted);">'
           + '<span style="color:var(--accent-bright);margin-right:8px;">&#10007;</span>'
           + escapeHtml(s) + '</li>';
    }).join("") || '<li style="color:var(--muted);">All checked signals present.</li>';

    var improvementsList = (readiness.improvements || []).map(function (i) {
      return '<div style="padding:14px 16px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-md);margin-bottom:10px;display:flex;gap:14px;align-items:flex-start;">'
           + '<div style="font-family:var(--font-serif);font-size:24px;color:var(--accent-bright);min-width:48px;text-align:center;line-height:1;">+' + i.expected_lift.toFixed(1) + '</div>'
           + '<div style="flex:1;font-size:var(--tx-sm);line-height:1.55;color:var(--text);">' + escapeHtml(i.reason) + '</div>'
           + '</div>';
    }).join("") || '<p style="color:var(--muted);font-size:var(--tx-sm);">No specific improvements suggested, your homepage scored well.</p>';

    return (
      '<div style="padding:24px;">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">' +
          '<span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:var(--accent-bright);"></span>' +
          '<span style="font-size:var(--tx-xs);letter-spacing:.08em;text-transform:uppercase;color:var(--accent-bright);font-weight:600;">Score 1 of 2 &middot; Citation-readiness</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;margin-bottom:18px;">' +
          '<div style="display:flex;align-items:baseline;gap:8px;">' +
            '<div style="font-family:var(--font-serif);font-size:64px;font-weight:400;line-height:1;color:var(--accent-bright);">' + readiness.score.toFixed(1) + '</div>' +
            '<div style="font-size:24px;color:var(--muted);">/ ' + readiness.score_max + '</div>' +
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
          '"' + escapeHtml(readiness.reasoning) + '"' +
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
          'Reproduce this score yourself: <a href="/methodology.html" style="color:var(--accent-bright);">methodology.html</a> publishes the full judge prompt + rubric. Page fetched ' + new Date(readiness.fetched_at).toLocaleString() + ' (' + Math.round(readiness.byte_length / 1024) + 'kb).' +
        '</div>' +
      '</div>'
    );
  }
})();
