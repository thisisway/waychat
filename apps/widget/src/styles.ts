/** Estilo do widget. Vive dentro do Shadow DOM: o CSS do site não entra, o daqui não sai. Valores = tokens do design system. */
export const css = `
:host { all: initial; }
.wc {
  --primary: #1560ff; --primary-hover: #0f4cdc; --on-primary: #fff;
  --surface: #fff; --surface-muted: #f2f4f7; --chat-bg: #eff3f8; --bubble-in: #fff; --bubble-out: #cae7fb;
  --text: #16181d; --text-secondary: #5a5e64; --text-muted: #6a6e75; --danger-text: #c62828; --success: #0a9426;
  --hairline: rgb(16 24 40 / .06); --shadow: 0 1px 2px rgb(16 24 40 / .04), 0 12px 40px rgb(16 24 40 / .18);
  --focus: rgb(21 96 255 / .3); --unread: #ffdb31; --on-unread: #16181d; --warning-bg: #ffefb4; --warning-text: #8c4915;
  font: 400 14px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--text);
}
@media (prefers-color-scheme: dark) {
  .wc {
    --surface: #1b1f26; --surface-muted: #232833; --chat-bg: #12151a; --bubble-in: #232833; --bubble-out: #16335f;
    --text: #e8eaed; --text-secondary: #a0a6af; --text-muted: #8f959f; --danger-text: #ff8a87; --success: #34c759;
    --hairline: rgb(255 255 255 / .08); --shadow: 0 1px 2px rgb(0 0 0 / .3), 0 12px 40px rgb(0 0 0 / .5);
    --focus: rgb(122 165 255 / .4); --warning-bg: #3a2e10; --warning-text: #f5c26b;
  }
}
.wc * { box-sizing: border-box; }
.launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; width: 56px; height: 56px; border: 0; border-radius: 50%;
  background: var(--primary); color: var(--on-primary); cursor: pointer; display: grid; place-items: center;
  box-shadow: 0 4px 12px rgb(21 96 255 / .35); transition: transform .15s cubic-bezier(.16,1,.3,1), background .15s;
}
.launcher:hover { background: var(--primary-hover); transform: scale(1.05); }
.launcher:focus-visible, .wc button:focus-visible, .wc input:focus-visible, .wc textarea:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.launcher svg { width: 26px; height: 26px; }
.badge {
  position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: var(--unread); color: var(--on-unread); font-size: 12px; font-weight: 700; display: grid; place-items: center;
}
.panel {
  position: fixed; right: 20px; bottom: 88px; z-index: 2147483000; width: 380px; height: min(600px, calc(100vh - 108px));
  display: flex; flex-direction: column; overflow: hidden; border-radius: 20px; background: var(--surface); box-shadow: var(--shadow);
  animation: rise .2s cubic-bezier(.16,1,.3,1);
}
@keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
@media (max-width: 480px) { .panel { inset: 0; width: auto; height: auto; border-radius: 0; } .wc:has(.panel) .launcher { display: none; } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none; } .launcher { transition: none; } }
.head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; background: var(--primary); color: var(--on-primary); }
.head h2 { margin: 0; font-size: 16px; font-weight: 700; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 2px rgb(255 255 255 / .35); }
.head button { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 6px; border-radius: 8px; display: grid; }
.head button:hover { background: rgb(255 255 255 / .16); }
.status { padding: 6px 16px; background: var(--warning-bg); color: var(--warning-text); font-size: 12px; font-weight: 600; }
.list { flex: 1; overflow-y: auto; padding: 16px; background: var(--chat-bg); display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 82%; padding: 9px 13px; border-radius: 16px; white-space: pre-wrap; overflow-wrap: anywhere; box-shadow: 0 1px 2px var(--hairline); }
.msg.agent { align-self: flex-start; background: var(--bubble-in); border-bottom-left-radius: 6px; }
.msg.visitor { align-self: flex-end; background: var(--bubble-out); border-bottom-right-radius: 6px; }
.msg.pending { opacity: .6; }
.meta { display: block; margin-top: 2px; font-size: 11px; color: var(--text-muted); }
.retry { border: 0; background: none; padding: 0; color: var(--danger-text); font: inherit; font-size: 12px; text-decoration: underline; cursor: pointer; }
.welcome { align-self: flex-start; max-width: 82%; padding: 9px 13px; border-radius: 16px; background: var(--bubble-in); color: var(--text-secondary); }
.form { display: flex; flex-direction: column; gap: 10px; padding: 20px 16px; }
.form h3 { margin: 0 0 4px; font-size: 16px; }
.form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.wc input, .wc textarea {
  font: inherit; color: var(--text); background: var(--surface-muted); border: 1px solid transparent; border-radius: 10px; padding: 10px 12px; width: 100%;
}
.primary { border: 0; border-radius: 10px; padding: 11px 16px; font: inherit; font-weight: 700; color: var(--on-primary); background: var(--primary); cursor: pointer; }
.primary:hover { background: var(--primary-hover); }
.primary:disabled { opacity: .5; cursor: default; }
.composer { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-top: 1px solid var(--hairline); background: var(--surface); }
.composer textarea { resize: none; max-height: 120px; min-height: 40px; }
.composer .primary { padding: 10px 14px; }
.clip { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; padding: 8px; border-radius: 10px; display: grid; }
.clip:hover:not(:disabled) { background: var(--surface-muted); color: var(--primary); }
.clip:disabled { opacity: .4; cursor: default; }
.clip svg { width: 22px; height: 22px; }
.drafts { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; border-top: 1px solid var(--hairline); background: var(--surface); }
.drafts + .composer { border-top: 0; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 4px 8px; border: 1px solid var(--hairline); border-radius: 8px;
  background: var(--surface-muted); color: var(--text); font: inherit; font-size: 12px; text-align: left;
}
.chip .nm { min-width: 0; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip .sz { color: var(--text-muted); white-space: nowrap; }
.chip.bad .sz { color: var(--danger-text); font-weight: 600; }
.chip .x { border: 0; background: none; padding: 0 2px; color: var(--text-secondary); font-size: 16px; line-height: 1; cursor: pointer; border-radius: 4px; }
.chip .x:hover { color: var(--danger-text); }
button.chip { cursor: pointer; }
button.chip:hover { border-color: var(--primary); }
.atts { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; white-space: normal; }
.atts:not(:first-child) { margin-top: 6px; }
.msg .chip { background: var(--surface); }
.error { padding: 24px 16px; text-align: center; color: var(--danger-text); display: flex; flex-direction: column; gap: 12px; align-items: center; }
`;
