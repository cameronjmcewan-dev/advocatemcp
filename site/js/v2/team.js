/* v2 Team & Access page — owner-only invite/remove/role-change UI for
 * the tenant's team. Backend lives in worker/src/routes/team.ts and was
 * shipped as part of the Apr 27 2026 Enterprise honesty pass:
 *
 *   GET    /api/client/team                — list members + caps
 *   POST   /api/client/team/invite         — invite by email
 *   DELETE /api/client/team/:user_id       — remove member
 *   PATCH  /api/client/team/:user_id/role  — change role
 *
 * Plan caps: base=1 (owner only), pro=5, enterprise=∞. Roles:
 * owner / editor / viewer. The server enforces caps; the frontend just
 * mirrors the cap so the UI surfaces an Upgrade CTA before the user
 * tries something the server would reject.
 *
 * This module was lifted out of settings.js (Apr 27 vintage) when Team
 * & Access got promoted to its own page. Settings still links here so
 * tenants who remember the old location aren't lost.
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function planChipClass(plan) {
    return plan === 'enterprise' ? 'enterprise' : plan === 'pro' ? 'maroon' : 'sage';
  }

  function planLabel(plan) {
    if (plan === 'enterprise') return 'Enterprise';
    if (plan === 'pro')        return 'Pro';
    return 'Base';
  }

  function roleChip(role) {
    const map = { owner: 'maroon', editor: 'sage', viewer: '' };
    return `<span class="chip ${map[role] || ''}" style="font-size:10.5px;padding:2px 8px">${esc(role)}</span>`;
  }

  // ── fetch ─────────────────────────────────────────────────────────
  //
  // GET /api/client/team returns:
  //   { members: [{ user_id, email, full_name, role, pending_invite }],
  //     caller_role: 'owner'|'editor'|'viewer',
  //     plan: 'base'|'pro'|'enterprise',
  //     cap: number|null,        // null === enterprise unlimited
  //     current_count: number }

  async function fetchReal() {
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!af) throw new Error('AMCP.authedFetch not available — did dashboard-auth.js load?');
    const res = await af('/api/client/team');
    if (!res.ok) throw new Error('Could not load team (HTTP ' + res.status + ')');
    return res.json();
  }

  // ── demo ──────────────────────────────────────────────────────────

  function demoData() {
    return {
      members: [
        { user_id: 'demo-owner', email: 'you@example.com', full_name: 'Cameron McEwan', role: 'owner', pending_invite: false },
        { user_id: 'demo-edit',  email: 'maya@example.com', full_name: 'Maya Park',      role: 'editor', pending_invite: false },
        { user_id: 'demo-view',  email: 'sam@example.com',  full_name: 'Sam Lin',        role: 'viewer', pending_invite: true  },
      ],
      caller_role:   'owner',
      plan:          'pro',
      cap:           5,
      current_count: 3,
    };
  }

  // ── render ────────────────────────────────────────────────────────
  //
  // afterMount handles all click + change events via delegation on the
  // #team-list container, so render only needs to emit static HTML.

  function render(data) {
    const d = data || {};
    const plan          = d.plan || 'base';
    const cap           = d.cap;                  // null = unlimited
    const currentCount  = d.current_count || 0;
    const callerRole    = d.caller_role || 'viewer';
    const isOwner       = callerRole === 'owner';
    const atCap         = cap !== null && currentCount >= cap;
    const isUnlimited   = cap === null;

    const capLine = isUnlimited
      ? `${currentCount} member${currentCount === 1 ? '' : 's'} · unlimited on ${esc(planLabel(plan))}`
      : `${currentCount} of ${cap} member${cap === 1 ? '' : 's'} · ${esc(planLabel(plan))} plan`;

    const upgradeCta = (atCap && plan !== 'enterprise') ? `
      <div style="margin-top:8px;font-size:13px;color:var(--muted)">
        At your plan's cap. <a href="/Billing.html" style="color:var(--maroon);font-weight:500">Upgrade${plan === 'base' ? ' to Pro' : ' to Enterprise'}</a> to add more teammates.
      </div>` : '';

    // Member rows are rendered into #team-list by afterMount via
    // renderTeamList(); we emit a placeholder here so the static HTML
    // has the right structure even before the dynamic state attaches.
    return `
      <section class="card-dash">
        <div class="card-head">
          <div>
            <h3>Team &amp; Access <span class="chip ${planChipClass(plan)}" style="margin-left:6px">${esc(planLabel(plan))}</span></h3>
            <div class="sub" id="team-cap-sub">${esc(capLine)}</div>
            ${upgradeCta}
          </div>
          ${isOwner && !atCap ? '<button class="btn btn-primary btn-sm" id="btn-invite-member" type="button">Invite teammate</button>' : ''}
        </div>
        <div id="team-list"></div>
      </section>

      <section class="card-dash" style="margin-top:16px">
        <div class="card-head">
          <div>
            <h3>About roles</h3>
            <div class="sub">What each access level can do.</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;padding:6px 4px 14px">
          <div class="set-row" style="flex-direction:column;align-items:flex-start;gap:6px">
            <strong>${roleChip('owner')} Owner</strong>
            <p style="margin:0;font-size:13px;color:var(--ink-2);line-height:1.5">Billing, team management, profile, locations, revenue config. Created automatically at signup.</p>
          </div>
          <div class="set-row" style="flex-direction:column;align-items:flex-start;gap:6px">
            <strong>${roleChip('editor')} Editor</strong>
            <p style="margin:0;font-size:13px;color:var(--ink-2);line-height:1.5">Profile, locations, revenue config. Cannot manage team or billing.</p>
          </div>
          <div class="set-row" style="flex-direction:column;align-items:flex-start;gap:6px">
            <strong>${roleChip('viewer')} Viewer</strong>
            <p style="margin:0;font-size:13px;color:var(--ink-2);line-height:1.5">Read-only access to dashboards. Cannot edit anything.</p>
          </div>
        </div>
      </section>
    `;
  }

  // ── afterMount — wires invite / role-change / remove handlers ─────
  //
  // We keep the cached payload + UI flags (inviting, editingRoleFor) in
  // closure-scope so each re-render after a successful API call doesn't
  // reset state. loadTeam() refetches via authedFetch and re-renders
  // the #team-list innerHTML in place.

  function afterMount(data) {
    const teamList = document.getElementById('team-list');
    const inviteBtn = document.getElementById('btn-invite-member');
    const af = window.AMCP && window.AMCP.authedFetch;
    if (!teamList || !af) return;

    let inviting = false;
    let editingRoleFor = null;
    let cachedTeam = data || null;

    function renderTeamList() {
      if (!cachedTeam) {
        teamList.innerHTML = '<div style="padding:18px;color:var(--muted);font-size:13.5px;text-align:center">Loading team…</div>';
        return;
      }
      const { members, caller_role } = cachedTeam;

      const rows = (members || []).map((m) => {
        const isOwnerRow   = m.role === 'owner';
        const isEditingRole = editingRoleFor === m.user_id;
        const showActions  = caller_role === 'owner' && !isOwnerRow;
        return `<div class="set-row" data-user-id="${esc(m.user_id)}" style="align-items:center;gap:12px">
          <div class="l" style="flex:1">
            <strong>${esc(m.email)}${m.full_name ? ` <span style="font-weight:400;color:var(--muted)">· ${esc(m.full_name)}</span>` : ''}</strong>
            <div style="font-size:12px;color:var(--muted);margin-top:3px;display:flex;align-items:center;gap:6px">
              ${roleChip(m.role)}
              ${m.pending_invite ? '<span class="chip" style="font-size:10.5px;padding:2px 8px;background:rgba(232,168,56,.15);color:#b07515">Pending invite</span>' : ''}
            </div>
          </div>
          <div class="r" style="display:flex;gap:6px;flex-wrap:wrap">
            ${showActions && isEditingRole ? `
              <select class="key-input" data-act="role-select" data-user-id="${esc(m.user_id)}" style="font-size:13px;padding:6px 8px">
                <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option>
                <option value="owner">Transfer ownership →</option>
              </select>
              <button class="btn btn-ghost btn-sm" data-act="role-cancel">Cancel</button>
            ` : showActions ? `
              <button class="btn btn-ghost btn-sm" data-act="role-edit" data-user-id="${esc(m.user_id)}">Change role</button>
              <button class="btn btn-ghost btn-sm" data-act="remove" data-user-id="${esc(m.user_id)}" style="color:var(--red);border-color:rgba(248,81,73,.35)">Remove</button>
            ` : ''}
          </div>
        </div>`;
      }).join('');

      const inviteForm = inviting && caller_role === 'owner' ? `
        <div class="set-row" style="align-items:flex-end;gap:12px;flex-wrap:wrap;background:var(--paper-2)">
          <div style="flex:1;display:grid;grid-template-columns:1fr auto;gap:8px;min-width:280px">
            <input type="email" id="invite-email" class="key-input" placeholder="teammate@example.com" autocomplete="email">
            <select id="invite-role" class="key-input" style="font-size:13.5px">
              <option value="viewer">Viewer (read-only)</option>
              <option value="editor">Editor (can edit)</option>
            </select>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-primary btn-sm" data-act="invite-send">Send invite</button>
            <button class="btn btn-ghost btn-sm" data-act="invite-cancel">Cancel</button>
          </div>
        </div>` : '';

      teamList.innerHTML = (rows || `<div style="padding:18px;color:var(--muted);font-size:13.5px;text-align:center">No team members yet.</div>`) + inviteForm;
    }

    async function loadTeam() {
      try {
        const res = await af('/api/client/team');
        if (!res.ok) throw new Error('fetch failed');
        cachedTeam = await res.json();
        renderTeamList();
      } catch (_) {
        teamList.innerHTML = '<div style="padding:18px;color:var(--red);font-size:13.5px">Could not load team. Try refreshing.</div>';
      }
    }

    if (inviteBtn) {
      inviteBtn.addEventListener('click', () => { inviting = true; renderTeamList(); });
    }

    teamList.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      const id  = btn.getAttribute('data-user-id');

      if (act === 'role-edit')      { editingRoleFor = id; renderTeamList(); return; }
      if (act === 'role-cancel')    { editingRoleFor = null; renderTeamList(); return; }
      if (act === 'invite-cancel')  { inviting = false; renderTeamList(); return; }

      if (act === 'invite-send') {
        const email   = (document.getElementById('invite-email') || {}).value || '';
        const roleSel = (document.getElementById('invite-role')  || {}).value || 'viewer';
        if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          window.AMCP.toast.error('Enter a valid email');
          return;
        }
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
          const res = await af('/api/client/team/invite', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ email: email.trim(), role: roleSel }),
          });
          if (res.status === 402) {
            const j = await res.json().catch(() => ({}));
            window.AMCP.toast.error("You've hit your plan's team-member cap", {
              detail: j.message || 'Upgrade to add more.',
              actions: [{ label: 'See plans →', kind: 'primary', onClick: () => { window.location.href = '/Billing.html'; } }],
            });
            btn.disabled = false; btn.textContent = 'Send invite';
            return;
          }
          if (res.status === 409) {
            window.AMCP.toast.info('Already on your team', { detail: 'That person is already a team member.' });
            btn.disabled = false; btn.textContent = 'Send invite';
            return;
          }
          if (!res.ok) throw new Error('failed');
          inviting = false;
          await loadTeam();
          window.AMCP.toast.success('Invite sent', { detail: "They'll receive an email with a magic link." });
        } catch (_) {
          btn.disabled = false; btn.textContent = 'Send invite';
          window.AMCP.toast.error("Couldn't send invite", { detail: 'Try again in a moment.' });
        }
        return;
      }

      if (act === 'remove') {
        if (!(await window.AMCP.toast.confirm('Remove this team member?', {
          detail: "They'll lose access immediately.",
          confirmLabel: 'Remove',
          danger: true,
        }))) return;
        try {
          const res = await af('/api/client/team/' + encodeURIComponent(id), { method: 'DELETE' });
          if (res.status === 409) {
            const j = await res.json().catch(() => ({}));
            window.AMCP.toast.error("Can't remove this member", {
              detail: j.error === 'cannot_remove_owner'
                ? 'Demote this owner to editor or viewer first, then remove.'
                : "You can't remove yourself.",
            });
            return;
          }
          if (!res.ok) throw new Error('failed');
          await loadTeam();
          window.AMCP.toast.success('Team member removed');
        } catch (_) {
          window.AMCP.toast.error("Couldn't remove", { detail: 'Try again in a moment.' });
        }
        return;
      }
    });

    // Role-change dropdown — separate listener for `change` (clicks on
    // <option> don't bubble as button clicks).
    teamList.addEventListener('change', async (e) => {
      const sel = e.target.closest('select[data-act="role-select"]');
      if (!sel) return;
      const id   = sel.getAttribute('data-user-id');
      const role = sel.value;
      if (role === 'owner') {
        if (!(await window.AMCP.toast.confirm('Transfer ownership?', {
          detail: "You'll become an editor and they'll have full control over billing and team.",
          confirmLabel: 'Transfer ownership',
          danger: true,
        }))) {
          sel.value = (cachedTeam.members.find(m => m.user_id === id) || {}).role || 'viewer';
          return;
        }
      }
      try {
        const res = await af('/api/client/team/' + encodeURIComponent(id) + '/role', {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ role }),
        });
        if (!res.ok) throw new Error('failed');
        editingRoleFor = null;
        await loadTeam();
        window.AMCP.toast.success('Role updated');
      } catch (_) {
        window.AMCP.toast.error("Couldn't change role", { detail: 'Try again in a moment.' });
      }
    });

    // Initial paint of the member list using the data already fetched
    // by AMCP_SHELL — saves a redundant round-trip on first load.
    renderTeamList();
  }

  window.AMCP_TEAM_ACCESS = {
    demo:       demoData,
    fetch:      fetchReal,
    render:     render,
    afterMount: afterMount,
  };
})();
