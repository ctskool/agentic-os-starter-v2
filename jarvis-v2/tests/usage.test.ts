import test from 'node:test';import assert from 'node:assert/strict';
import {claudeWindows,codexWindows,windowLabel} from '../lib/usage';
test('account usage uses the general bucket and actual window duration',()=>{
 const weekly={usedPercent:38,windowDurationMins:10080,resetsAt:1789497901};
 assert.deepEqual(codexWindows({rateLimitsByLimitId:{codex:{primary:weekly},codex_bengalfox:{primary:{usedPercent:0,windowDurationMins:300}}}}),[weekly]);
 assert.equal(windowLabel(weekly.windowDurationMins),'Weekly window');assert.equal(windowLabel(300),'5h window');
 assert.deepEqual(codexWindows({rateLimitsByLimitId:{codex_bengalfox:{primary:weekly}},rateLimits:{primary:weekly}}),[]);
 assert.deepEqual(codexWindows({rateLimits:{limitId:'codex',primary:weekly}}),[weekly]);
});
test('Claude account percentages are not fractions and keep independent reset times',()=>{
 assert.deepEqual(claudeWindows({five_hour:{utilization:2,resets_at:'2026-09-11T13:00:00-05:00'},seven_day:{utilization:0,resets_at:null}}),[
  {usedPercent:2,windowDurationMins:300,resetsAt:Date.parse('2026-09-11T18:00:00Z')/1000},
  {usedPercent:0,windowDurationMins:10080,resetsAt:null},
 ]);
 assert.deepEqual(claudeWindows({five_hour:{utilization:null},seven_day:{utilization:'2'}}),[]);
 assert.deepEqual(claudeWindows({five_hour:{utilization:NaN},seven_day:{utilization:200},seven_day_sonnet:{utilization:5}}),[]);
});
test('missing quota values stay unavailable; zero percent remains valid',()=>{
 assert.deepEqual(codexWindows({rateLimits:{primary:{usedPercent:null,windowDurationMins:300}}}),[]);
 assert.deepEqual(codexWindows({rateLimits:{primary:{usedPercent:0,windowDurationMins:300}}}),[{usedPercent:0,windowDurationMins:300,resetsAt:null}]);
 assert.deepEqual(codexWindows({rateLimits:{limitId:'spark',primary:{usedPercent:0,windowDurationMins:300}}}),[]);
});
