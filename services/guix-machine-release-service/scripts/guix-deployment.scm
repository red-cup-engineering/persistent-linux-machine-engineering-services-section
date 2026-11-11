;;; Run with the pinned Guix: guix time-machine -C channels.scm -- repl -- FILE ARGS...
;;; stdout is one JSON reading; Guix's progress belongs on stderr.
(use-modules (ice-9 popen) (ice-9 rdelim) (ice-9 ftw)
             (ice-9 match) (ice-9 format) (json) (srfi srfi-1))

(define (run . arguments)
  (format (current-error-port) "Guix deployment: ~a~%" (car arguments))
  (let* ((port (apply open-pipe* OPEN_READ arguments))
         (lines (let loop ((result '()))
                  (let ((line (read-line port)))
                    (if (eof-object? line) (reverse result)
                        (loop (cons line result))))))
         (status (close-pipe port)))
    (unless (zero? status) (error "deployment command failed" arguments status))
    lines))

(define (guix channels . arguments)
  (apply run "guix" "repl" "--" (string-append (dirname (car (command-line))) "/pinned-guix.scm") channels arguments))

;; Runtime packages must be closed over their files. In particular, an
;; install seeded from another release must not retain links to that release.
(define (assert-closed source)
  (let* ((root (canonicalize-path source))
         (prefix (string-append root "/")))
    (file-system-fold
     (lambda (file stat result) #t)
     (lambda (file stat result)
       (when (eq? 'symlink (stat:type stat))
         (when (absolute-file-name? (readlink file))
           (error "runtime link is absolute and cannot relocate into the store" file))
         (let ((target (canonicalize-path file)))
           (unless (or (string=? target root) (string-prefix? prefix target))
             (error "runtime link escapes the admitted closure" file target))))
       result)
     (lambda (file stat result) result)
     (lambda (file stat result) result)
     (lambda (file stat result) result)
     (lambda (file stat errno result) (error "cannot read runtime input" file errno))
     #t root lstat)))

(define (build-result channels arguments root)
  (let* ((lines (apply guix channels "build" "--no-grafts"
                       (append arguments (list (string-append "--root=" root)))))
         (store (last lines)))
    (unless (and (string=? (dirname store) "/gnu/store")
                 (string=? store (canonicalize-path store)))
      (error "Guix returned no canonical store output" lines))
    `(("storePath" . ,store) ("root" . ,root)
      ("narSha256" . ,(last (guix channels "hash" "--serializer=nar" "--format=hex" store))))))

(define (verify-software store root expected-nar)
  ;; This reads the held output and hashes its NAR; it does not register a root.
  (unless (and (string=? (dirname store) "/gnu/store")
               (file-is-directory? store)
               (string=? store (canonicalize-path store))
               (string=? store (canonicalize-path root)))
    (error "software receipt differs from its immutable output or build root"))
  (let ((actual-nar (last (run "guix" "hash" "--serializer=nar" "--format=hex" store))))
    (unless (string=? actual-nar expected-nar)
      (error "software receipt NAR digest differs from its store output"))
    `(("storePath" . ,store) ("root" . ,root) ("narSha256" . ,actual-nar))))

(define result
  (match (cdr (command-line))
    (("verify" store root expected-nar)
     (verify-software store root expected-nar))
    (("build-shared" channels load-path source commit root)
     (unless (and (= (string-length commit) 40)
                  (every (lambda (char) (string-index "0123456789abcdef" char))
                         (string->list commit)))
       (error "shared software build needs its exact source commit"))
     (assert-closed source)
     ;; The expression is constructed from quoted data, never evaluated caller
     ;; source. Installation and dependency selection have already completed.
     (build-result channels
       (list "-L" load-path "-e"
             (format #f "(begin (use-modules (guix-deployment)) (node-runtime-release ~s ~s ~s))"
                     "shared-node-runtime" commit (canonicalize-path source))) root))
    (("build-target" envelope software-receipt root)
     (assert-closed envelope)
     (let* ((source (canonicalize-path envelope))
            (software (call-with-input-file software-receipt json->scm))
            (release (call-with-input-file (string-append source "/.metadata/release.json") json->scm))
            (store (assoc-ref software "storePath")))
       (for-each
         (lambda (key)
           (let ((value (assoc-ref software key)))
             (unless (and (string? value) (> (string-length value) 0)
                          (equal? value (assoc-ref (assoc-ref release "software") key)))
               (error "target envelope differs from the held software build receipt" key))))
         '("storePath" "root" "narSha256"))
       (let ((nar (assoc-ref software "narSha256")))
         (unless (and (= (string-length nar) 64)
                      (every (lambda (char) (string-index "0123456789abcdef" char))
                             (string->list nar)))
           (error "target envelope differs from the held software build receipt" "narSha256")))
       (verify-software store (assoc-ref software "root") (assoc-ref software "narSha256"))
       (setenv "GUIX_RUNTIME_RELEASE_STORE" store)
       (setenv "GUIX_RECEIVER_ENVELOPE" source)
       ;; Both the machine definition and the Guix module are the authenticated
       ;; target envelope's committed inputs, not a mutable caller override.
       (build-result (string-append source "/.controller/channels.scm")
         (list "-L" (string-append source "/.controller/src")
               "-f" (string-append source "/.controller/machine.scm")) root)))
    (("build" channels load-path definition source root)
     (assert-closed source)
     (setenv "GUIX_DEPLOYMENT_SOURCE" (canonicalize-path source))
     (let* ((lines (guix channels "build" "--no-grafts" "-L" load-path
                         "-f" definition (string-append "--root=" root)))
            (store (last lines)))
       (unless (string-prefix? "/gnu/store/" store)
         (error "Guix returned no store output" lines))
       `(("storePath" . ,store) ("root" . ,root)
         ("narSha256" . ,(last (guix channels "hash" "--serializer=nar" "--format=hex" store))))))
    (_ (error "usage: build CHANNELS LOAD-PATH DEFINITION SOURCE ROOT | build-shared CHANNELS LOAD-PATH SOURCE COMMIT ROOT | build-target ENVELOPE SOFTWARE-RECEIPT ROOT | verify STORE ROOT NAR"))))

(display (scm->json-string result))
(newline)
