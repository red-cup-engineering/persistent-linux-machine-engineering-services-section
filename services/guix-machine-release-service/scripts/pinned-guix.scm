;;; Reuse an installed Guix only when its complete authenticated channel
;;; identities equal the committed snapshot. Otherwise use time-machine.
(use-modules (guix channels) (gcrypt base16) (json) (ice-9 popen) (ice-9 format)
             (ice-9 textual-ports) (ice-9 match) (srfi srfi-1))
(define (fingerprint text)
  (string-downcase (string-filter (lambda (c) (not (char-whitespace? c))) text)))

;; A refusal must distinguish a describe failure from a channel mismatch.
;; Emit only fixed labels, counts, statuses and booleans, never commands, paths,
;; environment values, raw describe output or channel metadata.
(define (report-installed-channel-refusal expected actual status profile?)
  (define (result value) (if value "match" "mismatch"))
  (format (current-error-port)
          "installed-guix-check: selection=~a describe-exit=~a describe-signal=~a expected-count=~a actual-count=~a~%"
          (if profile? "home-profile" "path")
          (or (status:exit-val status) "none")
          (or (status:term-sig status) "none")
          (length expected) (length actual))
  (for-each
    (lambda (channel index)
      (let* ((found (find (lambda (entry)
                           (equal? (assoc-ref entry "name")
                                   (symbol->string (channel-name channel)))) actual))
             (intro (channel-introduction channel))
             (observed (and found (assoc-ref found "introduction")))
             (signer (and (list? observed) (assoc-ref observed "signer"))))
        (format (current-error-port)
                "installed-guix-channel: index=~a name=~a commit=~a url=~a introduction=~a introduction-commit=~a signer=~a~%"
                index
                (result found)
                (result (and found (equal? (channel-commit channel)
                                         (assoc-ref found "commit"))))
                (result (and found (equal? (channel-url channel)
                                         (assoc-ref found "url"))))
                (result (if intro (and observed #t) (not observed)))
                (result (if intro
                          (and (list? observed)
                            (equal? (channel-introduction-first-signed-commit intro)
                                    (assoc-ref observed "commit")))
                          (not observed)))
                (result (if intro
                          (and (string? signer)
                            (equal? (fingerprint
                                      (bytevector->base16-string
                                        (channel-introduction-first-commit-signer intro)))
                                    (fingerprint signer)))
                          (not observed))))))
    expected (iota (length expected))))

(match (cdr (command-line))
 ((channels . arguments)
  (let* ((installed-only? (and (pair? arguments)
                               (equal? (car arguments) "--require-installed")))
         (arguments (if installed-only? (cdr arguments) arguments))
         (expected (load (canonicalize-path channels)))
         (profile (string-append (getenv "HOME") "/.config/guix/current/bin/guix"))
         (command (if (file-exists? profile) profile "guix"))
         (port (open-pipe* OPEN_READ command "describe" "--format=json"))
         (body (get-string-all port))
         (status (close-pipe port))
         (actual (if (zero? status) (vector->list (json-string->scm body)) '()))
         (shell-root (and (pair? arguments) (equal? (car arguments) "shell")
           (string-append "/var/guix/profiles/per-user/" (passwd:name (getpwuid (getuid)))
             "/github-guix-environment-" (number->string (current-time)) "-" (number->string (getpid)))))
         (arguments (if shell-root
           (append (list "shell" "--rebuild-cache" (string-append "--root=" shell-root))
                   (cdr arguments)) arguments))
         (same? (and (zero? status) (= (length expected) (length actual))
           (every (lambda (channel)
             (let* ((found (find (lambda (r) (equal? (assoc-ref r "name") (symbol->string (channel-name channel)))) actual))
                    (intro (channel-introduction channel))
                    (observed (and found (assoc-ref found "introduction"))))
               (and found (equal? (channel-commit channel) (assoc-ref found "commit"))
                    (equal? (channel-url channel) (assoc-ref found "url"))
                    (if intro
                      (and observed
                        (equal? (channel-introduction-first-signed-commit intro) (assoc-ref observed "commit"))
                        (equal? (fingerprint (bytevector->base16-string (channel-introduction-first-commit-signer intro)))
                                (fingerprint (assoc-ref observed "signer"))))
                      (not observed))))) expected))))
    ;; The bounded tooling route may not bootstrap another Guix/channel before
    ;; its prerequisite gate. Ordinary existing callers retain time-machine.
    (when (and installed-only? (not same?))
      ;; The caller retains stderr's tail, so include the bounded diagnostic in
      ;; the final error rather than letting a backtrace displace it.
      (error "toolchain qualification requires the exact already-installed Guix channels"
        (call-with-output-string
          (lambda (port)
            (parameterize ((current-error-port port))
              (report-installed-channel-refusal expected actual status (file-exists? profile)))))))
    (when (file-exists? profile)
      (setenv "PATH" (string-append (dirname profile) ":" (or (getenv "PATH") ""))))
    ;; This invocation owns this root only while its shell child is running.
    ;; Release/profile/candidate roots belong to the native release writer.
    (dynamic-wind
      (lambda () #t)
      (lambda ()
        (unless (zero? (apply system* command (if same? arguments (append (list "time-machine" "-C" channels "--") arguments))))
          (error "pinned Guix invocation failed" arguments)))
      (lambda ()
        (when (and shell-root (false-if-exception (lstat shell-root)))
          (delete-file shell-root))))))
 (_ (error "usage: pinned-guix.scm CHANNELS ARGUMENTS...")))
