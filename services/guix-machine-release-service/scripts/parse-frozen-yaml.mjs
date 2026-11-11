#!/usr/bin/env node
// Data-only adapter over the exact already-inspected YAML provider; no ambient module lookup.
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isCliEntry} from './cli-entry.mjs';

if(isCliEntry(import.meta.url)){
  const provider=process.argv[2];
  if(process.argv.length!==3||!isAbsolute(provider))throw new Error('expected one absolute YAML API path');
  const {parseAllDocuments}=await import(pathToFileURL(provider).href);
  const docs=parseAllDocuments(readFileSync(0,'utf8'),{strict:true});
  if(docs.length!==1)throw new Error('expected exactly one YAML document');
  if(docs[0].errors.length)throw docs[0].errors[0];
  for(const warning of docs[0].warnings)console.error(warning);
  process.stdout.write(JSON.stringify(docs[0]));
}
