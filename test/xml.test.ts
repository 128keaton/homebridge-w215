import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {escapeXml, readBlocks, readTag, unescapeXml} from '../src/lib/xml.js';

describe('xml helpers', () => {
  it('reads a tag, including namespaced elements and whitespace', () => {
    assert.equal(readTag('<A xmlns="x"> hello </A>', 'A'), 'hello');
    assert.equal(readTag('<A>1</A><A>2</A>', 'A'), '1');
  });

  it('distinguishes empty from missing', () => {
    assert.equal(readTag('<A></A>', 'A'), '');
    assert.equal(readTag('<A/>', 'A'), '');
    assert.equal(readTag('<B>1</B>', 'A'), undefined);
  });

  it('does not match a tag that only shares a prefix', () => {
    assert.equal(readTag('<ModuleIDs>9</ModuleIDs>', 'ModuleID'), undefined);
  });

  it('reads repeated blocks', () => {
    assert.deepEqual(readBlocks('<S><A>1</A></S><S><A>2</A></S>', 'S'), ['<A>1</A>', '<A>2</A>']);
  });

  it('round-trips escaping', () => {
    const raw = 'a<b>&"c\'';
    assert.equal(escapeXml(raw), 'a&lt;b&gt;&amp;&quot;c&apos;');
    assert.equal(unescapeXml(escapeXml(raw)), raw);
  });
});
