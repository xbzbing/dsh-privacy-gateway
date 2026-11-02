/**
 * The card's CSS, injected once; colours through the theme's --dsw-alias-*
 * tokens only, and code in the theme's own code font (--ds-font-family-code,
 * which dsh-client-ui-theme defines and the shell's markdown uses).
 */
const MONO = 'var(--ds-font-family-code,ui-monospace,monospace)'

const CSS = `
.pgw-card{display:flex;flex-direction:column;gap:16px;padding:16px 20px 20px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font-size:13px}
.pgw-card--panel{box-sizing:border-box;width:min(calc(100% - 32px),var(--dsh-chat-content-width,920px));margin:0 auto;border:none;border-radius:0;background:transparent;padding:12px 0 20px}
.pgw-session{display:inline-flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
.pgw-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pgw-head__main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.pgw-head__actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-left:auto}
.pgw-head__actions>:first-child{margin-right:8px}
.pgw-title{font-size:15px;font-weight:600;line-height:22px;margin:0}
.pgw-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pgw-spacer{flex:1}
.pgw-mono{font-family:${MONO}}
.pgw-reset{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary)}
@media (hover:hover){.pgw-reset:hover:not(:disabled){color:var(--dsw-alias-state-error-primary)}}
.pgw-empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.pgw-empty--block{padding:24px 0;text-align:center}
.pgw-flash{font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}
.pgw-flash--error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.pgw-notices{display:flex;flex-direction:column;gap:6px}
.pgw-notice{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:18px;padding:8px 12px;border-radius:8px;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.pgw-notice--error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.pgw-notice__icon{flex:none;margin-top:2px;color:var(--dsw-alias-state-warn-primary)}
.pgw-notice--error .pgw-notice__icon{color:var(--dsw-alias-state-error-primary)}
.pgw-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.pgw-kpi{display:flex;flex-direction:column;gap:2px;padding:12px 16px;box-shadow:-.5px 0 0 var(--dsw-alias-border-l2)}
.pgw-kpi__label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.pgw-kpi__value{font-size:22px;line-height:30px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.pgw-kpi__sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pgw-kpi--warn .pgw-kpi__value{color:var(--dsw-alias-state-warn-primary)}
.pgw-kpi--error .pgw-kpi__value{color:var(--dsw-alias-state-error-primary)}
.pgw-dists{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.pgw-dist{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;min-width:0}
.pgw-section{display:flex;flex-direction:column;gap:8px}
.pgw-section__head{display:flex;align-items:baseline;gap:8px}
.pgw-section__title,.pgw-dist__title{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}
.pgw-bar{display:flex;flex-direction:column;gap:4px;font-size:12px}
.pgw-bar__head{display:flex;justify-content:space-between;gap:8px}
.pgw-bar__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:${MONO};color:var(--dsw-alias-label-primary)}
.pgw-bar__value{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.pgw-bar__track{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.pgw-bar__fill{height:100%;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
.pgw-recs{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}
.pgw-recs__list{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.pgw-recs__item{display:flex;flex-direction:column}
.pgw-rec{box-sizing:border-box;display:grid;grid-template-columns:16px 76px 56px minmax(0,200px) minmax(0,1fr) 64px 64px;gap:8px;align-items:center;width:100%;min-height:40px;padding:6px 12px;font:inherit;font-size:12px;text-align:left;background:none;border:none;border-top:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);cursor:pointer}
.pgw-rec--head{min-height:30px;border-top:none;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-weight:500;cursor:default}
@media (hover:hover){.pgw-rec:not(.pgw-rec--head):hover{background:var(--dsw-alias-interactive-bg-hover)}}
.pgw-rec--open{background:var(--dsw-alias-bg-layer-2)}
.pgw-rec--zero{color:var(--dsw-alias-label-tertiary)}
.pgw-rec__chevron{color:var(--dsw-alias-label-tertiary);transition:transform .15s}
.pgw-rec--open .pgw-rec__chevron{transform:rotate(90deg)}
.pgw-rec__time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.pgw-rec__step{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pgw-rec__where{display:flex;flex-direction:column;min-width:0;line-height:16px}
.pgw-rec__model,.pgw-rec__host,.pgw-rec__from{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pgw-rec__host{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.pgw-rec__from{color:var(--dsw-alias-label-secondary)}
.pgw-rec__num{min-width:0;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pgw-rec__dim{color:var(--dsw-alias-label-secondary)}
.pgw-rec__bad{color:var(--dsw-alias-state-error-primary);font-weight:600}
.pgw-detail{display:flex;flex-direction:column;gap:8px;padding:8px 12px 12px 36px;background:var(--dsw-alias-bg-layer-2);font-size:12px;overflow-x:auto;border-top:.5px solid var(--dsw-alias-border-l1)}
.pgw-values{border-collapse:collapse;width:100%}
.pgw-values th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:4px 12px 4px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}
.pgw-values td{padding:4px 12px 4px 0;white-space:nowrap;font-variant-numeric:tabular-nums}
.pgw-values__ctx td{padding:0 12px 8px 0;white-space:normal}
.pgw-values__ctx td>*{vertical-align:middle}
.pgw-ctx{display:flex;flex-direction:column;gap:2px}
.pgw-ctx__line{display:flex;flex-wrap:wrap;align-items:baseline}
.pgw-ctx__place{margin-right:6px;font-size:11px}
.pgw-ctx__path{margin-left:4px;font-size:11px;opacity:.7}
.pgw-ctx__more{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.pgw-ctx__text{flex:1 1 auto;min-width:0;font-size:12px;line-height:18px;letter-spacing:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.pgw-ctx__mark{margin:0 1px;padding:0 2px;font-size:11px;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);color:var(--dsw-alias-label-primary)}
.pgw-pager{display:flex;align-items:center;justify-content:flex-end;gap:2px}
.pgw-pager__at{min-width:56px;text-align:center;font-variant-numeric:tabular-nums}
@media (max-width:640px){.pgw-rec{grid-template-columns:16px 64px minmax(0,1fr) 56px 56px}.pgw-rec__from,.pgw-rec__step{display:none}.pgw-rec--head>:nth-child(3),.pgw-rec--head>:nth-child(5){display:none}}
.pgw-cfg{display:flex;flex-direction:column;gap:12px;container-type:inline-size}
.pgw-cfg__folds{display:flex;flex-direction:column;gap:8px}
.pgw-fold{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg)}
.pgw-fold__heading{margin:0;font:inherit}
.pgw-fold__head{display:flex;align-items:center;gap:8px;width:100%;min-height:48px;padding:0 16px;border:0;border-radius:var(--dsw-radius-lg);background:none;font:inherit;text-align:start;color:var(--dsw-alias-label-primary);cursor:pointer}
.pgw-fold[data-open] .pgw-fold__head{border-end-start-radius:0;border-end-end-radius:0}
@media (hover:hover){.pgw-fold__head:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.pgw-fold__head:focus-visible{outline:2px solid var(--dsw-alias-border-focus,currentColor);outline-offset:-2px}
.pgw-fold__chevron{flex:none;color:var(--dsw-alias-label-tertiary);transform:rotate(-90deg);transition:transform .15s ease}
.pgw-fold[data-open] .pgw-fold__chevron{transform:none}
@media (prefers-reduced-motion:reduce){.pgw-fold__chevron{transition:none}}
.pgw-fold__title{flex:none;font-size:14px;font-weight:500;line-height:22px}
.pgw-fold__summary{flex:0 1 auto;min-width:0;margin-inline-start:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pgw-fold__part+.pgw-fold__part::before{content:"·";margin:0 6px;color:var(--dsw-alias-label-tertiary)}
.pgw-fold__part--off{color:var(--dsw-alias-state-warn-label)}
.pgw-fold__part--error{color:var(--dsw-alias-state-error-primary)}
.pgw-fold__body{padding:0 16px;border-top:.5px solid var(--dsw-alias-border-l2);overflow:hidden}
.pgw-fold__grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);column-gap:32px;margin-bottom:-1px}
@container (max-width:600px){.pgw-fold__grid{grid-template-columns:minmax(0,1fr)}}
.pgw-cfg__row{grid-column:1/-1;display:flex;flex-direction:column;align-items:stretch;gap:10px;min-width:0;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.pgw-cfg__row--half{grid-column:auto}
@container (max-width:600px){.pgw-cfg__row--half{grid-column:1/-1}}
.pgw-cfg__row--inline{flex-direction:row;align-items:center;justify-content:space-between;gap:24px}
.pgw-cfg__text{display:flex;flex:1 1 auto;flex-direction:column;gap:4px;min-width:0}
.pgw-cfg__name{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:20px}
.pgw-cfg__desc{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px}
.pgw-cfg__foot{margin:0;color:var(--dsw-alias-label-tertiary)}
.pgw-cfg__desc--error{color:var(--dsw-alias-state-error-primary)}
.pgw-cfg__control{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%}
.pgw-cfg__row--inline .pgw-cfg__control{flex:none}
.pgw-select{display:inline-flex;align-items:center;gap:12px;height:36px;max-width:100%;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}
@media (hover:hover){.pgw-select:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.pgw-select:disabled{cursor:default;opacity:.6}
.pgw-select__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pgw-select__chevron{flex:none}
.pgw-cfg__list{display:flex;flex-direction:column;gap:8px;min-width:0;width:100%}
.pgw-cfg__add{display:flex;align-items:center;gap:8px;max-width:420px}
.pgw-cfg__input{flex:1 1 auto;min-width:0;width:240px}
.pgw-cfg__input--count{flex:none;width:96px}
.pgw-cfg__tags{display:flex;flex-wrap:wrap;gap:6px}
.pgw-cfg__tag{display:inline-flex;align-items:center;gap:4px;max-width:240px}
.pgw-cfg__tagText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pgw-cfg__tagX{display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;background:none;color:inherit;cursor:pointer;opacity:.6}
.pgw-cfg__tagX:hover:not(:disabled){opacity:1}
.pgw-cfg__tagX:disabled{opacity:.3;cursor:default}
.pgw-view{display:flex;flex-direction:column;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2)}
.pgw-view__scroll{max-height:420px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent)}
.pgw-view__table{border-collapse:collapse;width:100%;table-layout:fixed}
.pgw-view__table th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);font-weight:500;color:var(--dsw-alias-label-tertiary);text-align:left;padding:4px 8px}
.pgw-view__table th:first-child,.pgw-view__n{width:44px}
.pgw-view__n{color:var(--dsw-alias-label-tertiary);text-align:right;font-variant-numeric:tabular-nums;padding:2px 8px;vertical-align:top}
.pgw-detail .pgw-view__code{font-family:${MONO};white-space:pre-wrap;word-break:break-all;padding:2px 8px;vertical-align:top;border-left:1px solid var(--dsw-alias-border-l2)}
.pgw-view__mark{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent);color:inherit;border-radius:3px;padding:0 2px}
.pgw-view__mark--agent{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent)}
`

const ID = 'dsh-privacy-gateway-styles'

export function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(ID)) return
  const el = document.createElement('style')
  el.id = ID
  el.textContent = CSS
  document.head.appendChild(el)
}
