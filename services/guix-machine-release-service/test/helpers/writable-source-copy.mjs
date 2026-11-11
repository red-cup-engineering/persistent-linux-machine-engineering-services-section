import {cpSync,chmodSync,lstatSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

/** Test-only mutable copy. The caller supplies its own private temporary
 * directory. Never chmod the admitted source or follow copied symlinks. */
export function copyWritableSource(source,destination){
  cpSync(source,destination,{recursive:true});
  const prepare=path=>{
    const status=lstatSync(path);
    if(status.isSymbolicLink())return;
    if(!status.isDirectory()&&!status.isFile())throw new Error('unexpected test fixture file type');
    chmodSync(path,status.mode|(status.isDirectory()?0o700:0o200));
    if(status.isDirectory())for(const name of readdirSync(path))prepare(join(path,name));
  };
  prepare(destination);
}
