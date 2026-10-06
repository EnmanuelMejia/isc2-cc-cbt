/* Interstitium Labs — simulated web-console exercises (enterprise CBT).
   Vanilla JS, zero dependencies, ES5-compatible.
   Renders console-sim cards from content.json "consoleSims" into #consoleBody
   inside #view-console (static markup lives in templates/bootcamp.html).
   Each console is a LOCAL SANDBOX: a simulated UI panel (header, sidebar,
   main area) whose clickable elements mutate a simulated state object.
   Tasks validate against that state — NOTHING here touches real systems,
   real cloud accounts, or the network. Every console carries a SIMULATED
   badge and a sandbox notice. This matches the existing engine contract
   (terminal.js / labs.js are sandboxes too).

   Progress persists to localStorage 'ilb-bootcamp-<slug>-console-v1'.
   Listens for the coordinator's CustomEvent 'ilb:view' with
   e.detail === 'console'. Exposes window.ConsoleView = {render}.

   ================= ACTION VOCABULARY (for content authors) =================
   Each task's validate is {action, params}; params are matched as a SUBSET of
   the action's actual params (extra actual params are fine). Numbers typed in
   forms ("80", "3") are coerced to numbers before matching, so authors may
   write params with real JSON numbers.

   aws-vpc (simulated AWS VPC console):
     create-vpc        {name, cidr}                 -> registers a VPC
     create-subnet     {vpc, cidr, az}              -> subnet inside a VPC
     create-igw        {vpc}                        -> internet gateway on a VPC
     attach-igw        {igw, vpc}                   -> attaches gateway to VPC
     create-route-table {vpc}                      -> route table on a VPC
     add-route         {table, dest, target}        -> route dest via target
     associate-route-table {table, subnet}         -> binds table to subnet
     create-sg         {vpc, name}                  -> security group on a VPC
     add-sg-rule       {sg, protocol, port, cidr}   -> inbound rule on a group
     launch-instance   {subnet, sg, name}          -> EC2-like instance
   aws-iam (simulated AWS IAM console):
     create-user       {name}
     create-group      {name}
     add-user-to-group {user, group}
     create-role       {name}
     create-policy     {name}
     attach-policy     {kind, name, policy}         -> kind: user|group|role
     enable-mfa        {user}
   azure-portal (simulated Azure portal):
     create-rg         {name, location}
     create-vnet       {rg, cidr}
     create-vm         {rg, name, size}
     create-nsg        {rg, name}
     add-nsg-rule      {nsg, port, priority}
     assign-rbac       {scope, principal, role}
   k8s-dashboard (simulated Kubernetes dashboard):
     create-namespace  {name}
     deploy            {name, namespace, image, replicas}
     expose-service    {deployment, port, type}    -> type: ClusterIP|NodePort|LoadBalancer
     scale             {deployment, replicas}
     create-configmap  {name, namespace}
   firewall (simulated host firewall):
     add-rule          {chain, protocol, port, source, action}  -> chain: INPUT|OUTPUT|FORWARD; action: ACCEPT|DROP
     delete-rule       {id}
     set-default-policy {chain, policy}            -> policy: ACCEPT|DROP
   switch-cli (simulated switch CLI; the command box parses typed commands):
     create-vlan       {id, name}                   (CLI: vlan <id> name <name>)
     assign-port       {port, vlan}                 (CLI: interface <port> access vlan <id>)
     set-trunk         {port}                       (CLI: interface <port> trunk)
     save-config       {}                           (CLI: write memory | copy run start)
     "show vlan" prints the VLAN table (no state change).
   linux-desktop (simulated Linux file manager / permissions):
     select            {path}                       -> selects a file row (UI helper)
     chmod             {path, mode}                 -> e.g. mode "640"
     chown             {path, owner}
     create-file       {path}
     create-dir        {path}
     delete            {path}
   sql-studio (simulated SQL workbench):
     create-table      {name, columns}              -> columns: comma-separated string
     create-index      {table, column}
     run-query         {sql}                        -> MATCHING OVERRIDE: authors write
        params as {match: "<substring>"} and the run passes when the typed SQL
        contains that substring (case-insensitive).
   git-host (simulated git hosting PR review UI):
     create-branch     {name}
     open-pr           {title, base, head}
     approve-pr        {pr}                         -> pr: PR number
     request-changes   {pr, comment}
     add-comment       {pr, text}
     merge-pr          {pr}
   cicd-pipeline (simulated CI/CD pipeline console):
     trigger-build     {}                           -> resets stages to running/pending
     retry-stage       {stage}
     approve-stage     {stage}                      -> approves a gated stage
     set-variable      {key, value}
   siem-dashboard (simulated SIEM alert console):
     acknowledge-alert {id}
     assign-alert      {id, analyst}
     escalate          {id}
     isolate-host      {host}
     create-rule       {name, query}
   ticketing (simulated ITSM incident queue):
     create-ticket     {title, priority}            -> priority: P1..P4
     assign-ticket     {id, assignee}
     update-status     {id, status}                 -> status: open|in-progress|on-hold|resolved
     add-note          {id, text}
     resolve-ticket    {id, resolution}
   code-editor (simulated IDE with debugger):
     open-file         {name}
     toggle-breakpoint {file, line}                -> line: 1-based
     step-over         {}
     run-to-breakpoint {}
     fix-line          {file, line, text}
     inspect-variable  {name}                      -> prints a simulated value (no state change)
   db-admin (simulated database admin console):
     create-database   {name}
     create-user       {name}
     grant-priv        {db, user, priv}             -> priv e.g. SELECT, ALL
     backup            {db}
     set-parameter     {key, value}
   generic-web (fallback form-based console):
     set-field         {id, value}
     submit-form       {}
   ============================================================================
*/
(function () {
  'use strict';

  var SLUG = (window.BOOTCAMP_PAGE && window.BOOTCAMP_PAGE.slug) || '';
  var LS_KEY = 'ilb-bootcamp-' + SLUG + '-console-v1';

  var state = {
    sims: null,     /* array from content.json */
    loaded: false,
    activeId: null, /* console sim currently open */
    done: {},       /* {simId: true} */
    inst: null      /* active console instance */
  };

  /* ---------- utils ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }
  function loadDone() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveDone() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.done)); }
    catch (e) { /* storage unavailable — session-only progress */ }
  }
  function simById(id) {
    for (var i = 0; i < state.sims.length; i++) {
      if (state.sims[i].id === id) return state.sims[i];
    }
    return null;
  }
  function doneCount() {
    var n = 0, i;
    for (i = 0; i < state.sims.length; i++) {
      if (state.done[state.sims[i].id]) n++;
    }
    return n;
  }
  function coerce(v) {
    if (typeof v !== 'string') return v;
    var t = v.trim();
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
    return v;
  }
  function subsetMatch(exp, act) {
    var k;
    if (exp === act) return true;
    if (exp == null || act == null) return exp === act;
    if (typeof exp !== 'object' || typeof act !== 'object') return exp === act;
    if (Object.prototype.toString.call(exp) === '[object Array]') {
      if (Object.prototype.toString.call(act) !== '[object Array]') return false;
      if (exp.length !== act.length) return false;
      for (k = 0; k < exp.length; k++) {
        if (!subsetMatch(exp[k], act[k])) return false;
      }
      return true;
    }
    for (k in exp) {
      if (exp.hasOwnProperty(k)) {
        if (!act.hasOwnProperty(k)) return false;
        if (!subsetMatch(exp[k], act[k])) return false;
      }
    }
    return true;
  }

  /* ---------- injected stylesheet (console-specific selectors) ---------- */
  var CSIM_CSS = [
    '.csim-badge{display:inline-block;font:700 11px var(--mono);letter-spacing:.12em;' +
      'color:#0b0b0b;background:var(--accent);border-radius:6px;padding:4px 10px;white-space:nowrap}',
    '.csim-sandbox{font-size:12px;color:var(--muted);border:1px dashed var(--line-strong);' +
      'border-radius:8px;padding:8px 12px;margin:10px 0 16px}',
    '.csim-layout{display:grid;grid-template-columns:210px 1fr;gap:14px}',
    '@media (max-width:760px){.csim-layout{grid-template-columns:1fr}}',
    '.csim-side{background:var(--surface);border:1px solid var(--line);border-radius:10px;' +
      'padding:10px;display:flex;flex-direction:column;gap:6px;align-self:start}',
    '.csim-sec{text-align:left;background:transparent;border:1px solid transparent;border-radius:8px;' +
      'padding:9px 12px;font-size:13px;cursor:pointer;color:var(--ink)}',
    '.csim-sec.on{background:var(--surface-2);border-color:var(--line)}',
    '.csim-main{background:var(--surface);border:1px solid var(--line);border-radius:10px;' +
      'padding:16px;min-height:280px;overflow-x:auto}',
    '.csim-topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
    '.csim-table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}',
    '.csim-table th{text-align:left;font:600 11px var(--mono);letter-spacing:.06em;color:var(--muted);' +
      'padding:8px 10px;border-bottom:1px solid var(--line)}',
    '.csim-table td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}',
    '.csim-form{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;' +
      'padding:14px;margin:12px 0;display:grid;gap:10px;max-width:560px}',
    '.csim-form label{font:600 11px var(--mono);letter-spacing:.06em;color:var(--muted);' +
      'display:grid;gap:4px}',
    '.csim-form input,.csim-form select{background:var(--surface);border:1px solid var(--line-strong);' +
      'border-radius:8px;color:var(--ink);padding:9px 11px;font-size:13px;width:100%;box-sizing:border-box}',
    '.csim-log{margin-top:14px;background:#0d1117;border:1px solid var(--line);border-radius:10px;' +
      'padding:12px 14px;font:12px/1.7 var(--mono);max-height:170px;overflow-y:auto}',
    '.csim-log .ok{color:#7ee787}.csim-log .dim{color:var(--muted)}',
    '.csim-task{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;' +
      'border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:var(--surface)}',
    '.csim-task.is-done{opacity:.75;border-color:var(--accent)}',
    '.csim-task .tick{font-weight:800;color:var(--accent)}',
    '.csim-cli{width:100%;box-sizing:border-box;background:#0d1117;color:#7ee787;border:1px solid var(--line);' +
      'border-radius:8px;padding:10px 12px;font:13px var(--mono)}',
    '.csim-editor{font:13px/1.8 var(--mono);background:#0d1117;border:1px solid var(--line);' +
      'border-radius:10px;padding:10px 0;overflow-x:auto}',
    '.csim-eline{display:block;padding:0 14px;cursor:pointer;white-space:pre}',
    '.csim-eline:hover{background:rgba(255,255,255,.04)}',
    '.csim-eline .ln{display:inline-block;width:2.6em;text-align:right;margin-right:1.2em;color:var(--muted)}',
    '.csim-eline .bp{display:inline-block;width:1.4em;color:#ff7b72}',
    '.csim-eline.at-cursor{background:rgba(126,231,135,.08)}'
  ].join('\n');
  var cssInjected = false;
  function injectCSS() {
    if (cssInjected || !document.head) return;
    var st = document.createElement('style');
    st.setAttribute('data-csim', '1');
    st.textContent = CSIM_CSS;
    document.head.appendChild(st);
    cssInjected = true;
  }

  /* ---------- shared HTML helpers ---------- */
  function formHtml(fields, action, btnLabel) {
    var h = '<div class="csim-form" data-cform="' + esc(action) + '">';
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      h += '<label>' + esc(f.label || f.n) +
        '<input data-field="' + esc(f.n) + '"' +
        (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') +
        (f.value != null ? ' value="' + esc(f.value) + '"' : '') + ' /></label>';
    }
    h += '<div><button class="btn small primary" data-cact="' + esc(action) +
      '" data-cformref="' + esc(action) + '">' + esc(btnLabel || 'Apply') + '</button></div></div>';
    return h;
  }
  function tableHtml(heads, rows, emptyMsg) {
    var h = '<table class="csim-table"><thead><tr>';
    for (var i = 0; i < heads.length; i++) h += '<th>' + esc(heads[i]) + '</th>';
    h += '</tr></thead><tbody>';
    if (!rows.length) {
      h += '<tr><td colspan="' + heads.length + '" style="color:var(--muted)">' +
        esc(emptyMsg || 'Nothing here yet \u2014 use the form below.') + '</td></tr>';
    }
    for (var r = 0; r < rows.length; r++) {
      h += '<tr>';
      for (var c = 0; c < rows[r].length; c++) h += '<td>' + rows[r][c] + '</td>';
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }
  function nextId(st, prefix) {
    st._n = (st._n || 1);
    return prefix + '-' + (st._n++);
  }
  function actionBtn(action, label, cparams, cls) {
    var h = '<button class="btn small ' + (cls || 'ghost') + '" data-cact="' + esc(action) + '"';
    if (cparams) {
      for (var k in cparams) {
        if (cparams.hasOwnProperty(k)) {
          h += ' data-cparam-' + esc(k) + '="' + esc(String(cparams[k])) + '"';
        }
      }
    }
    return h + '>' + esc(label) + '</button>';
  }

  /* ================= console definitions ================= */
  var CONSOLES = {};

  /* ----- aws-vpc ----- */
  CONSOLES['aws-vpc'] = {
    label: 'AWS VPC Console',
    init: function () {
      return { vpcs: [], subnets: [], igws: [], rts: [], sgs: [], instances: [], _n: 1 };
    },
    sections: ['VPCs', 'Subnets', 'Internet Gateways', 'Route Tables', 'Security Groups', 'Instances'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.vpcs.length; i++) {
          rows.push([esc(st.vpcs[i].id), esc(st.vpcs[i].name), esc(st.vpcs[i].cidr)]);
        }
        h = '<h4>VPCs</h4>' + tableHtml(['ID', 'Name', 'CIDR'], rows) +
          formHtml([{ n: 'name', label: 'NAME', ph: 'prod-vpc' },
            { n: 'cidr', label: 'CIDR', ph: '10.0.0.0/16' }], 'create-vpc', 'Create VPC');
      } else if (sec === 1) {
        var rows2 = [];
        for (i = 0; i < st.subnets.length; i++) {
          rows2.push([esc(st.subnets[i].id), esc(st.subnets[i].vpc), esc(st.subnets[i].cidr), esc(st.subnets[i].az)]);
        }
        h = '<h4>Subnets</h4>' + tableHtml(['ID', 'VPC', 'CIDR', 'AZ'], rows2) +
          formHtml([{ n: 'vpc', label: 'VPC NAME' }, { n: 'cidr', label: 'CIDR', ph: '10.0.1.0/24' },
            { n: 'az', label: 'AVAILABILITY ZONE', ph: 'us-east-1a' }], 'create-subnet', 'Create subnet');
      } else if (sec === 2) {
        var rows3 = [];
        for (i = 0; i < st.igws.length; i++) {
          rows3.push([esc(st.igws[i].id), esc(st.igws[i].vpc),
            st.igws[i].attached ? 'attached' : actionBtn('attach-igw', 'Attach',
              { igw: st.igws[i].id, vpc: st.igws[i].vpc }, 'primary')]);
        }
        h = '<h4>Internet Gateways</h4>' + tableHtml(['ID', 'VPC', 'State'], rows3) +
          formHtml([{ n: 'vpc', label: 'VPC NAME' }], 'create-igw', 'Create internet gateway');
      } else if (sec === 3) {
        var rows4 = [];
        for (i = 0; i < st.rts.length; i++) {
          var rt = st.rts[i], rts = [];
          for (var q = 0; q < rt.routes.length; q++) {
            rts.push(esc(rt.routes[q].dest) + ' \u2192 ' + esc(rt.routes[q].target));
          }
          rows4.push([esc(rt.id), esc(rt.vpc), rts.join('<br>') || '<span style="color:var(--muted)">local only</span>',
            esc((rt.assoc || []).join(', '))]);
        }
        h = '<h4>Route Tables</h4>' + tableHtml(['ID', 'VPC', 'Routes', 'Associated subnets'], rows4) +
          formHtml([{ n: 'vpc', label: 'VPC NAME' }], 'create-route-table', 'Create route table') +
          formHtml([{ n: 'table', label: 'ROUTE TABLE ID' }, { n: 'dest', label: 'DESTINATION', ph: '0.0.0.0/0' },
            { n: 'target', label: 'TARGET (IGW ID)' }], 'add-route', 'Add route') +
          formHtml([{ n: 'table', label: 'ROUTE TABLE ID' }, { n: 'subnet', label: 'SUBNET ID' }],
            'associate-route-table', 'Associate with subnet');
      } else if (sec === 4) {
        var rows5 = [];
        for (i = 0; i < st.sgs.length; i++) {
          var sg = st.sgs[i], rules = [];
          for (var w = 0; w < sg.rules.length; w++) {
            rules.push(esc(sg.rules[w].protocol) + ':' + esc(String(sg.rules[w].port)) +
              ' from ' + esc(sg.rules[w].cidr));
          }
          rows5.push([esc(sg.id), esc(sg.vpc), esc(sg.name), rules.join('<br>') || '<span style="color:var(--muted)">no rules</span>']);
        }
        h = '<h4>Security Groups</h4>' + tableHtml(['ID', 'VPC', 'Name', 'Inbound rules'], rows5) +
          formHtml([{ n: 'vpc', label: 'VPC NAME' }, { n: 'name', label: 'GROUP NAME', ph: 'web-sg' }],
            'create-sg', 'Create security group') +
          formHtml([{ n: 'sg', label: 'SECURITY GROUP ID' }, { n: 'protocol', label: 'PROTOCOL', ph: 'tcp' },
            { n: 'port', label: 'PORT', ph: '443' }, { n: 'cidr', label: 'SOURCE CIDR', ph: '0.0.0.0/0' }],
            'add-sg-rule', 'Add inbound rule');
      } else {
        var rows6 = [];
        for (i = 0; i < st.instances.length; i++) {
          rows6.push([esc(st.instances[i].id), esc(st.instances[i].name),
            esc(st.instances[i].subnet), esc(st.instances[i].sg), 'running']);
        }
        h = '<h4>Instances</h4>' + tableHtml(['ID', 'Name', 'Subnet', 'Security group', 'State'], rows6) +
          formHtml([{ n: 'name', label: 'INSTANCE NAME', ph: 'web-01' },
            { n: 'subnet', label: 'SUBNET ID' }, { n: 'sg', label: 'SECURITY GROUP ID' }],
            'launch-instance', 'Launch instance');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      if (action === 'create-vpc') {
        if (!p.name || !p.cidr) return null;
        var id = nextId(st, 'vpc');
        st.vpcs.push({ id: id, name: p.name, cidr: p.cidr });
        return 'VPC "' + p.name + '" (' + p.cidr + ') created as ' + id + '.';
      }
      if (action === 'create-subnet') {
        var v = findByName(st.vpcs, p.vpc);
        if (!v) return 'No VPC named "' + p.vpc + '" — create the VPC first.';
        var sid = nextId(st, 'subnet');
        st.subnets.push({ id: sid, vpc: v.name, cidr: p.cidr, az: p.az || '' });
        return 'Subnet ' + sid + ' (' + p.cidr + ') created in VPC "' + v.name + '".';
      }
      if (action === 'create-igw') {
        var v2 = findByName(st.vpcs, p.vpc);
        if (!v2) return 'No VPC named "' + p.vpc + '".';
        var gid = nextId(st, 'igw');
        st.igws.push({ id: gid, vpc: v2.name, attached: false });
        return 'Internet gateway ' + gid + ' created for VPC "' + v2.name + '".';
      }
      if (action === 'attach-igw') {
        for (i = 0; i < st.igws.length; i++) {
          if (st.igws[i].id === p.igw) {
            st.igws[i].attached = true;
            return 'Internet gateway ' + p.igw + ' attached to VPC "' + st.igws[i].vpc + '".';
          }
        }
        return 'Unknown internet gateway "' + p.igw + '".';
      }
      if (action === 'create-route-table') {
        var v3 = findByName(st.vpcs, p.vpc);
        if (!v3) return 'No VPC named "' + p.vpc + '".';
        var tid = nextId(st, 'rtb');
        st.rts.push({ id: tid, vpc: v3.name, routes: [], assoc: [] });
        return 'Route table ' + tid + ' created for VPC "' + v3.name + '".';
      }
      if (action === 'add-route') {
        var rt = findById(st.rts, p.table);
        if (!rt) return 'Unknown route table "' + p.table + '".';
        rt.routes.push({ dest: p.dest, target: p.target });
        return 'Route ' + p.dest + ' → ' + p.target + ' added to ' + rt.id + '.';
      }
      if (action === 'associate-route-table') {
        var rt2 = findById(st.rts, p.table);
        if (!rt2) return 'Unknown route table "' + p.table + '".';
        rt2.assoc.push(p.subnet);
        return 'Route table ' + rt2.id + ' associated with subnet ' + p.subnet + '.';
      }
      if (action === 'create-sg') {
        var v4 = findByName(st.vpcs, p.vpc);
        if (!v4) return 'No VPC named "' + p.vpc + '".';
        var sgid = nextId(st, 'sg');
        st.sgs.push({ id: sgid, vpc: v4.name, name: p.name, rules: [] });
        return 'Security group "' + p.name + '" created as ' + sgid + '.';
      }
      if (action === 'add-sg-rule') {
        var sg = findById(st.sgs, p.sg);
        if (!sg) return 'Unknown security group "' + p.sg + '".';
        sg.rules.push({ protocol: p.protocol || 'tcp', port: p.port, cidr: p.cidr || '0.0.0.0/0' });
        return 'Inbound rule ' + (p.protocol || 'tcp') + ':' + p.port + ' added to ' + sg.id + '.';
      }
      if (action === 'launch-instance') {
        var iid = nextId(st, 'i');
        st.instances.push({ id: iid, name: p.name || iid, subnet: p.subnet, sg: p.sg });
        return 'Instance ' + iid + ' ("' + (p.name || iid) + '") launched in ' + p.subnet + '.';
      }
      return null;
    }
  };
  function findByName(list, name) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === name || list[i].id === name) return list[i];
    }
    return null;
  }
  function findById(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id || list[i].name === id) return list[i];
    }
    return null;
  }

  /* ----- aws-iam ----- */
  CONSOLES['aws-iam'] = {
    label: 'AWS IAM Console',
    init: function () {
      return { users: [], groups: [], roles: [], policies: [], _n: 1 };
    },
    sections: ['Users', 'Groups', 'Roles', 'Policies'],
    body: function (st, sec) {
      var h = '', i, j;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.users.length; i++) {
          var u = st.users[i];
          rows.push([esc(u.name), esc(u.groups.join(', ')), u.mfa ? 'enabled' : 'off',
            esc(u.policies.join(', '))]);
        }
        h = '<h4>Users</h4>' + tableHtml(['Name', 'Groups', 'MFA', 'Attached policies'], rows) +
          formHtml([{ n: 'name', label: 'USER NAME' }], 'create-user', 'Create user') +
          formHtml([{ n: 'user', label: 'USER NAME' }], 'enable-mfa', 'Enable MFA') +
          formHtml([{ n: 'user', label: 'USER NAME' }, { n: 'group', label: 'GROUP NAME' }],
            'add-user-to-group', 'Add user to group');
      } else if (sec === 1) {
        var rows2 = [];
        for (i = 0; i < st.groups.length; i++) {
          rows2.push([esc(st.groups[i].name), esc(st.groups[i].members.join(', ')),
            esc(st.groups[i].policies.join(', '))]);
        }
        h = '<h4>Groups</h4>' + tableHtml(['Name', 'Members', 'Attached policies'], rows2) +
          formHtml([{ n: 'name', label: 'GROUP NAME' }], 'create-group', 'Create group');
      } else if (sec === 2) {
        var rows3 = [];
        for (i = 0; i < st.roles.length; i++) {
          rows3.push([esc(st.roles[i].name), esc(st.roles[i].policies.join(', '))]);
        }
        h = '<h4>Roles</h4>' + tableHtml(['Name', 'Attached policies'], rows3) +
          formHtml([{ n: 'name', label: 'ROLE NAME' }], 'create-role', 'Create role');
      } else {
        var rows4 = [];
        for (i = 0; i < st.policies.length; i++) rows4.push([esc(st.policies[i].name)]);
        h = '<h4>Policies</h4>' + tableHtml(['Name'], rows4) +
          formHtml([{ n: 'name', label: 'POLICY NAME' }], 'create-policy', 'Create policy') +
          formHtml([{ n: 'kind', label: 'TARGET KIND (user|group|role)' },
            { n: 'name', label: 'TARGET NAME' }, { n: 'policy', label: 'POLICY NAME' }],
            'attach-policy', 'Attach policy');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      if (action === 'create-user') {
        if (!p.name) return null;
        st.users.push({ name: p.name, groups: [], policies: [], mfa: false });
        return 'IAM user "' + p.name + '" created.';
      }
      if (action === 'create-group') {
        if (!p.name) return null;
        st.groups.push({ name: p.name, members: [], policies: [] });
        return 'IAM group "' + p.name + '" created.';
      }
      if (action === 'add-user-to-group') {
        var u = findByName(st.users, p.user), g = findByName(st.groups, p.group);
        if (!u) return 'Unknown user "' + p.user + '".';
        if (!g) return 'Unknown group "' + p.group + '".';
        if (u.groups.indexOf(g.name) < 0) u.groups.push(g.name);
        if (g.members.indexOf(u.name) < 0) g.members.push(u.name);
        return 'User "' + u.name + '" added to group "' + g.name + '".';
      }
      if (action === 'create-role') {
        if (!p.name) return null;
        st.roles.push({ name: p.name, policies: [] });
        return 'IAM role "' + p.name + '" created.';
      }
      if (action === 'create-policy') {
        if (!p.name) return null;
        st.policies.push({ name: p.name });
        return 'Policy "' + p.name + '" created.';
      }
      if (action === 'attach-policy') {
        var list = p.kind === 'group' ? st.groups : (p.kind === 'role' ? st.roles : st.users);
        var t = findByName(list, p.name);
        if (!t) return 'Unknown ' + p.kind + ' "' + p.name + '".';
        if (t.policies.indexOf(p.policy) < 0) t.policies.push(p.policy);
        return 'Policy "' + p.policy + '" attached to ' + p.kind + ' "' + t.name + '".';
      }
      if (action === 'enable-mfa') {
        var u2 = findByName(st.users, p.user);
        if (!u2) return 'Unknown user "' + p.user + '".';
        u2.mfa = true;
        return 'MFA enabled for user "' + u2.name + '".';
      }
      return null;
    }
  };

  /* ----- azure-portal ----- */
  CONSOLES['azure-portal'] = {
    label: 'Azure Portal',
    init: function () {
      return { rgs: [], vnets: [], vms: [], nsgs: [], _n: 1 };
    },
    sections: ['Resource Groups', 'Virtual Networks', 'Virtual Machines', 'NSGs'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.rgs.length; i++) rows.push([esc(st.rgs[i].name), esc(st.rgs[i].location)]);
        h = '<h4>Resource groups</h4>' + tableHtml(['Name', 'Location'], rows) +
          formHtml([{ n: 'name', label: 'NAME', ph: 'rg-prod' },
            { n: 'location', label: 'LOCATION', ph: 'eastus' }], 'create-rg', 'Create resource group');
      } else if (sec === 1) {
        var rows2 = [];
        for (i = 0; i < st.vnets.length; i++) rows2.push([esc(st.vnets[i].rg), esc(st.vnets[i].cidr)]);
        h = '<h4>Virtual networks</h4>' + tableHtml(['Resource group', 'CIDR'], rows2) +
          formHtml([{ n: 'rg', label: 'RESOURCE GROUP' }, { n: 'cidr', label: 'CIDR', ph: '10.1.0.0/16' }],
            'create-vnet', 'Create virtual network');
      } else if (sec === 2) {
        var rows3 = [];
        for (i = 0; i < st.vms.length; i++) {
          rows3.push([esc(st.vms[i].rg), esc(st.vms[i].name), esc(st.vms[i].size), 'running']);
        }
        h = '<h4>Virtual machines</h4>' + tableHtml(['Resource group', 'Name', 'Size', 'State'], rows3) +
          formHtml([{ n: 'rg', label: 'RESOURCE GROUP' }, { n: 'name', label: 'VM NAME', ph: 'vm-web-01' },
            { n: 'size', label: 'SIZE', ph: 'Standard_B2s' }], 'create-vm', 'Create VM');
      } else {
        var rows4 = [];
        for (i = 0; i < st.nsgs.length; i++) {
          var rules = [];
          for (var j = 0; j < st.nsgs[i].rules.length; j++) {
            rules.push('allow ' + st.nsgs[i].rules[j].port + ' (pri ' + st.nsgs[i].rules[j].priority + ')');
          }
          rows4.push([esc(st.nsgs[i].rg), esc(st.nsgs[i].name), rules.join('<br>') ||
            '<span style="color:var(--muted)">no rules</span>']);
        }
        h = '<h4>Network security groups</h4>' + tableHtml(['Resource group', 'Name', 'Rules'], rows4) +
          formHtml([{ n: 'rg', label: 'RESOURCE GROUP' }, { n: 'name', label: 'NSG NAME', ph: 'nsg-web' }],
            'create-nsg', 'Create NSG') +
          formHtml([{ n: 'nsg', label: 'NSG NAME' }, { n: 'port', label: 'PORT', ph: '443' },
            { n: 'priority', label: 'PRIORITY', ph: '100' }], 'add-nsg-rule', 'Add rule');
      }
      return h;
    },
    act: function (st, action, p) {
      if (action === 'create-rg') {
        if (!p.name) return null;
        st.rgs.push({ name: p.name, location: p.location || 'eastus' });
        return 'Resource group "' + p.name + '" created in ' + (p.location || 'eastus') + '.';
      }
      if (action === 'create-vnet') {
        if (!findByName(st.rgs, p.rg)) return 'Unknown resource group "' + p.rg + '".';
        st.vnets.push({ rg: p.rg, cidr: p.cidr });
        return 'Virtual network (' + p.cidr + ') created in "' + p.rg + '".';
      }
      if (action === 'create-vm') {
        if (!findByName(st.rgs, p.rg)) return 'Unknown resource group "' + p.rg + '".';
        st.vms.push({ rg: p.rg, name: p.name, size: p.size || 'Standard_B2s' });
        return 'VM "' + p.name + '" (' + (p.size || 'Standard_B2s') + ') created in "' + p.rg + '".';
      }
      if (action === 'create-nsg') {
        if (!findByName(st.rgs, p.rg)) return 'Unknown resource group "' + p.rg + '".';
        st.nsgs.push({ rg: p.rg, name: p.name, rules: [] });
        return 'NSG "' + p.name + '" created in "' + p.rg + '".';
      }
      if (action === 'add-nsg-rule') {
        var n = findByName(st.nsgs, p.nsg);
        if (!n) return 'Unknown NSG "' + p.nsg + '".';
        n.rules.push({ port: p.port, priority: p.priority });
        return 'NSG rule allow port ' + p.port + ' (priority ' + p.priority + ') added to "' + n.name + '".';
      }
      if (action === 'assign-rbac') {
        return 'Role "' + p.role + '" assigned to "' + p.principal + '" on scope "' + p.scope + '".';
      }
      return null;
    }
  };

  /* ----- k8s-dashboard ----- */
  CONSOLES['k8s-dashboard'] = {
    label: 'Kubernetes Dashboard',
    init: function () {
      return { namespaces: [{ name: 'default' }], deployments: [], services: [],
        configmaps: [], _n: 1 };
    },
    sections: ['Namespaces', 'Deployments', 'Services', 'ConfigMaps'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.namespaces.length; i++) rows.push([esc(st.namespaces[i].name)]);
        h = '<h4>Namespaces</h4>' + tableHtml(['Name'], rows) +
          formHtml([{ n: 'name', label: 'NAMESPACE' }], 'create-namespace', 'Create namespace');
      } else if (sec === 1) {
        var rows2 = [];
        for (i = 0; i < st.deployments.length; i++) {
          var d = st.deployments[i];
          rows2.push([esc(d.namespace), esc(d.name), esc(d.image), esc(String(d.replicas))]);
        }
        h = '<h4>Deployments</h4>' + tableHtml(['Namespace', 'Name', 'Image', 'Replicas'], rows2) +
          formHtml([{ n: 'name', label: 'DEPLOYMENT NAME' }, { n: 'namespace', label: 'NAMESPACE', value: 'default' },
            { n: 'image', label: 'IMAGE', ph: 'nginx:1.25' }, { n: 'replicas', label: 'REPLICAS', ph: '3' }],
            'deploy', 'Deploy') +
          formHtml([{ n: 'deployment', label: 'DEPLOYMENT NAME' }, { n: 'replicas', label: 'REPLICAS' }],
            'scale', 'Scale deployment');
      } else if (sec === 2) {
        var rows3 = [];
        for (i = 0; i < st.services.length; i++) {
          var s = st.services[i];
          rows3.push([esc(s.deployment), esc(s.name), esc(String(s.port)), esc(s.type)]);
        }
        h = '<h4>Services</h4>' + tableHtml(['Deployment', 'Name', 'Port', 'Type'], rows3) +
          formHtml([{ n: 'deployment', label: 'DEPLOYMENT NAME' }, { n: 'port', label: 'PORT', ph: '80' },
            { n: 'type', label: 'TYPE', ph: 'ClusterIP' }], 'expose-service', 'Expose service');
      } else {
        var rows4 = [];
        for (i = 0; i < st.configmaps.length; i++) {
          rows4.push([esc(st.configmaps[i].namespace), esc(st.configmaps[i].name)]);
        }
        h = '<h4>ConfigMaps</h4>' + tableHtml(['Namespace', 'Name'], rows4) +
          formHtml([{ n: 'name', label: 'CONFIGMAP NAME' }, { n: 'namespace', label: 'NAMESPACE', value: 'default' }],
            'create-configmap', 'Create ConfigMap');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      if (action === 'create-namespace') {
        if (!p.name) return null;
        st.namespaces.push({ name: p.name });
        return 'Namespace "' + p.name + '" created.';
      }
      if (action === 'deploy') {
        st.deployments.push({ name: p.name, namespace: p.namespace || 'default',
          image: p.image, replicas: parseInt(p.replicas, 10) || 1 });
        return 'Deployment "' + p.name + '" (' + p.image + ' × ' +
          (parseInt(p.replicas, 10) || 1) + ') created.';
      }
      if (action === 'expose-service') {
        var d = findByName(st.deployments, p.deployment);
        if (!d) return 'Unknown deployment "' + p.deployment + '".';
        st.services.push({ deployment: d.name, name: d.name + '-svc',
          port: p.port, type: p.type || 'ClusterIP' });
        return 'Service "' + d.name + '-svc" (' + (p.type || 'ClusterIP') +
          ':' + p.port + ') exposing deployment "' + d.name + '".';
      }
      if (action === 'scale') {
        var d2 = findByName(st.deployments, p.deployment);
        if (!d2) return 'Unknown deployment "' + p.deployment + '".';
        d2.replicas = parseInt(p.replicas, 10) || d2.replicas;
        return 'Deployment "' + d2.name + '" scaled to ' + d2.replicas + ' replicas.';
      }
      if (action === 'create-configmap') {
        st.configmaps.push({ name: p.name, namespace: p.namespace || 'default' });
        return 'ConfigMap "' + p.name + '" created.';
      }
      return null;
    }
  };

  /* ----- firewall ----- */
  CONSOLES['firewall'] = {
    label: 'Host Firewall',
    init: function () {
      return { rules: [], policies: { INPUT: 'DROP', OUTPUT: 'ACCEPT', FORWARD: 'DROP' }, _n: 1 };
    },
    sections: ['Rules', 'Default policies'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.rules.length; i++) {
          var r = st.rules[i];
          rows.push([esc(r.id), esc(r.chain), esc(r.protocol), esc(String(r.port)),
            esc(r.source), esc(r.action),
            actionBtn('delete-rule', 'Delete', { id: r.id }, 'ghost')]);
        }
        h = '<h4>Rules</h4>' + tableHtml(['ID', 'Chain', 'Proto', 'Port', 'Source', 'Action', ''], rows) +
          formHtml([{ n: 'chain', label: 'CHAIN (INPUT|OUTPUT|FORWARD)', ph: 'INPUT' },
            { n: 'protocol', label: 'PROTOCOL', ph: 'tcp' }, { n: 'port', label: 'PORT', ph: '22' },
            { n: 'source', label: 'SOURCE', ph: '0.0.0.0/0' },
            { n: 'action', label: 'ACTION (ACCEPT|DROP)', ph: 'ACCEPT' }], 'add-rule', 'Add rule');
      } else {
        h = '<h4>Default policies</h4>' + tableHtml(['Chain', 'Policy'],
          [['INPUT', esc(st.policies.INPUT)], ['OUTPUT', esc(st.policies.OUTPUT)],
            ['FORWARD', esc(st.policies.FORWARD)]]) +
          formHtml([{ n: 'chain', label: 'CHAIN' }, { n: 'policy', label: 'POLICY (ACCEPT|DROP)' }],
            'set-default-policy', 'Set default policy');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      if (action === 'add-rule') {
        var id = nextId(st, 'rule');
        st.rules.push({ id: id, chain: p.chain || 'INPUT', protocol: p.protocol || 'tcp',
          port: p.port, source: p.source || '0.0.0.0/0', action: p.action || 'ACCEPT' });
        return 'Rule ' + id + ' added: ' + (p.chain || 'INPUT') + ' ' +
          (p.action || 'ACCEPT') + ' ' + (p.protocol || 'tcp') + ':' + p.port + '.';
      }
      if (action === 'delete-rule') {
        for (i = 0; i < st.rules.length; i++) {
          if (st.rules[i].id === p.id) {
            st.rules.splice(i, 1);
            return 'Rule ' + p.id + ' deleted.';
          }
        }
        return 'Unknown rule "' + p.id + '".';
      }
      if (action === 'set-default-policy') {
        st.policies[p.chain] = p.policy;
        return 'Default policy for ' + p.chain + ' set to ' + p.policy + '.';
      }
      return null;
    }
  };

  /* ----- switch-cli ----- */
  CONSOLES['switch-cli'] = {
    label: 'Switch CLI',
    init: function () {
      return { vlans: [{ id: 1, name: 'default' }], ports: [], saved: false, _n: 1 };
    },
    sections: ['Terminal', 'VLANs', 'Ports'],
    /* Pre-parse typed CLI text into a real action. */
    pre: function (action, params) {
      if (action !== 'cli') return null;
      var cmd = String(params.cmd || '').trim();
      var m;
      if ((m = /^vlan\s+(\d+)(?:\s+name\s+(.+))?/i.exec(cmd))) {
        return { action: 'create-vlan', params: { id: parseInt(m[1], 10), name: (m[2] || 'vlan' + m[1]).trim() } };
      }
      if ((m = /^interface\s+(\S+)\s+access\s+vlan\s+(\d+)/i.exec(cmd))) {
        return { action: 'assign-port', params: { port: m[1], vlan: parseInt(m[2], 10) } };
      }
      if ((m = /^interface\s+(\S+)\s+trunk/i.exec(cmd))) {
        return { action: 'set-trunk', params: { port: m[1] } };
      }
      if (/^(write\s+memory|copy\s+run(ning-config)?\s+start(up-config)?)/i.test(cmd)) {
        return { action: 'save-config', params: {} };
      }
      if (/^show\s+vlan/i.test(cmd)) {
        return { action: 'show-vlan', params: {} };
      }
      return { error: 'Unrecognized command. Try: vlan <id> name <name> | interface <port> access vlan <id> | interface <port> trunk | show vlan | write memory' };
    },
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        h = '<h4>Console terminal</h4>' +
          '<p style="color:var(--muted);font-size:13px">Commands: ' +
          '<code>vlan &lt;id&gt; name &lt;name&gt;</code> · ' +
          '<code>interface &lt;port&gt; access vlan &lt;id&gt;</code> · ' +
          '<code>interface &lt;port&gt; trunk</code> · <code>show vlan</code> · <code>write memory</code></p>' +
          '<div class="csim-form" data-cform="cli">' +
          '<label>COMMAND<input class="csim-cli" data-field="cmd" placeholder="vlan 10 name ENG" /></label>' +
          '<div><button class="btn small primary" data-cact="cli" data-cformref="cli">Run</button></div></div>';
      } else if (sec === 1) {
        var rows = [];
        for (i = 0; i < st.vlans.length; i++) {
          rows.push([esc(String(st.vlans[i].id)), esc(st.vlans[i].name)]);
        }
        h = '<h4>VLANs</h4>' + tableHtml(['ID', 'Name'], rows);
      } else {
        var rows2 = [];
        for (i = 0; i < st.ports.length; i++) {
          rows2.push([esc(st.ports[i].port), esc(st.ports[i].mode),
            st.ports[i].vlan != null ? esc(String(st.ports[i].vlan)) : '—']);
        }
        h = '<h4>Ports</h4>' + tableHtml(['Port', 'Mode', 'VLAN'], rows2) +
          '<p style="color:var(--muted);font-size:13px">Config ' +
          (st.saved ? 'saved \u2714' : 'not saved yet \u2014 run <code>write memory</code>') + '.</p>';
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      if (action === 'create-vlan') {
        for (i = 0; i < st.vlans.length; i++) {
          if (st.vlans[i].id === p.id) { st.vlans[i].name = p.name; return 'VLAN ' + p.id + ' renamed to "' + p.name + '".'; }
        }
        st.vlans.push({ id: p.id, name: p.name });
        return 'VLAN ' + p.id + ' ("' + p.name + '") created.';
      }
      if (action === 'assign-port') {
        var known = false;
        for (i = 0; i < st.vlans.length; i++) if (st.vlans[i].id === p.vlan) known = true;
        if (!known) return 'VLAN ' + p.vlan + ' does not exist — create it first.';
        var port = null;
        for (i = 0; i < st.ports.length; i++) if (st.ports[i].port === p.port) port = st.ports[i];
        if (!port) { port = { port: p.port, mode: 'access', vlan: null }; st.ports.push(port); }
        port.mode = 'access'; port.vlan = p.vlan;
        return 'Interface ' + p.port + ' set to access mode on VLAN ' + p.vlan + '.';
      }
      if (action === 'set-trunk') {
        var port2 = null, j;
        for (j = 0; j < st.ports.length; j++) if (st.ports[j].port === p.port) port2 = st.ports[j];
        if (!port2) { port2 = { port: p.port, mode: 'trunk', vlan: null }; st.ports.push(port2); }
        port2.mode = 'trunk';
        return 'Interface ' + p.port + ' set to trunk mode.';
      }
      if (action === 'save-config') {
        st.saved = true;
        return 'Configuration saved (write memory complete).';
      }
      if (action === 'show-vlan') {
        var names = [];
        for (i = 0; i < st.vlans.length; i++) names.push(st.vlans[i].id + ' ' + st.vlans[i].name);
        return 'VLAN table: ' + names.join(' | ');
      }
      return null;
    }
  };

  /* ----- linux-desktop ----- */
  CONSOLES['linux-desktop'] = {
    label: 'Linux Desktop (file manager)',
    init: function () {
      return { files: [
        { path: '/etc/app.conf', mode: '644', owner: 'root', type: 'file' },
        { path: '/home/user/notes.txt', mode: '600', owner: 'user', type: 'file' },
        { path: '/var/log/app.log', mode: '640', owner: 'root', type: 'file' }
      ], sel: '/etc/app.conf', _n: 1 };
    },
    sections: ['Files'],
    body: function (st, sec) {
      var h = '<h4>Files</h4>', i;
      h += '<table class="csim-table"><thead><tr><th>Path</th><th>Type</th><th>Mode</th><th>Owner</th><th></th></tr></thead><tbody>';
      for (i = 0; i < st.files.length; i++) {
        var f = st.files[i];
        h += '<tr' + (st.sel === f.path ? ' style="background:rgba(126,231,135,.06)"' : '') + '>' +
          '<td><code>' + esc(f.path) + '</code></td><td>' + esc(f.type) + '</td>' +
          '<td><code>' + esc(f.mode) + '</code></td><td>' + esc(f.owner) + '</td>' +
          '<td>' + actionBtn('select', st.sel === f.path ? 'Selected' : 'Select',
            { path: f.path }, st.sel === f.path ? 'primary' : 'ghost') + '</td></tr>';
      }
      h += '</tbody></table>';
      h += formHtml([{ n: 'path', label: 'PATH', value: st.sel },
        { n: 'mode', label: 'MODE (e.g. 640)', ph: '640' }], 'chmod', 'chmod') +
        formHtml([{ n: 'path', label: 'PATH', value: st.sel },
        { n: 'owner', label: 'OWNER', ph: 'appuser' }], 'chown', 'chown') +
        formHtml([{ n: 'path', label: 'PATH', ph: '/home/user/new.txt' }], 'create-file', 'Create file') +
        formHtml([{ n: 'path', label: 'PATH', ph: '/home/user/docs' }], 'create-dir', 'Create directory') +
        formHtml([{ n: 'path', label: 'PATH', value: st.sel }], 'delete', 'Delete');
      return h;
    },
    act: function (st, action, p) {
      var i;
      if (action === 'select') { st.sel = p.path; return 'Selected ' + p.path + '.'; }
      function find() {
        for (var j = 0; j < st.files.length; j++) {
          if (st.files[j].path === p.path) return st.files[j];
        }
        return null;
      }
      if (action === 'chmod') {
        var f = find();
        if (!f) return 'No such file: ' + p.path;
        if (!/^[0-7]{3,4}$/.test(String(p.mode))) return 'Invalid mode "' + p.mode + '" — use octal like 640.';
        f.mode = String(p.mode);
        return 'chmod ' + p.mode + ' ' + f.path;
      }
      if (action === 'chown') {
        var f2 = find();
        if (!f2) return 'No such file: ' + p.path;
        f2.owner = p.owner;
        return 'chown ' + p.owner + ' ' + f2.path;
      }
      if (action === 'create-file') {
        if (!p.path) return null;
        st.files.push({ path: p.path, mode: '644', owner: 'user', type: 'file' });
        return 'File ' + p.path + ' created.';
      }
      if (action === 'create-dir') {
        if (!p.path) return null;
        st.files.push({ path: p.path, mode: '755', owner: 'user', type: 'dir' });
        return 'Directory ' + p.path + ' created.';
      }
      if (action === 'delete') {
        for (i = 0; i < st.files.length; i++) {
          if (st.files[i].path === p.path) {
            st.files.splice(i, 1);
            return p.path + ' deleted.';
          }
        }
        return 'No such file: ' + p.path;
      }
      return null;
    }
  };

  /* ----- sql-studio ----- */
  CONSOLES['sql-studio'] = {
    label: 'SQL Studio',
    init: function () {
      return { tables: [], log: [], _n: 1 };
    },
    sections: ['Query', 'Tables'],
    /* Matching override: validate.params = {match: "<substring>"} passes when
       the executed SQL contains that substring (case-insensitive). */
    match: function (validate, action, params) {
      if (validate.action !== action) return false;
      if (action === 'run-query' && validate.params && validate.params.match != null) {
        return String(params.sql || '').toUpperCase()
          .indexOf(String(validate.params.match).toUpperCase()) >= 0;
      }
      return subsetMatch(validate.params || {}, params || {});
    },
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        h = '<h4>Query editor</h4>' +
          '<div class="csim-form" data-cform="run-query">' +
          '<label>SQL<input class="csim-cli" data-field="sql" placeholder="SELECT * FROM customers;" /></label>' +
          '<div><button class="btn small primary" data-cact="run-query" data-cformref="run-query">Run query</button></div></div>' +
          '<div class="csim-log" aria-live="polite">';
        if (!st.log.length) h += '<span class="dim">No queries run yet.</span>';
        for (i = st.log.length - 1; i >= 0 && i > st.log.length - 7; i--) {
          h += '<div><span class="dim">&gt;</span> ' + esc(st.log[i].sql) + '<br>' +
            '<span class="ok">' + esc(st.log[i].result) + '</span></div>';
        }
        h += '</div>';
      } else {
        var rows = [];
        for (i = 0; i < st.tables.length; i++) {
          rows.push([esc(st.tables[i].name), esc(st.tables[i].columns),
            esc((st.tables[i].indexes || []).join(', '))]);
        }
        h = '<h4>Tables</h4>' + tableHtml(['Name', 'Columns', 'Indexes'], rows) +
          formHtml([{ n: 'name', label: 'TABLE NAME', ph: 'customers' },
            { n: 'columns', label: 'COLUMNS (comma-separated)', ph: 'id INT, name TEXT' }],
            'create-table', 'Create table') +
          formHtml([{ n: 'table', label: 'TABLE' }, { n: 'column', label: 'COLUMN' }],
            'create-index', 'Create index');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      if (action === 'create-table') {
        if (!p.name) return null;
        st.tables.push({ name: p.name, columns: p.columns || '', indexes: [] });
        return 'Table "' + p.name + '" created.';
      }
      if (action === 'create-index') {
        for (i = 0; i < st.tables.length; i++) {
          if (st.tables[i].name === p.table) {
            st.tables[i].indexes.push(p.column);
            return 'Index on ' + p.table + '(' + p.column + ') created.';
          }
        }
        return 'Unknown table "' + p.table + '".';
      }
      if (action === 'run-query') {
        var sql = String(p.sql || '').trim();
        if (!sql) return null;
        var up = sql.toUpperCase(), result;
        if (/^\s*SELECT/i.test(sql)) result = 'Query OK — 3 rows returned (simulated).';
        else if (/^\s*INSERT/i.test(sql)) result = 'Query OK — 1 row inserted (simulated).';
        else if (/^\s*UPDATE/i.test(sql)) result = 'Query OK — 2 rows updated (simulated).';
        else if (/^\s*DELETE/i.test(sql)) result = 'Query OK — 1 row deleted (simulated).';
        else result = 'Query OK (simulated).';
        st.log.push({ sql: sql, result: result });
        return result + ' — ' + sql.slice(0, 60);
      }
      return null;
    }
  };

  /* ----- git-host ----- */
  CONSOLES['git-host'] = {
    label: 'Git Hosting (PR review)',
    init: function () {
      return { branches: ['main'],
        prs: [{ id: 1, title: 'Add health check endpoint', base: 'main', head: 'feat/health',
          status: 'open', comments: [] }], _n: 2 };
    },
    sections: ['Pull requests', 'Branches'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.prs.length; i++) {
          var pr = st.prs[i];
          rows.push(['#' + pr.id, esc(pr.title), esc(pr.head) + ' → ' + esc(pr.base),
            esc(pr.status),
            pr.status === 'open'
              ? actionBtn('approve-pr', 'Approve', { pr: pr.id }, 'primary') + ' ' +
                actionBtn('merge-pr', 'Merge', { pr: pr.id }, 'primary')
              : '<span style="color:var(--muted)">—</span>']);
        }
        h = '<h4>Pull requests</h4>' + tableHtml(['PR', 'Title', 'Branch', 'Status', 'Review'], rows) +
          formHtml([{ n: 'title', label: 'TITLE' }, { n: 'base', label: 'BASE', value: 'main' },
            { n: 'head', label: 'HEAD BRANCH' }], 'open-pr', 'Open pull request') +
          formHtml([{ n: 'pr', label: 'PR NUMBER' }, { n: 'comment', label: 'COMMENT' }],
            'request-changes', 'Request changes') +
          formHtml([{ n: 'pr', label: 'PR NUMBER' }, { n: 'text', label: 'COMMENT' }],
            'add-comment', 'Add comment');
      } else {
        h = '<h4>Branches</h4>' + tableHtml(['Name'],
          st.branches.map(function (b) { return [esc(b)]; })) +
          formHtml([{ n: 'name', label: 'BRANCH NAME', ph: 'feat/login' }], 'create-branch', 'Create branch');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      function pr() {
        for (var j = 0; j < st.prs.length; j++) {
          if (st.prs[j].id === parseInt(p.pr, 10)) return st.prs[j];
        }
        return null;
      }
      if (action === 'create-branch') {
        if (!p.name) return null;
        if (st.branches.indexOf(p.name) < 0) st.branches.push(p.name);
        return 'Branch "' + p.name + '" created.';
      }
      if (action === 'open-pr') {
        var id = st._n++;
        st.prs.push({ id: id, title: p.title || 'Untitled', base: p.base || 'main',
          head: p.head || 'feature', status: 'open', comments: [] });
        return 'Pull request #' + id + ' opened.';
      }
      if (action === 'approve-pr') {
        var a = pr();
        if (!a) return 'Unknown PR #' + p.pr + '.';
        a.status = 'approved';
        return 'PR #' + a.id + ' approved.';
      }
      if (action === 'request-changes') {
        var r = pr();
        if (!r) return 'Unknown PR #' + p.pr + '.';
        r.status = 'changes-requested';
        r.comments.push('changes: ' + (p.comment || ''));
        return 'Changes requested on PR #' + r.id + '.';
      }
      if (action === 'add-comment') {
        var c = pr();
        if (!c) return 'Unknown PR #' + p.pr + '.';
        c.comments.push(p.text || '');
        return 'Comment added to PR #' + c.id + '.';
      }
      if (action === 'merge-pr') {
        var m = pr();
        if (!m) return 'Unknown PR #' + p.pr + '.';
        m.status = 'merged';
        return 'PR #' + m.id + ' merged into ' + m.base + '.';
      }
      return null;
    }
  };

  /* ----- cicd-pipeline ----- */
  CONSOLES['cicd-pipeline'] = {
    label: 'CI/CD Pipeline',
    init: function () {
      return { stages: [
        { name: 'build', status: 'success' },
        { name: 'test', status: 'failed' },
        { name: 'deploy', status: 'gated' }
      ], variables: {}, _n: 1 };
    },
    sections: ['Pipeline', 'Variables'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        h = '<h4>Pipeline stages</h4>' + tableHtml(['Stage', 'Status', 'Actions'],
          st.stages.map(function (s) {
            var btns = actionBtn('retry-stage', 'Retry', { stage: s.name }, 'ghost');
            if (s.status === 'gated') btns += ' ' + actionBtn('approve-stage', 'Approve', { stage: s.name }, 'primary');
            var dot = s.status === 'success' ? '\u2714' : (s.status === 'failed' ? '\u2718' : '\u23F8');
            return [esc(s.name), dot + ' ' + esc(s.status), btns];
          })) +
          '<div class="action-row" style="margin-top:12px">' +
          actionBtn('trigger-build', 'Trigger new build', null, 'primary') + '</div>';
      } else {
        var rows = [];
        for (var k in st.variables) {
          if (st.variables.hasOwnProperty(k)) rows.push([esc(k), esc(st.variables[k])]);
        }
        h = '<h4>Pipeline variables</h4>' + tableHtml(['Key', 'Value'], rows) +
          formHtml([{ n: 'key', label: 'KEY', ph: 'DEPLOY_ENV' },
            { n: 'value', label: 'VALUE', ph: 'staging' }], 'set-variable', 'Set variable');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      function stage() {
        for (var j = 0; j < st.stages.length; j++) {
          if (st.stages[j].name === p.stage) return st.stages[j];
        }
        return null;
      }
      if (action === 'trigger-build') {
        for (i = 0; i < st.stages.length; i++) {
          st.stages[i].status = (st.stages[i].name === 'deploy') ? 'gated' : 'success';
        }
        return 'Build triggered — build and test green, deploy awaiting approval.';
      }
      if (action === 'retry-stage') {
        var s = stage();
        if (!s) return 'Unknown stage "' + p.stage + '".';
        s.status = 'success';
        return 'Stage "' + s.name + '" retried — now passing.';
      }
      if (action === 'approve-stage') {
        var s2 = stage();
        if (!s2) return 'Unknown stage "' + p.stage + '".';
        s2.status = 'success';
        return 'Stage "' + s2.name + '" approved and released.';
      }
      if (action === 'set-variable') {
        st.variables[p.key] = p.value;
        return 'Variable ' + p.key + ' set.';
      }
      return null;
    }
  };

  /* ----- siem-dashboard ----- */
  CONSOLES['siem-dashboard'] = {
    label: 'SIEM Dashboard',
    init: function () {
      return { alerts: [
        { id: 'ALT-101', title: 'Impossible travel login', severity: 'high',
          host: 'wkst-042', status: 'open', assignee: '' },
        { id: 'ALT-102', title: 'Malware hash match on download', severity: 'critical',
          host: 'wkst-117', status: 'open', assignee: '' },
        { id: 'ALT-103', title: 'Unusual outbound volume', severity: 'medium',
          host: 'srv-backup-02', status: 'open', assignee: '' }
      ], rules: [], _n: 1 };
    },
    sections: ['Alerts', 'Detection rules'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.alerts.length; i++) {
          var a = st.alerts[i];
          rows.push([esc(a.id), esc(a.title), esc(a.severity), esc(a.host),
            esc(a.status) + (a.assignee ? ' · ' + esc(a.assignee) : ''),
            a.status === 'open'
              ? actionBtn('acknowledge-alert', 'Ack', { id: a.id }, 'ghost') + ' ' +
                actionBtn('escalate', 'Escalate', { id: a.id }, 'ghost') + ' ' +
                actionBtn('isolate-host', 'Isolate host', { host: a.host }, 'primary')
              : '<span style="color:var(--muted)">—</span>']);
        }
        h = '<h4>Alerts</h4>' + tableHtml(['ID', 'Title', 'Severity', 'Host', 'Status', 'Respond'], rows) +
          formHtml([{ n: 'id', label: 'ALERT ID' }, { n: 'analyst', label: 'ANALYST' }],
            'assign-alert', 'Assign alert');
      } else {
        var rows2 = [];
        for (i = 0; i < st.rules.length; i++) {
          rows2.push([esc(st.rules[i].name), '<code>' + esc(st.rules[i].query) + '</code>']);
        }
        h = '<h4>Detection rules</h4>' + tableHtml(['Name', 'Query'], rows2) +
          formHtml([{ n: 'name', label: 'RULE NAME' }, { n: 'query', label: 'QUERY' }],
            'create-rule', 'Create rule');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      function alert() {
        for (var j = 0; j < st.alerts.length; j++) {
          if (st.alerts[j].id === p.id) return st.alerts[j];
        }
        return null;
      }
      if (action === 'acknowledge-alert') {
        var a = alert();
        if (!a) return 'Unknown alert "' + p.id + '".';
        a.status = 'acknowledged';
        return 'Alert ' + a.id + ' acknowledged.';
      }
      if (action === 'assign-alert') {
        var a2 = alert();
        if (!a2) return 'Unknown alert "' + p.id + '".';
        a2.assignee = p.analyst;
        return 'Alert ' + a2.id + ' assigned to ' + p.analyst + '.';
      }
      if (action === 'escalate') {
        var a3 = alert();
        if (!a3) return 'Unknown alert "' + p.id + '".';
        a3.status = 'escalated';
        return 'Alert ' + a3.id + ' escalated to incident response.';
      }
      if (action === 'isolate-host') {
        var n = 0;
        for (i = 0; i < st.alerts.length; i++) {
          if (st.alerts[i].host === p.host && st.alerts[i].status === 'open') {
            st.alerts[i].status = 'contained';
            n++;
          }
        }
        return 'Host ' + p.host + ' isolated from the network (' + n + ' alert(s) contained).';
      }
      if (action === 'create-rule') {
        st.rules.push({ name: p.name, query: p.query });
        return 'Detection rule "' + p.name + '" created.';
      }
      return null;
    }
  };

  /* ----- ticketing ----- */
  CONSOLES['ticketing'] = {
    label: 'ITSM Ticketing',
    init: function () {
      return { tickets: [
        { id: 'INC-9001', title: 'VPN drops for remote users', priority: 'P2',
          status: 'open', assignee: '', notes: [] }
      ], _n: 9002 };
    },
    sections: ['Queue', 'New ticket'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.tickets.length; i++) {
          var t = st.tickets[i];
          rows.push([esc(t.id), esc(t.title), esc(t.priority), esc(t.status),
            esc(t.assignee || 'unassigned'),
            t.status === 'resolved'
              ? '<span style="color:var(--muted)">—</span>'
              : actionBtn('resolve-ticket', 'Resolve', { id: t.id, resolution: 'fixed per runbook' }, 'primary')]);
        }
        h = '<h4>Incident queue</h4>' + tableHtml(['ID', 'Title', 'Priority', 'Status', 'Assignee', ''], rows) +
          formHtml([{ n: 'id', label: 'TICKET ID' }, { n: 'assignee', label: 'ASSIGNEE' }],
            'assign-ticket', 'Assign') +
          formHtml([{ n: 'id', label: 'TICKET ID' }, { n: 'status', label: 'STATUS (open|in-progress|on-hold|resolved)' }],
            'update-status', 'Update status') +
          formHtml([{ n: 'id', label: 'TICKET ID' }, { n: 'text', label: 'NOTE' }],
            'add-note', 'Add note');
      } else {
        h = '<h4>New ticket</h4>' +
          formHtml([{ n: 'title', label: 'TITLE' }, { n: 'priority', label: 'PRIORITY (P1..P4)', ph: 'P3' }],
            'create-ticket', 'Create ticket');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      function ticket() {
        for (var j = 0; j < st.tickets.length; j++) {
          if (st.tickets[j].id === p.id) return st.tickets[j];
        }
        return null;
      }
      if (action === 'create-ticket') {
        if (!p.title) return null;
        var id = 'INC-' + (st._n++);
        st.tickets.push({ id: id, title: p.title, priority: p.priority || 'P3',
          status: 'open', assignee: '', notes: [] });
        return 'Ticket ' + id + ' created (' + (p.priority || 'P3') + ').';
      }
      if (action === 'assign-ticket') {
        var t = ticket();
        if (!t) return 'Unknown ticket "' + p.id + '".';
        t.assignee = p.assignee;
        return 'Ticket ' + t.id + ' assigned to ' + p.assignee + '.';
      }
      if (action === 'update-status') {
        var t2 = ticket();
        if (!t2) return 'Unknown ticket "' + p.id + '".';
        t2.status = p.status;
        return 'Ticket ' + t2.id + ' status → ' + p.status + '.';
      }
      if (action === 'add-note') {
        var t3 = ticket();
        if (!t3) return 'Unknown ticket "' + p.id + '".';
        t3.notes.push(p.text || '');
        return 'Note added to ' + t3.id + '.';
      }
      if (action === 'resolve-ticket') {
        var t4 = ticket();
        if (!t4) return 'Unknown ticket "' + p.id + '".';
        t4.status = 'resolved';
        return 'Ticket ' + t4.id + ' resolved: ' + (p.resolution || 'done') + '.';
      }
      return null;
    }
  };

  /* ----- code-editor ----- */
  CONSOLES['code-editor'] = {
    label: 'Code Editor (debugger)',
    init: function () {
      return { files: [
        { name: 'app.py', lines: ['def total(items):', '    s = 0', '    for x in items:',
          '        s += x', '    return s', '', 'print(total([1, 2, 3]))'] },
        { name: 'config.yaml', lines: ['service:', '  port: 8080', '  debug: false'] }
      ], open: 'app.py', breakpoints: {}, cursor: 0, _n: 1 };
    },
    sections: ['Explorer', 'Editor'],
    body: function (st, sec) {
      var h = '', i;
      function openFile() {
        for (var j = 0; j < st.files.length; j++) {
          if (st.files[j].name === st.open) return st.files[j];
        }
        return st.files[0];
      }
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.files.length; i++) {
          rows.push([esc(st.files[i].name), esc(String(st.files[i].lines.length)) + ' lines',
            actionBtn('open-file', 'Open', { name: st.files[i].name }, 'ghost')]);
        }
        h = '<h4>Explorer</h4>' + tableHtml(['File', 'Size', ''], rows);
      } else {
        var f = openFile();
        h = '<h4>' + esc(f.name) + ' <span style="color:var(--muted);font-weight:400">— click a line to toggle a breakpoint</span></h4>';
        h += '<div class="csim-editor">';
        for (i = 0; i < f.lines.length; i++) {
          var ln = i + 1, key = f.name + ':' + ln;
          var bp = st.breakpoints[key] ? '\u25CF' : '\u25CB';
          h += '<span class="csim-eline' + (st.cursor === i ? ' at-cursor' : '') +
            '" data-cact="toggle-breakpoint" data-cparam-file="' + esc(f.name) +
            '" data-cparam-line="' + ln + '"><span class="bp">' + bp +
            '</span><span class="ln">' + ln + '</span>' + esc(f.lines[i]) + '</span>';
        }
        h += '</div>';
        h += '<div class="action-row" style="margin-top:12px">' +
          actionBtn('step-over', 'Step over', null, 'ghost') +
          actionBtn('run-to-breakpoint', 'Run to breakpoint', null, 'primary') + '</div>' +
          formHtml([{ n: 'file', label: 'FILE', value: f.name },
            { n: 'line', label: 'LINE' }, { n: 'text', label: 'NEW LINE TEXT' }],
            'fix-line', 'Replace line') +
          formHtml([{ n: 'name', label: 'VARIABLE NAME', ph: 's' }], 'inspect-variable', 'Inspect');
      }
      return h;
    },
    act: function (st, action, p) {
      var i;
      function openFile() {
        for (var j = 0; j < st.files.length; j++) {
          if (st.files[j].name === (p.file || st.open)) return st.files[j];
        }
        return null;
      }
      if (action === 'open-file') { st.open = p.name; st.cursor = 0; return 'Opened ' + p.name + '.'; }
      if (action === 'toggle-breakpoint') {
        var key = p.file + ':' + p.line;
        if (st.breakpoints[key]) { delete st.breakpoints[key]; return 'Breakpoint removed at ' + p.file + ':' + p.line + '.'; }
        st.breakpoints[key] = true;
        return 'Breakpoint set at ' + p.file + ':' + p.line + '.';
      }
      if (action === 'step-over') {
        var f = openFile();
        if (f && st.cursor < f.lines.length - 1) st.cursor++;
        return 'Stepped to line ' + (st.cursor + 1) + '.';
      }
      if (action === 'run-to-breakpoint') {
        var f2 = openFile(), hit = -1;
        if (f2) {
          for (i = st.cursor + 1; i < f2.lines.length; i++) {
            if (st.breakpoints[f2.name + ':' + (i + 1)]) { hit = i; break; }
          }
        }
        if (hit >= 0) { st.cursor = hit; return 'Paused at breakpoint ' + f2.name + ':' + (hit + 1) + '.'; }
        return 'No further breakpoints — run to end.';
      }
      if (action === 'fix-line') {
        var f3 = openFile();
        var ln = parseInt(p.line, 10);
        if (!f3 || !ln || ln < 1 || ln > f3.lines.length) return 'Invalid file/line.';
        f3.lines[ln - 1] = p.text;
        return 'Line ' + ln + ' replaced in ' + f3.name + '.';
      }
      if (action === 'inspect-variable') {
        return 'inspect ' + p.name + ' => <simulated value> (debugger is a sandbox).';
      }
      return null;
    }
  };

  /* ----- db-admin ----- */
  CONSOLES['db-admin'] = {
    label: 'Database Admin',
    init: function () {
      return { dbs: [], users: [], grants: [], backups: [], params: {}, _n: 1 };
    },
    sections: ['Databases', 'Users & grants', 'Backups'],
    body: function (st, sec) {
      var h = '', i;
      if (sec === 0) {
        var rows = [];
        for (i = 0; i < st.dbs.length; i++) {
          rows.push([esc(st.dbs[i]), actionBtn('backup', 'Back up', { db: st.dbs[i] }, 'ghost')]);
        }
        h = '<h4>Databases</h4>' + tableHtml(['Name', ''], rows) +
          formHtml([{ n: 'name', label: 'DATABASE NAME' }], 'create-database', 'Create database') +
          formHtml([{ n: 'key', label: 'PARAMETER', ph: 'max_connections' },
            { n: 'value', label: 'VALUE', ph: '200' }], 'set-parameter', 'Set parameter');
      } else if (sec === 1) {
        var rows2 = [];
        for (i = 0; i < st.users.length; i++) rows2.push([esc(st.users[i])]);
        var rows3 = [];
        for (i = 0; i < st.grants.length; i++) {
          rows3.push([esc(st.grants[i].db), esc(st.grants[i].user), esc(st.grants[i].priv)]);
        }
        h = '<h4>Users</h4>' + tableHtml(['Name'], rows2) +
          formHtml([{ n: 'name', label: 'USER NAME' }], 'create-user', 'Create user') +
          '<h4>Grants</h4>' + tableHtml(['Database', 'User', 'Privilege'], rows3) +
          formHtml([{ n: 'db', label: 'DATABASE' }, { n: 'user', label: 'USER' },
            { n: 'priv', label: 'PRIVILEGE', ph: 'SELECT' }], 'grant-priv', 'Grant privilege');
      } else {
        var rows4 = [];
        for (i = 0; i < st.backups.length; i++) {
          rows4.push([esc(st.backups[i].db), esc(st.backups[i].id), 'complete']);
        }
        h = '<h4>Backups</h4>' + tableHtml(['Database', 'Backup ID', 'Status'], rows4,
          'No backups yet.');
      }
      return h;
    },
    act: function (st, action, p) {
      if (action === 'create-database') {
        if (!p.name) return null;
        st.dbs.push(p.name);
        return 'Database "' + p.name + '" created.';
      }
      if (action === 'create-user') {
        if (!p.name) return null;
        st.users.push(p.name);
        return 'Database user "' + p.name + '" created.';
      }
      if (action === 'grant-priv') {
        st.grants.push({ db: p.db, user: p.user, priv: p.priv });
        return 'Granted ' + p.priv + ' on ' + p.db + ' to ' + p.user + '.';
      }
      if (action === 'backup') {
        var id = 'bkp-' + (st._n++);
        st.backups.push({ db: p.db, id: id });
        return 'Backup ' + id + ' of "' + p.db + '" complete (simulated).';
      }
      if (action === 'set-parameter') {
        st.params[p.key] = p.value;
        return 'Parameter ' + p.key + ' = ' + p.value + '.';
      }
      return null;
    }
  };

  /* ----- generic-web (fallback) ----- */
  CONSOLES['generic-web'] = {
    label: 'Web Console',
    init: function () {
      return { fields: { site_name: '', admin_email: '', timezone: 'UTC' }, submitted: [], _n: 1 };
    },
    sections: ['Settings'],
    body: function (st, sec) {
      var h = '<h4>Site settings</h4>';
      var keys = ['site_name', 'admin_email', 'timezone'];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        h += formHtml([{ n: 'id', label: 'FIELD', value: k },
          { n: 'value', label: 'VALUE', value: st.fields[k] || '' }], 'set-field',
          'Set ' + k.replace(/_/g, ' '));
      }
      h += '<div class="action-row" style="margin-top:12px">' +
        actionBtn('submit-form', 'Submit settings', null, 'primary') + '</div>';
      if (st.submitted.length) {
        h += '<p style="color:var(--muted);font-size:13px">Submissions: ' +
          esc(String(st.submitted.length)) + '</p>';
      }
      return h;
    },
    act: function (st, action, p) {
      if (action === 'set-field') {
        st.fields[p.id] = p.value;
        return 'Field "' + p.id + '" set to "' + p.value + '".';
      }
      if (action === 'submit-form') {
        st.submitted.push(new Date().toISOString());
        return 'Settings submitted (simulated).';
      }
      return null;
    }
  };

  /* ---------- task matching ---------- */
  function defaultMatch(validate, action, params) {
    if (!validate || validate.action !== action) return false;
    return subsetMatch(validate.params || {}, params || {});
  }

  /* ---------- view handling ---------- */
  function showSection() {
    var sec = $('view-console');
    if (!sec) return;
    var views = document.querySelectorAll('#main .view');
    for (var i = 0; i < views.length; i++) {
      views[i].classList.toggle('active', views[i] === sec);
    }
    var btns = document.querySelectorAll('.nav button[data-view]');
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.toggle('active',
        btns[j].getAttribute('data-view') === 'console');
    }
  }

  /* ---------- card list ---------- */
  function counterHtml() {
    return '<p class="labs-counter" style="color:var(--muted);font-size:13px">' +
      'Console exercises completed <strong style="color:var(--accent)">' + doneCount() +
      '</strong> / ' + state.sims.length + '</p>';
  }
  function emptyHtml() {
    return '<div class="labs-empty"><p class="eyebrow">INTERSTITIUM LABS \u00B7 SIMULATED CONSOLE</p>' +
      '<h3>No console exercises on this path yet</h3>' +
      '<p style="color:var(--muted)">The adaptive drill queue and the Terminal tab are ' +
      'ready when you are \u2014 console exercises for this bootcamp are still being built.</p></div>';
  }
  function consoleLabel(type) {
    var def = CONSOLES[type];
    return def ? def.label : type;
  }
  function paintList() {
    var body = $('consoleBody');
    if (!body || !state.sims) return;
    var html = counterHtml(), i;
    if (!state.sims.length) {
      html += emptyHtml();
    } else {
      html += '<div class="lab-grid">';
      for (i = 0; i < state.sims.length; i++) {
        var sim = state.sims[i], isDone = !!state.done[sim.id];
        html += '<article class="panel lab-card' + (isDone ? ' is-done' : '') +
          '" data-csim="' + esc(sim.id) + '">' +
          '<div class="section-head" style="margin-bottom:12px"><div>' +
          '<p class="eyebrow">SIMULATED CONSOLE \u00B7 ' + esc(consoleLabel(sim.console).toUpperCase()) + '</p>' +
          '<h3 style="margin:0">' + esc(sim.title) + '</h3></div></div>' +
          '<p style="color:var(--muted)">' + esc(sim.brief || '') + '</p>' +
          '<div class="lab-meta"><span class="tag">' +
          esc(String((sim.tasks || []).length)) + ' tasks</span>' +
          (sim.difficulty ? '<span class="tag">Difficulty ' + esc(String(sim.difficulty)) + '/3</span>' : '') +
          '</div>' +
          '<div class="action-row" style="margin-top:14px">' +
          (isDone
            ? '<span class="btn small" style="opacity:.7">\u2714 Completed</span>'
            : '<button class="btn small primary" data-csim-launch="' + esc(sim.id) +
              '">Launch console \u2192</button>') +
          '</div><div class="csim-result" aria-live="polite"></div></article>';
      }
      html += '</div>';
    }
    body.innerHTML = html;
    var btns = body.querySelectorAll('[data-csim-launch]');
    for (i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () { launch(b.getAttribute('data-csim-launch')); });
      })(btns[i]);
    }
  }

  /* ---------- console instance ---------- */
  function defFor(sim) {
    return CONSOLES[sim.console] || CONSOLES['generic-web'];
  }
  function launch(id) {
    var sim = simById(id);
    if (!sim) return;
    state.activeId = id;
    var def = defFor(sim);
    state.inst = { sim: sim, def: def, st: def.init(), section: 0, log: [],
      taskDone: {}, done: false };
    paintConsole();
    window.scrollTo(0, 0);
  }
  function taskCount(inst) {
    return (inst.sim.tasks || []).length;
  }
  function tasksDone(inst) {
    var n = 0, tasks = inst.sim.tasks || [], i;
    for (i = 0; i < tasks.length; i++) {
      if (inst.taskDone[tasks[i].id]) n++;
    }
    return n;
  }
  function taskHtml(inst) {
    var tasks = inst.sim.tasks || [], h = '', i;
    h += '<p class="eyebrow">TASKS \u00B7 ' + tasksDone(inst) + '/' + tasks.length + '</p>';
    for (i = 0; i < tasks.length; i++) {
      var t = tasks[i], done = !!inst.taskDone[t.id];
      h += '<div class="csim-task' + (done ? ' is-done' : '') + '">' +
        '<span class="tick" aria-hidden="true">' + (done ? '\u2714' : '\u25CB') + '</span>' +
        '<div><div>' + esc(t.instruction || '') + '</div>' +
        (t.hint && !done ? '<details style="margin-top:6px"><summary style="cursor:pointer;' +
          'font-size:12px;color:var(--accent)">Hint</summary><p style="font-size:13px;' +
          'color:var(--muted)">' + esc(t.hint) + '</p></details>' : '') +
        '</div></div>';
    }
    return h;
  }
  function logHtml(inst) {
    var h = '<div class="csim-log" aria-live="polite">';
    if (!inst.log.length) h += '<span class="dim">Action log — every click is recorded here.</span>';
    for (var i = inst.log.length - 1; i >= 0 && i > inst.log.length - 8; i--) {
      h += '<div><span class="ok">\u203A</span> ' + esc(inst.log[i].msg) + '</div>';
    }
    return h + '</div>';
  }
  function paintConsole() {
    injectCSS();
    var body = $('consoleBody');
    var inst = state.inst;
    if (!body || !inst) { paintList(); return; }
    var def = inst.def, sim = inst.sim, i;
    var secs = def.sections;
    var side = '';
    for (i = 0; i < secs.length; i++) {
      side += '<button class="csim-sec' + (inst.section === i ? ' on' : '') +
        '" data-csec="' + i + '">' + esc(secs[i]) + '</button>';
    }
    var h = '<div class="learn-crumb"><button class="btn small ghost" data-csim-back="\u2190">' +
      '\u2190 All console exercises</button>' +
      '<span class="learn-counter">' + esc(def.label.toUpperCase()) + '</span></div>';
    h += '<div class="panel" style="margin-bottom:14px">' + taskHtml(inst) + '</div>';
    h += '<div class="panel csim-shell">' +
      '<div class="csim-topbar"><div><p class="eyebrow">INTERSTITIUM LABS \u00B7 SANDBOX</p>' +
      '<h3 style="margin:0">' + esc(def.label) + '</h3></div>' +
      '<span class="csim-badge">SIMULATED</span></div>' +
      '<p class="csim-sandbox"><strong>Sandbox only.</strong> This console is a local ' +
      'simulation running entirely in your browser \u2014 it cannot touch real systems, ' +
      'real cloud accounts, or the network.</p>' +
      '<div class="csim-layout"><aside class="csim-side" aria-label="Console sections">' +
      side + '</aside><div class="csim-main" id="csimMain">' +
      def.body(inst.st, inst.section) + '</div></div>' +
      logHtml(inst) +
      '<div class="action-row" style="margin-top:12px">' +
      '<button class="btn small ghost" data-csim-reset>Reset console</button></div>' +
      '<div class="csim-result" aria-live="polite">' +
      (inst.done ? completeHtml(sim) : '') + '</div>' +
      '</div>';
    body.innerHTML = h;
    bindConsole(body);
  }
  function completeHtml(sim) {
    return '<div class="lab-complete" role="status" style="margin-top:14px">' +
      '<p class="eyebrow">INTERSTITIUM LABS \u00B7 CONSOLE EXERCISE COMPLETE</p>' +
      '<h3>\u2714 ' + esc(sim.title) + ' \u2014 cleared</h3>' +
      '<p>' + esc(sim.debrief || 'All tasks validated against the simulated console state.') + '</p></div>';
  }
  function gatherParams(btn) {
    var params = {}, i, a;
    for (i = 0; i < btn.attributes.length; i++) {
      a = btn.attributes[i];
      if (a.name.indexOf('data-cparam-') === 0) {
        params[a.name.slice('data-cparam-'.length)] = coerce(a.value);
      }
    }
    var ref = btn.getAttribute('data-cformref');
    var form = null;
    if (ref) {
      var root = btn;
      while (root && root.parentNode) root = root.parentNode;
      var scope = (root && root.querySelector) ? root : document;
      var forms = scope.querySelectorAll('[data-cform="' + ref + '"]');
      form = forms.length ? forms[forms.length - 1] : null;
    }
    if (form) {
      var inputs = form.querySelectorAll('[data-field]');
      for (i = 0; i < inputs.length; i++) {
        params[inputs[i].getAttribute('data-field')] = coerce(inputs[i].value);
      }
    }
    return params;
  }
  function bindConsole(body) {
    var back = body.querySelector('[data-csim-back]');
    if (back) back.addEventListener('click', function () {
      state.inst = null; state.activeId = null; paintList();
    });
    var reset = body.querySelector('[data-csim-reset]');
    if (reset) reset.addEventListener('click', function () {
      var inst = state.inst;
      if (inst) {
        inst.st = inst.def.init();
        inst.log = [];
        inst.taskDone = {};
        inst.done = false;
        paintConsole();
      }
    });
    var secs = body.querySelectorAll('[data-csec]');
    for (var i = 0; i < secs.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          state.inst.section = parseInt(b.getAttribute('data-csec'), 10) || 0;
          paintConsole();
        });
      })(secs[i]);
    }
    var acts = body.querySelectorAll('[data-cact]');
    for (var j = 0; j < acts.length; j++) {
      (function (b) {
        b.addEventListener('click', function () { doActionFromButton(b); });
      })(acts[j]);
    }
  }
  function doActionFromButton(btn) {
    var inst = state.inst;
    if (!inst || inst.done) return;
    var action = btn.getAttribute('data-cact');
    var params = gatherParams(btn);
    var pre = inst.def.pre ? inst.def.pre(action, params) : null;
    if (pre) {
      if (pre.error) {
        inst.log.push({ msg: 'Error: ' + pre.error });
        paintConsole();
        return;
      }
      action = pre.action;
      params = pre.params;
    }
    var msg = inst.def.act(inst.st, action, params);
    if (msg == null) {
      inst.log.push({ msg: 'Unknown action "' + action + '" — nothing changed.' });
      paintConsole();
      return;
    }
    inst.log.push({ action: action, params: params, msg: msg });
    checkTasks(inst, action, params);
    paintConsole();
  }
  function checkTasks(inst, action, params) {
    var tasks = inst.sim.tasks || [], i, changed = false;
    var match = inst.def.match || defaultMatch;
    for (i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!t || inst.taskDone[t.id] || !t.validate) continue;
      var ok = false;
      try { ok = !!match(t.validate, action, params); }
      catch (e) { ok = false; }
      if (ok) {
        inst.taskDone[t.id] = true;
        changed = true;
        inst.log.push({ msg: '\u2714 Task validated: ' + (t.instruction || t.id) });
      }
    }
    if (changed && tasksDone(inst) === tasks.length && tasks.length) {
      inst.done = true;
      state.done[inst.sim.id] = true;
      saveDone();
    }
  }

  /* ---------- load & events ---------- */
  function render() {
    injectCSS();
    showSection();
    state.done = loadDone();
    var body = $('consoleBody');
    if (state.loaded) {
      if (state.inst) paintConsole();
      else paintList();
      return;
    }
    if (body) {
      body.innerHTML = '<p style="color:var(--muted)">Loading simulated consoles\u2026</p>';
    }
    fetch('./content.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('content.json ' + r.status);
        return r.json();
      })
      .then(function (data) {
        state.sims = (data && data.consoleSims) || [];
        state.loaded = true;
        paintList();
      })
      .catch(function () {
        state.sims = [];
        state.loaded = true;
        if (body) body.innerHTML = counterHtml() + emptyHtml();
      });
  }

  document.addEventListener('ilb:view', function (e) {
    if (e && e.detail === 'console') render();
  });

  window.ConsoleView = { render: render, launch: launch };

  /* Testing seam (headless): console defs + matcher for validation tests. */
  if (typeof window !== 'undefined' && window.ENGINE_TEST) {
    window.__consoleEngine = {
      consoles: Object.keys(CONSOLES),
      match: defaultMatch,
      subsetMatch: subsetMatch,
      coerce: coerce
    };
  }
})();
