// Live authorization belongs to the bridge. Windows also accepts mixed-case
// environment names, so stripping only the canonical spelling is insufficient.
export function withoutOpenAIKey(env){
 return Object.fromEntries(Object.entries(env).filter(([name])=>name.toUpperCase()!=='OPENAI_API_KEY'));
}
