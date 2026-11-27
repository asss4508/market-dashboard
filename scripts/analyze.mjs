import {readFile,writeFile,rename} from 'node:fs/promises';
import {buildResearch} from '../lib/analytics.mjs';

const directory=new URL('../data/',import.meta.url);
const dashboard=JSON.parse(await readFile(new URL('dashboard.json',directory),'utf8'));
const research=buildResearch(dashboard,undefined,{includeHistory:false});
const target=new URL('research.json',directory), temporary=new URL('research.'+process.pid+'.tmp',directory);
await writeFile(temporary,JSON.stringify({schemaVersion:1,generatedAt:dashboard.generatedAt,...research})+'\n');
await rename(temporary,target);
console.log('시장 연구 기준일',research.asOf??'자료 없음','·',research.conclusion.headline);
