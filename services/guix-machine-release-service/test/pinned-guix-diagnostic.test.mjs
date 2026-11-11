import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../scripts/pinned-guix.scm',import.meta.url),'utf8');
const diagnostic=source.slice(source.indexOf('(define (report-installed-channel-refusal '),source.indexOf('(match (cdr (command-line))'));

test('installed-channel diagnostic runs only inside the original fail-closed guard',()=>{
  assert.ok(diagnostic.length>0);
  assert.ok(source.includes('(when (and installed-only? (not same?))\n'));
  assert.ok(source.includes('(error "toolchain qualification requires the exact already-installed Guix channels"\n'
    +'        (call-with-output-string\n'
    +'          (lambda (port)\n'
    +'            (parameterize ((current-error-port port))\n'
    +'              (report-installed-channel-refusal expected actual status (file-exists? profile)))))))'));
  assert.equal(source.match(/\(report-installed-channel-refusal /gu)?.length,2);
  assert.ok(source.indexOf('(when (and installed-only? (not same?))')<source.indexOf('(dynamic-wind'));
  assert.doesNotMatch(diagnostic,/\b(?:open-pipe|system|primitive-fork|execl|load|eval|getenv|readlink|canonicalize-path)\b/u);
  assert.equal(source.match(/\(open-pipe\*/gu)?.length,1);
  assert.equal(source.match(/\(apply system\*/gu)?.length,1);
});

test('diagnostic preserves the original installed executable selection and exact comparison',()=>{
  assert.ok(source.includes('(profile (string-append (getenv "HOME") "/.config/guix/current/bin/guix"))\n'
    +'         (command (if (file-exists? profile) profile "guix"))\n'
    +'         (port (open-pipe* OPEN_READ command "describe" "--format=json"))'));
  const comparator=source.slice(source.indexOf('         (same? '),source.indexOf('    ;; The bounded tooling route'));
  assert.equal(comparator,[
    '         (same? (and (zero? status) (= (length expected) (length actual))',
    '           (every (lambda (channel)',
    '             (let* ((found (find (lambda (r) (equal? (assoc-ref r "name") (symbol->string (channel-name channel)))) actual))',
    '                    (intro (channel-introduction channel))',
    '                    (observed (and found (assoc-ref found "introduction"))))',
    '               (and found (equal? (channel-commit channel) (assoc-ref found "commit"))',
    '                    (equal? (channel-url channel) (assoc-ref found "url"))',
    '                    (if intro',
    '                      (and observed',
    '                        (equal? (channel-introduction-first-signed-commit intro) (assoc-ref observed "commit"))',
    '                        (equal? (fingerprint (bytevector->base16-string (channel-introduction-first-commit-signer intro)))',
    '                                (fingerprint (assoc-ref observed "signer"))))',
    '                      (not observed))))) expected))))',
    '',
  ].join('\n'));
  assert.ok(source.includes('(apply system* command (if same? arguments (append (list "time-machine" "-C" channels "--") arguments)))'));
});

test('diagnostic output vocabulary is bounded and excludes raw metadata or paths',()=>{
  assert.equal(diagnostic.match(/\(format \(current-error-port\)/gu)?.length,2);
  assert.match(diagnostic,/\(define \(result value\) \(if value "match" "mismatch"\)\)/u);
  assert.match(diagnostic,/\(if profile\? "home-profile" "path"\)/u);
  assert.match(diagnostic,/describe-exit=~a describe-signal=~a expected-count=~a actual-count=~a/u);
  assert.match(diagnostic,/index=~a name=~a commit=~a url=~a introduction=~a introduction-commit=~a signer=~a/u);
  assert.doesNotMatch(diagnostic,/\b(?:display|write|pretty-print|scm->json|backtrace)\b/u);
  assert.doesNotMatch(diagnostic,/~[sy]|\/home\/|\/gnu\/store\/|https?:\/\//u);
});
