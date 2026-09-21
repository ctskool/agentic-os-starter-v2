export interface UsageWindow {usedPercent:number;windowDurationMins:number;resetsAt:number|null}
export interface CodexUsage {status:'ok'|'stale'|'unavailable';checkedAt:string|null;windows:UsageWindow[];message?:string}
