/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls } from './update-data';
const read=(path:string)=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('Aberdeen configuration precedence: file < advanced < nonblank input < environment/alias',()=>{
  const c=resolveControls({CONCURRENCY:2,TICKERS:'CGUS'},{CONCURRENCY:3,TICKERS:'CGCP'},{CONCURRENCY:'4',TICKERS:''},{CAPITAL_GROUP_CONCURRENCY:'5',CONCURRENCY:'6'});
  expect(c.CONCURRENCY).toBe('5');expect(c.TICKERS).toBe('CGCP');
  expect(resolveControls({TICKERS:'CGUS'},{TICKERS:''},{TICKERS:''}).TICKERS).toBe('');
  expect(resolveControls({CONCURRENCY:2},{},{CONCURRENCY:''}).CONCURRENCY).toBe('2');
  expect(resolveControls({SKIP_YAHOO:true},{},{},{SKIP_YAHOO:'false'}).SKIP_YAHOO).toBe('false');
  expect(readConfig(resolveControls({MAX_RETRIES:0})).maxRetries).toBe(0);
});
test('safe resolver rejects unknown, invalid and environment-file injection values',()=>{
  for(const value of [{UNKNOWN:1},{SEC_UA:'x\nEVIL=yes'},{CONCURRENCY:0},{MAX_RETRIES:-1},{MAX_FETCHES:1.5},{HISTORY_RANGE:'oops'},{VERBOSE:'maybe'},{TICKERS:['CGUS']},null,[]])expect(()=>resolveControls(value)).toThrow();
  expect(()=>resolveControls({}, {SEC_UA:'x\rfoo'})).toThrow();
  expect(()=>resolveControls({}, {}, {}, {CAPITAL_GROUP_SEC_UA:'x\0bad'})).toThrow();
});
test('all canonical controls defaulted in tracked JSON, controls and README in sync',()=>{
  const file=JSON.parse(read('scripts/update-data.config.json'));
  expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
  const config=readConfig(resolveControls(file));expect(config.tickers).toEqual([]);expect(config.maxFetches).toBe(0);expect(config.requestSleep).toBe(3);
  const doc=read('README.md');for(const name of CONTROL_NAMES)expect(doc).toContain('`'+name+'`');
});
test('CI is pinned Aberdeen mechanism with exactly permitted adaptations',()=>{
  const ref=read('evidence/config-reference/update-data.yml');
  const expected=ref.replaceAll('abrdn','Capital Group').replaceAll('api/aberdeen','api/capital-group').replaceAll('Rows per market-price history JSON page','Rows per official NAV / fallback market-price history JSON page').replaceAll('bun test scripts/update-data.test.ts','bun test')
    // Explicit user concurrency amendment changes descriptions only, not the Aberdeen mechanism.
    .replaceAll('Seconds between request starts including retries; conservative shared gate','Seconds between request starts per worker, including retries and issuer redirects')
    .replaceAll('Parallel fund workers; request starts remain conservatively paced','Independent parallel fund workers, each with its own request pacing');
  const actual=read('.github/workflows/update-data.yml');expect(actual).toBe(expected);
  const names=[...actual.slice(actual.indexOf('    inputs:'),actual.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map(m=>m[1]);
  expect(names.length).toBe(25);expect(names).toContain('advanced');
  for(const name of names.filter(n=>n!=='advanced'))expect(CONTROL_NAMES).toContain(name.toUpperCase());
  expect(actual).toContain("cron: '0 0 * * 0'");expect(actual).not.toMatch(/^  push:/m);
  expect(actual).not.toContain('bunx tsc');expect(actual).toContain('toJSON(inputs)');
});
function headings(text:string):string[]{
  let fence=false;return text.split('\n').filter(line=>{if(/^```/.test(line)){fence=!fence;return false;}return !fence && /^#{1,6} /.test(line);});
}
test('README common heading hierarchy, intro and commands match pinned JPMorgan',()=>{
  const ref=read('evidence/README.reference.md'), doc=read('README.md');
  expect(headings(doc)).toEqual(headings(ref).map(line=>line.replaceAll('JPMorgan','Capital Group')));
  const start=ref.slice(ref.indexOf('One of'),ref.indexOf('A single-file')).replaceAll('JPMorgan','Capital Group');expect(doc).toContain(start);
  const ts=ref.slice(ref.indexOf('## TypeScript'),ref.indexOf('## Brands table'));expect(doc).toContain(ts);
  expect(doc).toContain('bunx degit daggerok/Capital-Group#main ./12345 && cd $_');
  expect(doc).toContain('bunx serve . -p 1234');expect(doc).toContain('Deployment is pending');
  for(const section of ['## Brands table','## Sibling applications']){
    const block=doc.split(section)[1].split('\n## ')[0];
    const rows=block.split('\n').filter(l=>l.startsWith('| ')&&!l.startsWith('| ---')).slice(1);
    expect(rows.length).toBe(18);const brands=rows.map(l=>l.split('|')[1].replaceAll('*','').trim());
    expect(brands).toEqual([...brands].sort((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(brands.filter(n=>n==='Capital Group').length).toBe(1);
  }
});
