;;; Pure diagnostic regression cases. This test does not load Guix modules,
;;; invoke pinned-guix's entrypoint, launch any command or realize any package.
(use-modules (ice-9 match) (ice-9 format) (srfi srfi-1) (srfi srfi-13))

;; Inert channel-shaped records stand in for Guix's record accessors. The
;; production diagnostic definitions themselves are read directly from source.
(define (channel-name channel) (assq-ref channel 'name))
(define (channel-commit channel) (assq-ref channel 'commit))
(define (channel-url channel) (assq-ref channel 'url))
(define (channel-introduction channel) (assq-ref channel 'introduction))
(define (channel-introduction-first-signed-commit intro) (assq-ref intro 'commit))
(define (channel-introduction-first-commit-signer intro) (assq-ref intro 'signer))
(define (bytevector->base16-string signer) signer)
(define selected '())
(call-with-input-file
  (string-append (dirname (car (command-line))) "/../scripts/pinned-guix.scm")
  (lambda (port)
    (let loop ((form (read port)))
      (unless (eof-object? form)
        (match form
          (('define (name . args) . body)
           (when (memq name '(fingerprint report-installed-channel-refusal))
             (eval form (current-module))
             (set! selected (cons name selected))))
          (_ #t))
        (loop (read port))))))
(unless (equal? (reverse selected) '(fingerprint report-installed-channel-refusal))
  (error "diagnostic definitions were not uniquely selected"))

(define expected
  '((name . guix)
    (commit . "private-commit-must-not-print")
    (url . "https://credentials-must-not-print.invalid/private")
    (introduction . ((commit . "private-introduction-must-not-print")
                     (signer . "aabbccdd")))))
(define observed
  '(("name" . "guix")
    ("commit" . "private-commit-must-not-print")
    ("url" . "https://credentials-must-not-print.invalid/private")
    ("introduction" . (("commit" . "private-introduction-must-not-print")
                        ("signer" . "AA BB CC DD")))))
(define checks 0)
(define (check condition label)
  (unless condition (error "diagnostic regression failed" label))
  (set! checks (+ checks 1)))
(define (report channels actual status profile?)
  (call-with-output-string
    (lambda (port)
      (parameterize ((current-error-port port))
        (report-installed-channel-refusal channels actual status profile?)))))
(define (contains output fragment label)
  (check (string-contains output fragment) label))
(define (replace-field fields key value)
  (map (lambda (pair) (if (equal? (car pair) key) (cons key value) pair)) fields))
(define (with-field key value)
  (report (list expected) (list (replace-field observed key value)) 0 #f))
(define (with-introduction-field key value)
  (with-field "introduction"
    (replace-field (assoc-ref observed "introduction") key value)))

(define identical (report (list expected) (list observed) 0 #f))
(contains identical "selection=path describe-exit=0 describe-signal=none expected-count=1 actual-count=1"
          'successful-describe)
(contains identical "name=match commit=match url=match introduction=match introduction-commit=match signer=match"
          'normalized-matching-identities)
(check (< (string-length identical) 1000) 'one-channel-error-tail-budget)
(contains (report (list expected) (list observed) 0 #t) "selection=home-profile"
          'home-profile-selection)
(contains (report (list expected) '() 256 #f) "describe-exit=1 describe-signal=none"
          'failed-describe-exit)
(contains (report (list expected) '() 15 #f) "describe-exit=none describe-signal=15"
          'signaled-describe)
(contains (report (list expected) '() 0 #f) "expected-count=1 actual-count=0"
          'empty-description)
(contains (report (list expected) (list observed observed) 0 #f) "expected-count=1 actual-count=2"
          'extra-channel-count)
(contains (with-field "name" "other-private-name") "name=mismatch commit=mismatch url=mismatch"
          'missing-channel)
(contains (with-field "commit" "wrong-private-commit") "name=match commit=mismatch url=match"
          'commit-mismatch)
(contains (with-field "url" "https://other-secret.invalid") "commit=match url=mismatch introduction=match"
          'url-mismatch)
(contains (with-field "introduction" #f) "introduction=mismatch introduction-commit=mismatch signer=mismatch"
          'missing-introduction)
(contains (with-introduction-field "commit" "other-private-introduction")
          "introduction=match introduction-commit=mismatch signer=match" 'introduction-commit-mismatch)
(contains (with-introduction-field "signer" "other-private-signer")
          "introduction-commit=match signer=mismatch" 'signer-mismatch)
(contains (with-introduction-field "signer" #f) "signer=mismatch" 'malformed-signer)
(contains (report (list (replace-field expected 'introduction #f))
                  (list (replace-field observed "introduction" #f)) 0 #f)
          "introduction=match introduction-commit=match signer=match" 'absent-introduction)
(contains (report (list (replace-field expected 'introduction #f)) (list observed) 0 #f)
          "introduction=mismatch introduction-commit=mismatch signer=mismatch" 'unexpected-introduction)
(for-each
  (lambda (output)
    (for-each (lambda (private) (check (not (string-contains output private)) 'sanitized-output))
              '("private" "credentials" "https://" "aabbccdd" "AA BB CC DD" "other-secret")))
  (list identical (with-field "url" "https://other-secret.invalid")
        (with-field "name" "other-private-name")
        (with-introduction-field "signer" "other-private-signer")))
(format #t "pinned Guix diagnostic pure checks: ~a passed~%" checks)
