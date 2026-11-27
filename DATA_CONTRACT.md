# Korea research dashboard data contract

Existing `data/*.json` files are retained as original historical inputs. New modules share these contracts. No API credential, account identifier, local path, raw upstream exception or HTML response belongs in published data.

## `data/dashboard.json`

`{schemaVersion:1, generatedAt:ISO8601, series:{[id]:Series}, catalog:CatalogEntry[], diagnostics:Diagnostic[]}`

Series: `{id,label,unit,frequency:'daily'|'monthly'|'quarterly',scope,definition,source:{name,url,access,license},points:Point[],asOf:string|null,collectedAt:string|null,lastAttemptAt:string|null,status:'current'|'delayed'|'missing'|'closed',expectedLagDays:number,error:string|null}`.

Point: `{date:'YYYY-MM-DD',value:number,availableAt:string|null,collectedAt:string|null}`. Missing values are omitted as observations and preserved as gaps in aligned charts; they are never zero-filled. Monthly/quarterly dates denote the reporting period end, not an invented release date. Source changes must use separate series IDs; never splice index/FX/yield definitions. Last-known observations survive source failure without refreshing their collection timestamps. Keep explicit source-specific publication-lag assumptions in the registry.

CatalogEntry: `{id,label,category,unit,definition,sourceUrl,access,license,frequency,available,status,limitation}`. Diagnostic: `{id,code,message,at}`. A missing requested series still has a catalog entry and an empty Series.

Stable IDs: `kospi`, `kosdaq`, `kospi200`, `kosdaq150`, `vkospi`, `usdkrw`, `eurkrw`, `jpykrw100`, `cnykrw`, `dxy`, `us2y`, `us10y`, `kr3y`, `kr10y`, `kr_cd91`, `kr_aa3y`, `kr_base_rate`, `kr_m2`, `kr_rp`, `kr_cds`, `deposit`, `credit_kospi`, `credit_kosdaq`, `cma`, `mmf`, `forced_sales`, `foreign_net`, `institution_net`, `individual_net`, `kospi_turnover`, `kosdaq_turnover`, `kospi_marketcap`, `kosdaq_marketcap`, `advancers`, `decliners`, `new_high52`, `new_low52`, `above_ma20`, `above_ma60`, `above_ma120`, `above_ma200`, `equal_weight`, `large_cap`, `small_cap`, `ttm_per`, `forward_per`, `pbr`, `dividend_yield`, `eps_revision`, `futures_price`, `futures_oi`, `futures_volume`, `futures_net_foreign`, `program_arb`, `program_nonarb`, `option_call_oi`, `option_put_oi`, `option_call_volume`, `option_put_volume`.

Index source alternatives use explicit IDs e.g. `kospi_naver`, `kospi_ecos`, `kospi_yahoo`. Frontend/analysis select one source history in its entirety and display its provenance. Combined KOSPI+KOSDAQ flows are labelled as combined; no KOSPI-only normalization without matching market capitalisation/turnover.

## `data/etf-changes.json`

`{schemaVersion:1,generatedAt,etfs:EtfRecord[],errors:[{id,code,message}]}`.

EtfRecord: `{id,ticker,name,issuer,sourceUrl,status,scope:'holdings-per-cu',latest:Snapshot|null,previous:Snapshot|null,comparison:Comparison|null}`.

Snapshot: `{date,collectedAt,complete,totalRows,holdings:Holding[]}`. Holding: `{code,name,quantity:number|null,weightPct:number|null,marketValue:number|null,assetType?:string}`.

Comparison: `{from,to,changes:Change[],counts:{entry,increase,decrease,exit,unchanged},note}`. Change: `{code,name,kind:'entry'|'increase'|'decrease'|'exit'|'unchanged',previousWeight:number|null,newWeight:number|null,deltaPp:number|null,quantityChange:number|null,priceEffectUnknown:true}`.

Compare the same fund, date definitions, units and complete holdings lists. An absent security implies zero only when both whole-portfolio snapshots are verified complete. Missing/partial files never generate entries or exits. Weight drift includes price effects and is not proof of trading. Quantities are per creation unit and are not total fund shares. Retain source snapshots by fund and observation date, with revision hashes, under `data/etf-history/`; raw responses are stored outside public hosting under `outputs/raw/` or private workflow artifacts.

## Browser analysis module

`lib/analytics.mjs` exports `DEFAULT_CONFIG`, `buildResearch(dashboard,config=DEFAULT_CONFIG,options={})`, `seriesPoints(dashboard,id)` and pure statistical helpers. `buildResearch` returns `{asOf,benchmark,features,scores,regime,previousRegime,contributors,diagnosis,backtest,correlations,notes}`. Each score contains `{value:number|null,coveragePct,used,total,contributors,reason}`. Feature metrics include `{id,label,value,unit,date,percentile,z,change5,change20,mean,sd,history}`. Backtest and diagnostic results identify reporting-lag assumptions and retrospective limitations. Scores are research indicators, not calibrated trading probabilities.

The frontend preserves a separate all-charts view containing every original chart. Public data collection never uses private KRX keys without redistribution authorization.
