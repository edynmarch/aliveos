import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseS,retrieve} from '../src/retrieve.mjs';
const entries=parseS(readFileSync(new URL('../sourcebooks/S.md',import.meta.url),'utf8'));
test('complete S index and reciprocal links',()=>{assert.equal(entries.length,1163);const ids=new Set(entries.map(e=>e.id));assert.equal(ids.size,1163);assert.equal(entries.filter(e=>e.id.startsWith('CA-')).length,33);const concepts=entries.filter(e=>e.id.startsWith('HG.SB.'));assert.equal(concepts.length,1130);assert.equal(concepts.reduce((n,e)=>n+e.related.length,0),900);assert.ok(concepts.every(e=>e.related.every(id=>ids.has(id))));});
for(const [question,id] of [['My boss keeps praising me for being reliable, but I am exhausted.','HG.SB.01.02.B010'],['I am always the one who messages first.','HG.SB.02.04.B007'],['They keep apologizing but nothing changes.','HG.SB.02.04.D002'],['HG.SB.01.02.A001','HG.SB.01.02.A001']])test('retrieve '+question,()=>assert.equal(retrieve(entries,question)[0].id,id));
test('neutral input does not retrieve sourcebook',()=>assert.deepEqual(retrieve(entries,'hello'),[]));
