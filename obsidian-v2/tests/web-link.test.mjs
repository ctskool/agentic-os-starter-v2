import test from 'node:test';import assert from 'node:assert/strict';
import {safeWebLink} from '../shared/web-link.mjs';
test('report links cannot invoke local files, script schemes or impersonated repository hosts',()=>{
 for(const input of ['file:///C:/Windows/calc.exe','javascript:alert(1)','data:text/html,test','obsidian://open','https://github.com@evil.example/repo','https://github.com.evil.example/repo','https://github.com\n.evil.example/repo'])assert.equal(safeWebLink(input,'github.com'),null,input);
 assert.equal(safeWebLink('https://github.com/ctskool/agentic-os-starter','github.com'),'https://github.com/ctskool/agentic-os-starter');
 assert.equal(safeWebLink('https://example.com/article?source=hn'), 'https://example.com/article?source=hn');
});
