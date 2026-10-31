/** The card's CSS, injected once; colours through the theme's --dsw-alias-* tokens only. */
const CSS = `
.pgw-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-size:13px}
.pgw-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pgw-title{font-size:14px;font-weight:600;margin:0}
.pgw-badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.pgw-badge--on{color:var(--dsw-alias-state-success-primary,#2e9d5b)}
.pgw-badge--off{color:var(--dsw-alias-state-warn-primary,#e0982e)}
.pgw-meta{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.pgw-spacer{flex:1}
.pgw-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pgw-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.pgw-btn:disabled{opacity:.5;cursor:default}
.pgw-tabs{display:flex;gap:16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.pgw-tab{font:inherit;font-size:13px;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:6px 0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.pgw-tab:hover{color:var(--dsw-alias-label-primary)}
.pgw-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary)}
.pgw-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px}
.pgw-stat{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.pgw-stat__label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.pgw-stat__value{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.pgw-stat__sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.pgw-stat--warn .pgw-stat__value{color:var(--dsw-alias-state-warn-primary,#e0982e)}
.pgw-stat--error .pgw-stat__value{color:var(--dsw-alias-state-error-primary)}
.pgw-dists{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.pgw-dist{display:flex;flex-direction:column;gap:6px}
.pgw-dist__title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.pgw-bar{display:grid;grid-template-columns:minmax(60px,40%) 1fr auto;align-items:center;gap:8px;font-size:12px}
.pgw-bar__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.pgw-bar__track{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.pgw-bar__fill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary)}
.pgw-bar__value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.pgw-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.pgw-warn{font-size:12px;line-height:1.5;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warn-primary,#e0982e);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0982e) 8%,transparent)}
.pgw-warn--error{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.pgw-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.pgw-row{display:grid;grid-template-columns:auto 1fr auto auto;gap:10px;align-items:center;width:100%;font:inherit;font-size:12px;text-align:left;padding:7px 10px;background:none;border:none;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);cursor:pointer}
.pgw-row:first-child{border-top:none}
.pgw-row:hover{background:var(--dsw-alias-bg-layer-2)}
.pgw-row--zero{color:var(--dsw-alias-label-tertiary)}
.pgw-row__time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.pgw-row__where{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pgw-row__fail{color:var(--dsw-alias-state-error-primary)}
.pgw-detail{padding:6px 10px 10px;background:var(--dsw-alias-bg-layer-2);font-size:12px;overflow-x:auto}
.pgw-detail table{border-collapse:collapse;width:100%}
.pgw-detail th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:3px 8px 3px 0}
.pgw-detail td{padding:3px 8px 3px 0;font-family:var(--dsw-font-mono,ui-monospace,monospace);white-space:nowrap}
.pgw-pager{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.pgw-switch{display:flex;align-items:flex-start;gap:8px;cursor:pointer}
.pgw-switch input{margin-top:2px}
.pgw-switch__text{display:flex;flex-direction:column;gap:2px}
.pgw-cfg{display:flex;flex-direction:column;gap:12px}
.pgw-providers{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pgw-providers legend{padding:0;margin-bottom:2px}
.pgw-check{display:flex;align-items:center;gap:8px;cursor:pointer}
.pgw-add{display:flex;gap:6px;align-items:center}
.pgw-add input{flex:1;min-width:0;max-width:240px;font:inherit;font-size:12px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary)}
.pgw-btn:disabled{opacity:.5;cursor:default}
.pgw-tab-icon{flex:none;vertical-align:-3px;margin-right:4px}
.pgw-card--panel{border:none;border-radius:0;background:transparent;padding:12px}
.pgw-detail__btn{margin-top:8px}
.pgw-check{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.pgw-view{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.pgw-view__scroll{max-height:420px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent)}
.pgw-view__table{border-collapse:collapse;width:100%;table-layout:fixed}
.pgw-view__table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);font-weight:500;color:var(--dsw-alias-label-tertiary);text-align:left;padding:4px 8px}
.pgw-view__table th:first-child,.pgw-view__n{width:44px}
.pgw-view__n{color:var(--dsw-alias-label-tertiary);text-align:right;font-variant-numeric:tabular-nums;padding:2px 8px;vertical-align:top}
.pgw-detail .pgw-view__code{font-family:var(--dsw-font-mono,ui-monospace,monospace);white-space:pre-wrap;word-break:break-all;padding:2px 8px;vertical-align:top;border-left:1px solid var(--dsw-alias-border-l2)}
.pgw-view__mark{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent);color:inherit;border-radius:3px;padding:0 2px}
.pgw-view__mark--agent{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#e0982e) 18%,transparent)}
`

const ID = 'dsh-privacy-gateway-styles'

export function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(ID)) return
  const el = document.createElement('style')
  el.id = ID
  el.textContent = CSS
  document.head.appendChild(el)
}
