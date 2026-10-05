export const adminStyles = String.raw`
:root {
  --bg: #f4f6fa;
  --panel: #ffffff;
  --ink: #172033;
  --muted: #6f7b8f;
  --line: #e4e8ef;
  --line-strong: #d7dde7;
  --nav: #0c1526;
  --nav-soft: #17243a;
  --primary: #2457d6;
  --primary-soft: #eef3ff;
  --cyan: #0c92a8;
  --good: #087a59;
  --good-soft: #e9f7f1;
  --warn: #ad6814;
  --warn-soft: #fff4df;
  --bad: #b53d43;
  --bad-soft: #fff0f1;
  --shadow: 0 10px 30px rgba(20, 32, 55, .055);
  --radius: 15px;
}
* { box-sizing: border-box; }
html { min-width: 320px; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 Inter, "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
button, input, select, textarea { font: inherit; }
button { color: inherit; }
.hidden { display: none !important; }
.shell { min-height: 100vh; }
.sidebar { position: fixed; inset: 0 auto 0 0; display: flex; flex-direction: column; width: 268px; background: linear-gradient(180deg, #0d1729 0%, #0a1322 100%); color: #d8dfeb; padding: 18px 14px 16px; border-right: 1px solid rgba(255,255,255,.04); box-shadow: 12px 0 34px rgba(13, 24, 43, .08); z-index: 10; overflow: hidden; }
.brand { display: flex; align-items: center; gap: 12px; padding: 7px 8px 18px; }
.brand-mark { display: grid; place-items: center; flex: 0 0 42px; width: 42px; height: 42px; border-radius: 13px; color: #fff; font-size: 17px; font-weight: 850; background: linear-gradient(145deg, #3478f6, #10a8b9); box-shadow: 0 10px 28px rgba(37, 104, 230, .30); }
.brand-copy { min-width: 0; }
.brand-name { overflow: hidden; color: #fff; font-size: 16px; font-weight: 760; letter-spacing: .05px; text-overflow: ellipsis; white-space: nowrap; }
.brand-meta { margin-top: 2px; color: #7f8da5; font-size: 11px; letter-spacing: .25px; }
.environment { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 4px 15px; padding: 10px 12px; border: 1px solid #263650; border-radius: 11px; background: rgba(255,255,255,.025); color: #b5c0d1; font-size: 12px; }
.environment-state { display: inline-flex; align-items: center; gap: 8px; }
.environment strong { padding: 2px 7px; border-radius: 99px; background: rgba(43,193,144,.11); color: #72d8b5; font-size: 10px; font-weight: 700; }
.environment-dot { width: 7px; height: 7px; border-radius: 50%; background: #2bc190; box-shadow: 0 0 0 4px rgba(43, 193, 144, .12); }
.nav-scroll { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 0 2px 8px 0; scrollbar-width: thin; scrollbar-color: #29364c transparent; }
.nav-section { margin: 18px 11px 7px; color: #65738b; font-size: 10px; font-weight: 760; letter-spacing: 1.25px; }
.nav-section:first-child { margin-top: 7px; }
.nav { display: grid; gap: 4px; }
.nav button { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 43px; border: 1px solid transparent; background: transparent; color: #9eacc0; padding: 9px 11px; border-radius: 11px; text-align: left; font-size: 13px; font-weight: 590; cursor: pointer; transition: color .16s ease, background-color .16s ease, border-color .16s ease, transform .12s ease; }
.nav button:hover { color: #f4f7fc; background: rgba(255, 255, 255, .055); }
.nav button:active { transform: scale(.985); }
.nav button.on { color: #fff; border-color: rgba(116, 153, 250, .22); background: linear-gradient(100deg, rgba(54,105,221,.30), rgba(50,88,156,.16)); box-shadow: inset 3px 0 0 #5f8cff, 0 8px 18px rgba(0, 0, 0, .10); }
.nav-icon { display: grid; place-items: center; flex: 0 0 20px; width: 20px; height: 20px; color: #7386a7; font-style: normal; }
.nav-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.nav button.on .nav-icon { color: #91b0ff; }
.nav-badge { margin-left: auto; min-width: 19px; padding: 1px 5px; border-radius: 99px; background: #bc434a; color: #fff; font-size: 10px; text-align: center; }
.sidebar-foot { display: flex; align-items: center; gap: 10px; margin: 12px 4px 0; padding: 14px 8px 2px; border-top: 1px solid #233048; color: #7d8aa0; font-size: 11px; }
.security-mark { display: grid; place-items: center; flex: 0 0 25px; width: 25px; height: 25px; border-radius: 8px; background: rgba(43,193,144,.10); color: #68d4ae; font-weight: 800; }
.sidebar-foot div { min-width: 0; }
.sidebar-foot strong, .sidebar-foot small { display: block; }
.sidebar-foot strong { color: #aab6c8; font-size: 11px; font-weight: 650; }
.sidebar-foot small { margin-top: 1px; color: #65738a; font-size: 9px; white-space: nowrap; }
.sidebar-logout { margin-left: auto; border: 0; padding: 5px 4px; background: transparent; color: #738198; font-size: 11px; cursor: pointer; }
.sidebar-logout:hover { color: #fff; }
.workspace { margin-left: 268px; min-width: 0; }
.topbar { position: sticky; top: 0; z-index: 8; display: flex; align-items: center; gap: 18px; height: 60px; padding: 0 30px; background: rgba(255, 255, 255, .94); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.runtime-state { display: none; }
.crumb { color: #8a95a6; font-size: 12px; }
.crumb strong { color: #344057; font-weight: 650; }
.top-actions { display: flex; align-items: center; gap: 9px; }
.system-pill { display: flex; align-items: center; gap: 7px; padding: 7px 10px; background: #f6f8fb; border: 1px solid var(--line); border-radius: 8px; color: #536076; font-size: 12px; }
.system-pill.good { color: var(--good); background: var(--good-soft); border-color: #cbeadd; }
.system-pill.warn { color: var(--warn); background: var(--warn-soft); border-color: #f2ddb6; }
.content { width: 100%; max-width: 1720px; padding: 28px 30px 56px; }
.page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
.page-head h1 { margin: 0; font-size: 24px; letter-spacing: -.45px; }
.page-head p { margin: 4px 0 0; color: var(--muted); }
.view { display: none; }
.view.on { display: block; animation: enter .16s ease-out; }
@keyframes enter { from { opacity: .35; transform: translateY(3px); } }
.grid { display: grid; gap: 16px; }
.kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; }
.kpi { position: relative; overflow: hidden; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 18px 18px; box-shadow: var(--shadow); }
.kpi::before { content: ''; position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, #2457d6, #72a0ff); opacity: .72; }
.kpi-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
.kpi-icon { display: none; }
.kpi-value { display: block; margin: 12px 0 3px; font-size: 26px; font-weight: 760; letter-spacing: -.6px; }
.kpi-foot { color: #929cad; font-size: 11px; }
.layout-2 { grid-template-columns: minmax(0, 1.45fr) minmax(320px, .8fr); }
.layout-equal { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 16px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 17px 19px; border-bottom: 1px solid #edf0f4; }
.panel-head h2 { margin: 0; font-size: 15px; }
.panel-head p { margin: 2px 0 0; color: var(--muted); font-size: 12px; }
.panel-body { padding: 18px 19px; }
.panel-flat { padding: 19px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; border: 1px solid var(--line-strong); border-radius: 8px; padding: 8px 12px; background: #fff; color: #364258; font-weight: 650; cursor: pointer; text-decoration: none; transition: .15s ease; }
.btn:hover { border-color: #bfc8d8; background: #f8fafc; }
.btn.primary { color: #fff; background: var(--primary); border-color: var(--primary); }
.btn.primary:hover { background: #194bc5; }
.btn.danger { color: var(--bad); background: var(--bad-soft); border-color: #f2cfd1; }
.btn.small { min-height: 30px; padding: 5px 9px; font-size: 12px; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.toolbar { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; }
.toolbar .field { min-width: 150px; }
.toolbar .search { flex: 1; min-width: 230px; }
.date-toolbar { margin-top: 12px; }
.date-presets { display: flex; gap: 8px; flex-wrap: wrap; }
.date-preset.active { color: var(--primary); border-color: #a9bdf2; background: #edf3ff; box-shadow: inset 0 0 0 1px rgba(36, 87, 214, .06); }
.range-label { color: var(--primary); background: #edf3ff; border: 1px solid #dbe6ff; border-radius: 999px; padding: 6px 10px; font-size: 12px; font-weight: 760; }
.date-input { position: relative; min-width: 188px; }
.date-input > input[type="text"] { padding-right: 42px; font-variant-numeric: tabular-nums; letter-spacing: .2px; }
.date-picker-button { position: absolute; z-index: 2; inset: 1px 1px 1px auto; display: grid; place-items: center; width: 38px; border: 0; border-left: 1px solid #edf0f4; border-radius: 0 7px 7px 0; background: #fff; color: #68758a; cursor: pointer; }
.date-picker-button:hover { background: #f5f8ff; color: var(--primary); }
.date-picker-button svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.date-picker-proxy { position: absolute; width: 1px !important; height: 1px; right: 18px; bottom: 3px; padding: 0 !important; border: 0 !important; opacity: 0; pointer-events: none; }
.field-hint { margin: 9px 0 0; color: #8994a6; font-size: 11px; }
.field { display: grid; gap: 6px; }
.field label { color: #344057; font-size: 12px; font-weight: 680; }
.field input, .field select, .field textarea, .session-input { width: 100%; border: 1px solid var(--line-strong); border-radius: 8px; padding: 9px 11px; background: #fff; color: var(--ink); outline: none; }
.field input:focus, .field select:focus, .field textarea:focus, .session-input:focus { border-color: #7899ed; box-shadow: 0 0 0 3px rgba(36, 87, 214, .09); }
.field input[aria-invalid="true"] { border-color: #d7686e; box-shadow: 0 0 0 3px rgba(181, 61, 67, .08); }
.field small { color: var(--muted); font-size: 11px; }
.request-progress { position: fixed; z-index: 9999; inset: 0 0 auto 0; height: 3px; opacity: 0; pointer-events: none; transition: opacity .15s ease; overflow: hidden; }
.request-progress span { display: block; width: 38%; height: 100%; border-radius: 0 3px 3px 0; background: linear-gradient(90deg, var(--primary), #65c7ff); transform: translateX(-110%); }
.request-progress.active { opacity: 1; }
.request-progress.active span { animation: request-progress 1s ease-in-out infinite; }
@keyframes request-progress { 0% { transform: translateX(-110%); } 70%, 100% { transform: translateX(280%); } }
.btn { transition: transform .12s ease, box-shadow .16s ease, background-color .16s ease, border-color .16s ease, opacity .16s ease; }
.btn:active, .btn.pressed { transform: translateY(1px) scale(.985); }
.btn.request-pending { cursor: wait; opacity: .78; }
.btn.request-pending::after { content: ''; width: 12px; height: 12px; margin-left: 7px; display: inline-block; vertical-align: -2px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: button-spin .65s linear infinite; }
@keyframes button-spin { to { transform: rotate(360deg); } }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 15px; }
.span-2 { grid-column: 1 / -1; }
.actions { display: flex; align-items: center; justify-content: flex-end; gap: 9px; margin-top: 16px; }
.tag { display: inline-flex; align-items: center; gap: 5px; padding: 3px 7px; border-radius: 6px; background: #f0f2f6; color: #5b6678; font-size: 11px; font-weight: 650; }
.tag.good { color: var(--good); background: var(--good-soft); }
.tag.warn { color: var(--warn); background: var(--warn-soft); }
.tag.bad { color: var(--bad); background: var(--bad-soft); }
.tag.info { color: var(--primary); background: var(--primary-soft); }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #99a4b5; }
.tag.good .status-dot { background: #17a177; }
.tag.warn .status-dot { background: #d28824; }
.tag.bad .status-dot { background: #d04d54; }
.table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 10px; }
table { width: 100%; border-collapse: collapse; white-space: nowrap; }
th, td { padding: 11px 12px; border-bottom: 1px solid #edf0f4; text-align: left; font-size: 12px; vertical-align: middle; }
th { position: sticky; top: 0; z-index: 1; background: #f8f9fb; color: #657187; font-size: 11px; font-weight: 720; }
tbody tr:hover { background: #fafbfc; }
tbody tr:last-child td { border-bottom: 0; }
td strong { color: #253047; font-weight: 700; }
.selectable-row { transition: background-color .15s ease, box-shadow .15s ease; }
.selectable-row:hover { background: #f5f8ff; }
.selectable-row:focus-within { background: #f2f6ff; box-shadow: inset 3px 0 0 #8aa7ee; }
.selectable-row.selected-row { background: #dce8ff !important; box-shadow: inset 5px 0 0 #2457d6; }
.selectable-row.selected-row > td { background: #dce8ff !important; border-color: #aec4f5; }
.selectable-row.selected-row td:first-child { box-shadow: inset 5px 0 0 #2457d6; }
.selectable-row.selected-row td:first-child strong { color: #123fa7; }
.selectable-row.selected-row .btn { border-color: #7899ed; background: #fff; color: #1749bd; }
.interactive-row { cursor: pointer; transition: background-color .15s ease, box-shadow .15s ease; }
.interactive-row:hover { background: #f6f9ff; box-shadow: inset 3px 0 0 #5d85ed; }
.interactive-row:focus-visible { outline: 2px solid #7899ed; outline-offset: -2px; background: #f6f9ff; }
.row-action { display: inline-flex; align-items: center; gap: 4px; padding: 6px 9px; border-radius: 7px; background: var(--primary-soft); color: var(--primary); font-size: 11px; font-weight: 800; white-space: nowrap; transition: background .16s ease, color .16s ease; }
.row-action svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.table-actions { display: flex; align-items: center; gap: 6px; }
.pagination-wrap { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 58px; padding: 11px 19px 15px; border-top: 1px solid #edf0f4; }
.pagination-summary { color: var(--muted); font-size: 12px; }
.pagination-actions { display: flex; align-items: center; gap: 7px; }
.page-current { min-width: 94px; color: #465268; font-size: 12px; font-weight: 680; text-align: center; }
.list-filter { align-items: flex-end; }
.list-filter .date-input { min-width: 168px; }
.interactive-row:hover .row-action, .interactive-row:focus-visible .row-action { background: var(--primary); color: #fff; }
.order-title { display: flex; align-items: center; gap: 7px; }
.order-source { padding: 2px 6px; }
.sub { display: block; margin-top: 2px; color: #8c97a8; font-size: 10px; }
.amount { font-variant-numeric: tabular-nums; font-weight: 650; }
.amount.good { color: var(--good); }
.amount.bad { color: var(--bad); }
.empty { display: grid; place-items: center; min-height: 170px; padding: 30px; color: var(--muted); text-align: center; }
.empty.compact { min-height: 96px; }
.metric-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.metric { padding: 13px; border: 1px solid var(--line); border-radius: 10px; background: #fafbfd; }
.metric span { display: block; color: var(--muted); font-size: 11px; }
.metric strong { display: block; margin-top: 5px; font-size: 20px; }
.metric-good { color: var(--good); }
.metric-bad { color: var(--bad); }
.settlement-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; margin: 0 19px; border: 1px solid var(--line); border-radius: 11px; background: var(--line); overflow: hidden; }
.settlement-summary > div { padding: 13px 15px; background: #fafbfd; }
.settlement-summary span, .settlement-summary strong { display: block; }
.settlement-summary span { color: var(--muted); font-size: 11px; }
.settlement-summary strong { margin-top: 3px; font-size: 18px; }
.invoice-lookup { margin-top: 16px; }
.invoice-order-head { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-bottom: 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--line); overflow: hidden; }
.invoice-order-head > div { padding: 12px 14px; background: #fafbfd; }
.invoice-order-head span, .invoice-order-head strong { display: block; }
.invoice-order-head span { color: var(--muted); font-size: 10px; }
.invoice-order-head strong { margin-top: 3px; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.task-list { display: grid; gap: 9px; }
.task { display: flex; align-items: center; gap: 11px; padding: 13px 14px; border: 1px solid var(--line); border-radius: 10px; }
.task-icon { display: grid; place-items: center; flex: 0 0 29px; height: 29px; border-radius: 8px; background: var(--warn-soft); color: var(--warn); font-weight: 800; }
.task-main { min-width: 0; flex: 1; }
.task-main b { display: block; font-size: 12px; }
.task-main span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; line-height: 1.5; white-space: normal; }
.task-main small { display: block; margin-top: 3px; color: #97a2b4; font-size: 10px; }
.task-link { width: 100%; color: inherit; background: var(--panel); font: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
.task-link:hover { border-color: #9fb7ec; box-shadow: 0 8px 20px rgba(47,91,211,.09); transform: translateY(-1px); }
.task-link:focus-visible { outline: 3px solid rgba(47,91,211,.2); border-color: var(--primary); }
.task-action { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; padding: 7px 10px; border-radius: 8px; background: var(--primary-soft); color: var(--primary); font-size: 11px; font-weight: 800; white-space: nowrap; transition: background .16s ease, color .16s ease; }
.task-action span { margin: 0; color: inherit; font-size: inherit; line-height: 1; }
.task-action svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.task-link:hover .task-action { background: var(--primary); color: #fff; }
.activation-reason { min-width: 175px; max-width: 330px; }
.activation-reason strong, .activation-reason span, .activation-reason code { display: block; }
.activation-reason strong { color: var(--bad); font-size: 12px; }
.activation-reason span { margin-top: 3px; color: var(--text); font-size: 11px; line-height: 1.45; white-space: normal; }
.activation-reason code { width: fit-content; margin-top: 5px; padding: 2px 6px; border-radius: 5px; background: var(--bad-soft); color: var(--bad); font: 600 10px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; }
.activation-message { color: var(--muted); font-size: 11px; }
.activation-message.success { color: var(--good); font-weight: 700; }
.diagnostic { overflow: hidden; }
.diagnostic summary { padding: 17px 20px; cursor: pointer; font-size: 13px; font-weight: 700; color: var(--muted); }
.diagnostic[open] summary { color: var(--text); }
.control-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
.control { display: flex; gap: 11px; padding: 14px; border: 1px solid var(--line); border-radius: 10px; }
.control-check { display: grid; place-items: center; flex: 0 0 27px; height: 27px; border-radius: 50%; background: var(--good-soft); color: var(--good); font-weight: 900; }
.control.attention .control-check { color: var(--warn); background: var(--warn-soft); }
.control b { display: block; font-size: 12px; }
.control span { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
.progress { height: 7px; overflow: hidden; background: #edf0f4; border-radius: 99px; }
.progress > span { display: block; height: 100%; border-radius: inherit; background: var(--primary); }
.funnel { display: grid; gap: 13px; }
.funnel-line { display: grid; grid-template-columns: 92px 1fr 38px; gap: 10px; align-items: center; font-size: 12px; }
.product-table input { min-width: 105px; }
.product-table .switch { margin: auto; }
.switch { position: relative; width: 38px; height: 22px; display: inline-block; }
.switch input { width: 0; height: 0; opacity: 0; }
.switch span { position: absolute; inset: 0; border-radius: 99px; background: #c8cfda; cursor: pointer; transition: .18s; }
.switch span::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .18); transition: .18s; }
.switch input:checked + span { background: #189a71; }
.switch input:checked + span::before { transform: translateX(16px); }
.integration-card { border: 1px solid var(--line); border-radius: 11px; overflow: hidden; }
.integration-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 15px; background: #fafbfd; border-bottom: 1px solid var(--line); }
.integration-body { padding: 15px; }
.notice { padding: 12px 14px; border: 1px solid #eed9b2; border-radius: 9px; background: var(--warn-soft); color: #795019; font-size: 12px; }
.notice.info { border-color: #cfdbf8; background: var(--primary-soft); color: #2a4e9d; }
.notice.good { border-color: #cbe8dc; background: var(--good-soft); color: var(--good); }
.test-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
.test-step { padding: 10px 12px; border-radius: 8px; background: #f0f2f6; color: #7d8899; font-size: 12px; }
.test-step.on { background: var(--primary-soft); color: var(--primary); font-weight: 700; }
.test-step.done { background: var(--good-soft); color: var(--good); font-weight: 700; }
.result-box { padding: 13px; border: 1px solid var(--line); border-radius: 9px; background: #fafbfd; }
.result-row { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; }
.invoice-issue-card { width: min(620px, 100%); max-height: 92vh; overflow: auto; }
.invoice-facts { overflow: hidden; border: 1px solid #d9e1ef; border-radius: 12px; background: #fff; }
.invoice-facts-primary { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 20px; align-items: center; padding: 17px 18px; background: linear-gradient(135deg, #f7faff 0%, #eef4ff 100%); }
.invoice-identity span, .invoice-total span, .invoice-facts-secondary span, .invoice-facts-meta span { display: block; color: var(--muted); font-size: 10px; font-weight: 650; }
.invoice-identity strong { display: block; margin-top: 5px; color: var(--ink); font-size: 15px; line-height: 1.45; }
.invoice-identity small { display: block; margin-top: 8px; color: #44506a; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; font-weight: 700; letter-spacing: .02em; }
.invoice-total { min-width: 134px; padding: 13px 15px; border: 1px solid #c8d6f6; border-radius: 10px; background: #fff; text-align: right; box-shadow: 0 5px 16px rgba(36, 87, 214, .08); }
.invoice-total strong { display: block; margin-top: 5px; color: var(--primary); font-size: 26px; line-height: 1; letter-spacing: -.03em; }
.invoice-facts-secondary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px 22px; padding: 14px 18px; border-top: 1px solid #e5eaf2; }
.invoice-facts-secondary .wide { grid-column: 1 / -1; }
.invoice-facts-secondary strong { display: block; margin-top: 4px; color: #465169; font-size: 11px; font-weight: 560; line-height: 1.5; overflow-wrap: anywhere; }
.invoice-facts-meta { display: flex; justify-content: space-between; gap: 12px; padding: 9px 18px; border-top: 1px solid #edf0f5; background: #fafbfd; }
.invoice-facts-meta strong { color: #657086; font-size: 10px; overflow-wrap: anywhere; }
.session-input { min-height: 150px; resize: vertical; font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
.login { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 20px; background: radial-gradient(circle at 28% 18%, #263b62 0, #111a2a 54%, #0b111c 100%); }
.login-card { width: min(420px, 100%); padding: 30px; background: #fff; border-radius: 16px; box-shadow: 0 32px 80px rgba(0, 0, 0, .34); }
.login-card h1 { margin: 16px 0 4px; font-size: 22px; }
.login-card p { margin: 0 0 22px; color: var(--muted); }
.login-card .field { margin-bottom: 13px; }
.error { min-height: 21px; color: var(--bad); font-size: 12px; }
.toast { position: fixed; left: 50%; top: 50%; z-index: 60; display: flex; align-items: flex-start; gap: 12px; width: min(430px, calc(100vw - 32px)); padding: 16px 18px; border: 1px solid rgba(255,255,255,.10); border-radius: 14px; background: rgba(18, 28, 46, .97); color: #fff; box-shadow: 0 22px 70px rgba(8, 17, 31, .32); transform: translate(-50%, -50%); pointer-events: none; backdrop-filter: blur(12px); }
.toast:not(.hidden) { animation: toast-enter .2s ease-out; }
.toast.error { background: rgba(87, 28, 35, .98); border-color: rgba(255, 156, 164, .22); }
.toast-icon { display: grid; place-items: center; flex: 0 0 28px; width: 28px; height: 28px; border-radius: 50%; background: #27ae83; color: #fff; font-size: 14px; font-weight: 900; }
.toast.error .toast-icon { background: #e06169; }
.toast-copy { display: grid; gap: 2px; min-width: 0; }
.toast-copy strong { font-size: 13px; }
.toast-copy span { color: #d7ddea; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
@keyframes toast-enter { from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)) scale(.98); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
.modal { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 18px; background: rgba(12, 20, 34, .58); }
.modal-card { width: min(500px, 100%); padding: 22px; border-radius: 13px; background: #fff; box-shadow: 0 24px 70px rgba(0, 0, 0, .22); }
.modal-card h3 { margin: 0 0 16px; }
.confirm-modal { z-index: 70; }
.confirm-card { width: min(430px, 100%); padding: 28px 28px 24px; text-align: center; }
.confirm-card h3 { margin: 14px 0 8px; font-size: 18px; }
.confirm-card p { margin: 0; color: var(--muted); line-height: 1.7; white-space: pre-line; }
.confirm-icon { display: grid; place-items: center; width: 46px; height: 46px; margin: 0 auto; border-radius: 50%; background: var(--primary-soft); color: var(--primary); font-size: 22px; font-weight: 850; }
.confirm-card.danger .confirm-icon { background: var(--bad-soft); color: var(--bad); }
.confirm-actions { justify-content: center; margin-top: 22px; }
.confirm-actions .btn { min-width: 104px; }
.modal-head { padding: 0 0 15px; }
.customer-modal-card { width: min(1040px, 100%); max-height: 90vh; overflow: auto; }
.manual-order-card { width: min(650px, 100%); max-height: 90vh; overflow: auto; }
.manual-activation { margin: 20px 0; padding: 18px; border: 1px solid #cfdbf8; border-radius: 12px; background: #f8faff; }
.manual-cash-success { display: flex; align-items: center; gap: 14px; margin: 18px 0 12px; padding: 16px; border: 1px solid #cbe8dc; border-radius: 12px; background: var(--good-soft); }
.manual-cash-success h3 { margin: 5px 0 0; color: var(--good); font-size: 24px; }
.cash-success-icon { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; border-radius: 50%; background: var(--good); color: #fff; font-size: 22px; font-weight: 850; }
.customer-identity { display: grid; grid-template-columns: auto minmax(140px, 1fr) auto minmax(140px, 1fr) auto minmax(140px, 1fr); gap: 8px 12px; align-items: center; margin: 16px 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: #fafbfd; }
.customer-identity span { color: var(--muted); font-size: 11px; }
.customer-identity strong { font-size: 12px; }
.customer-metrics { margin-bottom: 18px; }
.section-heading { display: flex; justify-content: space-between; align-items: flex-end; margin: 4px 0 10px; }
.section-heading h3 { margin: 0; }
.section-heading p { margin: 3px 0 0; color: var(--muted); font-size: 11px; }
@media (max-width: 1180px) {
  .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .layout-2, .layout-equal { grid-template-columns: 1fr; }
  .settlement-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 820px) {
  .sidebar { position: static; width: auto; padding: 12px; overflow: visible; }
  .environment, .sidebar-foot, .nav-section { display: none; }
  .brand { padding: 3px 3px 11px; }
  .nav-scroll { display: flex; flex: none; gap: 6px; overflow-x: auto; padding: 0; }
  .nav { display: flex; flex: 0 0 auto; overflow: visible; }
  .nav button { width: auto; flex: 0 0 auto; white-space: nowrap; }
  .workspace { margin-left: 0; }
  .topbar { position: static; height: 52px; padding: 0 16px; }
  .content { padding: 18px 14px 40px; }
  .form-grid, .control-list { grid-template-columns: 1fr; }
  .settlement-summary { grid-template-columns: 1fr; }
  .invoice-order-head { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .customer-identity { grid-template-columns: auto 1fr; }
  .pagination-wrap { align-items: flex-start; flex-direction: column; }
  .pagination-actions { width: 100%; overflow-x: auto; padding-bottom: 2px; }
  .span-2 { grid-column: auto; }
}
@media (max-width: 540px) {
  .kpi-grid, .metric-row, .test-steps { grid-template-columns: 1fr; }
  .page-head { flex-direction: column; }
  .toolbar { align-items: stretch; }
  .toolbar .field, .toolbar .search { width: 100%; }
}
`;
