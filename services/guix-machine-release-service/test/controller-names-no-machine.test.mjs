import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

// The controller serves any machine: the machine's repository is read from its machine.json or given as an argument,
// and the only repository the controller names is its own (CONTROLLER_REPOSITORY).
const MACHINE_NAMES=/cold-red-gate|cold red gate|koios-news-(?:content|data|site)|causeway-services\/koios|@causeway-services\/koios|publicationInputs|koios-publication-input/iu;

test('the controller\'s code names no machine and none of a machine\'s repositories',()=>{
  const offences=[];
  for(const directory of ['scripts','src','session']){
    for(const name of readdirSync(directory,{recursive:true}).map(String)){
      let text;try{text=readFileSync(join(directory,name),'utf8');}catch{continue;}
      text.split('\n').forEach((line,index)=>{if(MACHINE_NAMES.test(line))offences.push(`${directory}/${name}:${index+1}`);});
    }
  }
  assert.deepEqual(offences,[]);
});
